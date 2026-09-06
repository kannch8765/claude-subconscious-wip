import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import {
  SUBCONSCIOUS_ADMIN_MEMORIES_PATH,
  SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH,
  createSubconsciousAdminHttpHandler,
  type EffectiveMemoryAdminRow,
  type SubconsciousAdminHttpReadModel,
  type SubconsciousAdminSnapshot,
} from '../src/index.js';

const baseUrl = 'http://localhost';

function snapshotFixture(): SubconsciousAdminSnapshot {
  return {
    agentId: 'agent-a',
    runtime: {
      availability: 'available',
      overview: {
        agentId: 'agent-a',
        agentName: 'Subconscious',
        activity: 'idle',
        observedAt: '2026-08-08T13:10:00Z',
        activeRunIds: [],
        providerUsage: {
          quality: 'provider_reported',
          source: 'provider-fixture',
          observedAt: '2026-08-08T13:10:00Z',
          remaining: 42,
          limit: 100,
          unit: 'requests',
        },
      },
    },
    recentRuns: { availability: 'available', items: [] },
    promptCache: { availability: 'available', conversations: [] },
    relationshipMemory: {
      availability: 'available',
      summary: {
        genesisMemoryCount: 1,
        effectiveMemoryCount: 1,
        activeMemoryCount: 1,
        inactiveMemoryCount: 0,
        ownerCorrectedCount: 0,
        countsByKind: {
          personal_experience: 1,
          shared_experience: 0,
          relationship_event: 0,
          inside_joke: 0,
          user_preference: 0,
        },
        ownerRevisionCount: 0,
      },
      rows: [{
        memoryId: 'mem-1',
        kind: 'personal_experience',
        summary: 'safe summary',
        status: 'active',
        ownerCorrected: false,
        participants: ['user'],
      }],
    },
  };
}

function readModelFixture(snapshot = snapshotFixture(), rows: EffectiveMemoryAdminRow[] = snapshot.relationshipMemory.rows) {
  return {
    snapshot: vi.fn(async () => snapshot),
    queryMemories: vi.fn(() => rows),
  } satisfies SubconsciousAdminHttpReadModel;
}

describe('Subconscious admin HTTP boundary', () => {
  it('returns the 093F snapshot shape unchanged and maps bounded options to the read model', async () => {
    const model = readModelFixture();
    const handler = createSubconsciousAdminHttpHandler(model);
    const response = await handler(new Request(
      `${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}?recentRunLimit=7&cacheRunLimit=5&query=shared%20trip&kind=relationship_event&active=true&memoryId=mem-7`,
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshotFixture());
    expect(model.snapshot).toHaveBeenCalledWith({
      recentRunLimit: 7,
      cacheRunLimit: 5,
      memoryQuery: {
        query: 'shared trip',
        kind: 'relationship_event',
        active: true,
        memory_id: 'mem-7',
      },
    });
    expect(model.queryMemories).not.toHaveBeenCalled();
  });

  it('maps effective-memory filters exactly and rejects malformed query values before domain reads', async () => {
    const rows = snapshotFixture().relationshipMemory.rows;
    const model = readModelFixture(snapshotFixture(), rows);
    const handler = createSubconsciousAdminHttpHandler(model);

    const response = await handler(new Request(
      `${baseUrl}${SUBCONSCIOUS_ADMIN_MEMORIES_PATH}?query=safe&kind=personal_experience&active=false&memoryId=mem-1`,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rows);
    expect(model.queryMemories).toHaveBeenCalledWith({
      query: 'safe', kind: 'personal_experience', active: false, memory_id: 'mem-1',
    });

    model.queryMemories.mockClear();
    for (const query of [
      'active=1',
      'kind=not-a-kind',
      'memoryId=%20%20',
      'unknown=value',
      'active=true&active=false',
    ]) {
      const invalid = await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_MEMORIES_PATH}?${query}`));
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_query' } });
    }
    expect(model.queryMemories).not.toHaveBeenCalled();

    const invalidLimit = await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}?recentRunLimit=101`));
    expect(invalidLimit.status).toBe(400);
    expect(model.snapshot).toHaveBeenCalledTimes(0);
  });

  it('preserves section-level partial failure and unavailable provider usage without fabricating zero', async () => {
    const snapshot = snapshotFixture();
    snapshot.runtime = {
      availability: 'unreachable',
      error: { kind: 'unreachable', message: 'Letta runtime is unreachable' },
      overview: {
        agentId: 'agent-a',
        activity: 'unreachable',
        observedAt: '2026-08-08T13:10:00Z',
        activeRunIds: [],
        providerUsage: {
          quality: 'unavailable',
          source: 'provider adapter not configured',
          observedAt: '2026-08-08T13:10:00Z',
        },
        error: { kind: 'unreachable', message: 'Letta runtime is unreachable' },
      },
    };
    snapshot.recentRuns = {
      availability: 'unreachable',
      error: { kind: 'unreachable', message: 'Letta runtime is unreachable' },
      items: [],
    };
    snapshot.promptCache = {
      availability: 'error',
      error: { kind: 'query_error', message: 'cache query failed' },
      conversations: [],
    };

    const handler = createSubconsciousAdminHttpHandler(readModelFixture(snapshot));
    const response = await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}`));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.runtime.availability).toBe('unreachable');
    expect(body.recentRuns.availability).toBe('unreachable');
    expect(body.promptCache.availability).toBe('error');
    expect(body.relationshipMemory.availability).toBe('available');
    expect(body.relationshipMemory.rows).toHaveLength(1);
    expect(body.runtime.overview.providerUsage.quality).toBe('unavailable');
    expect(body.runtime.overview.providerUsage).not.toHaveProperty('remaining');
    expect(body.runtime.overview.providerUsage).not.toHaveProperty('limit');
  });

  it('does not serialize hidden fixture state, Authorization headers, or thrown secret details', async () => {
    const secrets = [
      'SECRET SYSTEM PROMPT',
      'SECRET MEMORY PAYLOAD',
      'SECRET EVIDENCE QUOTE',
      'SECRET PROVIDER API KEY',
      'Bearer SECRET AUTHORIZATION',
      'SECRET RAW TOOL RESULT',
    ];
    const safeSnapshot = snapshotFixture();
    const model = {
      rawFixtures: {
        letta: { systemPrompt: secrets[0], toolResult: secrets[5] },
        memory: { payload: secrets[1], evidenceQuote: secrets[2] },
        provider: { apiKey: secrets[3] },
      },
      snapshot: vi.fn(async () => safeSnapshot),
      queryMemories: vi.fn(() => safeSnapshot.relationshipMemory.rows),
    };
    const handler = createSubconsciousAdminHttpHandler(model);
    const response = await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}`, {
      headers: { Authorization: secrets[4] },
    }));
    const serialized = await response.text();
    for (const secret of secrets) expect(serialized).not.toContain(secret);

    model.snapshot.mockRejectedValueOnce(new Error('SECRET PROVIDER API KEY caused a downstream failure'));
    const failed = await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}`, {
      headers: { Authorization: secrets[4] },
    }));
    const failedBody = await failed.text();
    expect(failed.status).toBe(500);
    expect(JSON.parse(failedBody)).toEqual({ error: { code: 'admin_read_failed', message: 'Admin read failed.' } });
    expect(failedBody).not.toContain('SECRET PROVIDER API KEY');
    expect(failedBody).not.toContain('SECRET AUTHORIZATION');
    expect(failedBody).not.toContain('stack');
  });

  it('calls only read-model methods and never owner/store mutation methods', async () => {
    const snapshot = snapshotFixture();
    const model = {
      snapshot: vi.fn(async () => snapshot),
      queryMemories: vi.fn(() => snapshot.relationshipMemory.rows),
      revise: vi.fn(),
      deactivate: vi.fn(),
      restore: vi.fn(),
      appendMemory: vi.fn(),
      appendOwnerRevision: vi.fn(),
    };
    const handler = createSubconsciousAdminHttpHandler(model);

    await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}`));
    await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_MEMORIES_PATH}`));

    expect(model.snapshot).toHaveBeenCalledTimes(1);
    expect(model.queryMemories).toHaveBeenCalledTimes(1);
    expect(model.revise).not.toHaveBeenCalled();
    expect(model.deactivate).not.toHaveBeenCalled();
    expect(model.restore).not.toHaveBeenCalled();
    expect(model.appendMemory).not.toHaveBeenCalled();
    expect(model.appendOwnerRevision).not.toHaveBeenCalled();
  });

  it('is GET-only and keeps the transport module free of direct source-query or cache-computation logic', async () => {
    const model = readModelFixture();
    const handler = createSubconsciousAdminHttpHandler(model);
    const post = await handler(new Request(`${baseUrl}${SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH}`, { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect(model.snapshot).not.toHaveBeenCalled();

    const currentFile = fileURLToPath(import.meta.url);
    const source = fs.readFileSync(path.resolve(path.dirname(currentFile), '../src/admin/http.ts'), 'utf8');
    for (const forbidden of [
      '/runs/', '/agents/', 'getAgentRuntimeOverview', 'collectAgentPromptCacheEffectiveness',
      'RelationshipMemoryStore', 'appendMemory', 'appendOwnerRevision', 'Authorization',
    ]) expect(source).not.toContain(forbidden);
  });
});
