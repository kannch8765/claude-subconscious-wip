import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
let tempRoots: string[] = [];

vi.stubGlobal('fetch', fetchMock);

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-conversation-test-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createConversation', () => {
  it('uses trailing-slash conversations endpoint with agent_id query', async () => {
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'conversation-123' }),
    });

    const { createConversation } = await import('./conversation_utils.js');
    const conversationId = await createConversation('test-key', 'agent-123');

    expect(conversationId).toBe('conversation-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://letta.example.com/v1/conversations/?agent_id=agent-123',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });
});

describe('live retryable conversation recovery', () => {
  it('marks a poisoned conversation without modifying the durable transcript cursor state', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      markConversationForRetryRotation,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    const state = { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' };
    saveSyncState(cwd, state);
    const statePath = path.join(home, '.letta', 'claude', `session-${sessionId}.json`);
    const before = fs.readFileSync(statePath, 'utf8');

    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 20)).toBe(true);
    const firstMarker = JSON.parse(fs.readFileSync(getConversationRetryMarkerFile(cwd, sessionId), 'utf8'));
    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 25)).toBe(true);

    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(getConversationRetryMarkerFile(cwd, sessionId), 'utf8'))).toMatchObject({
      conversationId: 'conv-old',
      throughIndex: 25,
      markedAt: firstMarker.markedAt,
    });
  });

  it('keeps a fresh retry marker on the same conversation during the overlap grace window', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      getOrCreateConversation,
      loadSyncState,
      markConversationForRetryRotation,
      saveConversationsMap,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' });
    saveConversationsMap(cwd, { [sessionId]: { conversationId: 'conv-old', agentId: 'agent-1' } });
    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 20)).toBe(true);

    const state = loadSyncState(cwd, sessionId);
    const conversationId = await getOrCreateConversation('test-key', 'agent-1', sessionId, cwd, state);

    expect(conversationId).toBe('conv-old');
    expect(state.lastProcessedIndex).toBe(10);
    expect(fs.existsSync(getConversationRetryMarkerFile(cwd, sessionId))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates before replaying a held cursor and durably preserves lastProcessedIndex', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'conv-new', agent_id: 'agent-1' }),
    });

    const {
      getConversationRetryMarkerFile,
      getConversationsFile,
      getOrCreateConversation,
      getSyncStateFile,
      loadSyncState,
      markConversationForRetryRotation,
      saveConversationsMap,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' });
    saveConversationsMap(cwd, { [sessionId]: { conversationId: 'conv-old', agentId: 'agent-1' } });
    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 20)).toBe(true);
    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.markedAt = new Date(0).toISOString();
    fs.writeFileSync(markerPath, JSON.stringify(marker));

    const state = loadSyncState(cwd, sessionId);
    const conversationId = await getOrCreateConversation('test-key', 'agent-1', sessionId, cwd, state);

    expect(conversationId).toBe('conv-new');
    expect(state.lastProcessedIndex).toBe(10);
    expect(state.conversationId).toBe('conv-new');
    expect(JSON.parse(fs.readFileSync(getSyncStateFile(cwd, sessionId), 'utf8'))).toMatchObject({
      lastProcessedIndex: 10,
      sessionId,
      conversationId: 'conv-new',
    });
    expect(JSON.parse(fs.readFileSync(getConversationsFile(cwd), 'utf8'))[sessionId]).toEqual({
      conversationId: 'conv-new',
      agentId: 'agent-1',
    });
    expect(fs.existsSync(getConversationRetryMarkerFile(cwd, sessionId))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops an obsolete retry marker when a later successful worker already advanced the cursor', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      getOrCreateConversation,
      loadSyncState,
      saveConversationsMap,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 25, sessionId, conversationId: 'conv-old' });
    saveConversationsMap(cwd, { [sessionId]: { conversationId: 'conv-old', agentId: 'agent-1' } });
    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    fs.writeFileSync(markerPath, JSON.stringify({ conversationId: 'conv-old', throughIndex: 20, markedAt: new Date().toISOString() }));

    const state = loadSyncState(cwd, sessionId);
    const conversationId = await getOrCreateConversation('test-key', 'agent-1', sessionId, cwd, state);

    expect(conversationId).toBe('conv-old');
    expect(state.lastProcessedIndex).toBe(25);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adopts an already-rotated map entry instead of creating a second recovery conversation', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      getOrCreateConversation,
      getSyncStateFile,
      loadSyncState,
      saveConversationsMap,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' });
    saveConversationsMap(cwd, { [sessionId]: { conversationId: 'conv-recovered', agentId: 'agent-1' } });
    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    fs.writeFileSync(markerPath, JSON.stringify({ conversationId: 'conv-old', throughIndex: 20, markedAt: new Date().toISOString() }));

    const state = loadSyncState(cwd, sessionId);
    const conversationId = await getOrCreateConversation('test-key', 'agent-1', sessionId, cwd, state);

    expect(conversationId).toBe('conv-recovered');
    expect(state.lastProcessedIndex).toBe(10);
    expect(JSON.parse(fs.readFileSync(getSyncStateFile(cwd, sessionId), 'utf8'))).toMatchObject({
      lastProcessedIndex: 10,
      conversationId: 'conv-recovered',
    });
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
