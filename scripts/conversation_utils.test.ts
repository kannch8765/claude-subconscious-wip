import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
let tempRoots: string[] = [];

vi.stubGlobal('fetch', fetchMock);

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-conversation-test-'));
  tempRoots.push(dir);
  return dir;
}


function compileConversationUtilsForChild(home: string): string {
  const outDir = path.join(home, 'compiled-marker-worker');
  fs.mkdirSync(outDir, { recursive: true });
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  for (const name of ['letta_api_url.ts', 'conversation_utils.ts']) {
    const source = fs.readFileSync(path.resolve('scripts', name), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: options, fileName: name }).outputText;
    fs.writeFileSync(path.join(outDir, name.replace(/\.ts$/, '.js')), output, 'utf8');
  }
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  return pathToFileURL(path.join(outDir, 'conversation_utils.js')).href;
}

function runMarkerChild(moduleUrl: string, home: string, cwd: string, sessionId: string, conversationId: string, throughIndex: number): Promise<void> {
  const code = `import(${JSON.stringify(moduleUrl)}).then(({ markConversationForRetryRotation }) => {\n`
    + `  const ok = markConversationForRetryRotation(${JSON.stringify(cwd)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(conversationId)}, ${throughIndex});\n`
    + `  if (!ok) process.exitCode = 2;\n`
    + `}).catch((error) => { console.error(error); process.exitCode = 1; });`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', code], {
      cwd: process.cwd(),
      env: { ...process.env, LETTA_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`marker child exited ${code} signal=${signal}: ${stderr}`));
    });
  });
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
  it('marks a poisoned conversation without modifying the durable transcript cursor state or resetting its first-failure age', async () => {
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
    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    const firstMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    firstMarker.markedAt = new Date(0).toISOString();
    fs.writeFileSync(markerPath, JSON.stringify(firstMarker));

    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 25)).toBe(true);

    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({
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

  it('preserves concurrent cursor progress while an aged rotation waits on conversation creation', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');

    let releaseCreate!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      releaseCreate = () => resolve({
        ok: true,
        json: async () => ({ id: 'conv-new', agent_id: 'agent-1' }),
      });
    }));

    const {
      advanceSyncStateCursor,
      getConversationRetryMarkerFile,
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
    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 30)).toBe(true);
    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.markedAt = new Date(0).toISOString();
    fs.writeFileSync(markerPath, JSON.stringify(marker));

    const state = loadSyncState(cwd, sessionId);
    const pendingRotation = getOrCreateConversation('test-key', 'agent-1', sessionId, cwd, state);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const advanced = advanceSyncStateCursor(cwd, sessionId, 20);
    expect(advanced.lastProcessedIndex).toBe(20);
    releaseCreate();

    const conversationId = await pendingRotation;
    expect(conversationId).toBe('conv-new');
    expect(state.lastProcessedIndex).toBe(20);
    expect(state.conversationId).toBe('conv-new');
    expect(JSON.parse(fs.readFileSync(getSyncStateFile(cwd, sessionId), 'utf8'))).toMatchObject({
      lastProcessedIndex: 20,
      conversationId: 'conv-new',
    });
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('fails closed while mkdir ownership is published before owner metadata', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      getSyncStateLockFile,
      getSyncStateLockOwnerFile,
      markConversationForRetryRotation,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' });
    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 15)).toBe(true);

    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    const lockPath = getSyncStateLockFile(cwd, sessionId);
    const ownerPath = getSyncStateLockOwnerFile(cwd, sessionId);
    fs.mkdirSync(lockPath, { mode: 0o700 }); // A owns the lock; metadata is intentionally unpublished.

    const moduleUrl = compileConversationUtilsForChild(home);
    let settled = false;
    let contenderError: unknown = null;
    const contender = runMarkerChild(moduleUrl, home, cwd, sessionId, 'conv-old', 30).then(
      () => { settled = true; },
      (error) => { settled = true; contenderError = error; },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).throughIndex).toBe(15);

    fs.writeFileSync(ownerPath, JSON.stringify({
      pid: process.pid,
      token: 'publication-owner',
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    await contender;
    if (contenderError) throw contenderError;

    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).throughIndex).toBe(30);
  }, 10_000);

  it('reaps an abandoned unpublished lock only after it is stale', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      getSyncStateLockFile,
      markConversationForRetryRotation,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' });

    const lockPath = getSyncStateLockFile(cwd, sessionId);
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 20)).toBe(true);
    expect(JSON.parse(fs.readFileSync(getConversationRetryMarkerFile(cwd, sessionId), 'utf8')).throughIndex).toBe(20);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.reaper`)).toBe(false);
  });

  it('merges concurrent retry markers as earliest markedAt plus maximum throughIndex', async () => {
    const home = tempHome();
    vi.stubEnv('LETTA_HOME', home);

    const {
      getConversationRetryMarkerFile,
      getSyncStateLockFile,
      markConversationForRetryRotation,
      saveSyncState,
    } = await import('./conversation_utils.js');

    const cwd = '/workspace';
    const sessionId = 'session-1';
    saveSyncState(cwd, { lastProcessedIndex: 10, sessionId, conversationId: 'conv-old' });
    expect(markConversationForRetryRotation(cwd, sessionId, 'conv-old', 15)).toBe(true);

    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    const earliest = new Date(0).toISOString();
    const seed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    seed.markedAt = earliest;
    fs.writeFileSync(markerPath, JSON.stringify(seed));

    const lockPath = getSyncStateLockFile(cwd, sessionId);
    const ownerPath = path.join(lockPath, 'owner.json');
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: 'parent-gate', createdAt: new Date().toISOString() }), { mode: 0o600 });
    const moduleUrl = compileConversationUtilsForChild(home);
    const low = runMarkerChild(moduleUrl, home, cwd, sessionId, 'conv-old', 20);
    const high = runMarkerChild(moduleUrl, home, cwd, sessionId, 'conv-old', 30);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    await Promise.all([low, high]);

    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({
      conversationId: 'conv-old',
      throughIndex: 30,
      markedAt: earliest,
    });
  }, 10_000);

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
