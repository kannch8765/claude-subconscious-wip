import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backfillStateNeedsFreshConversation, type BackfillState } from '../relationship-memory/src/backfill/index.js';
import { parseRelationshipMemoryBackfillArgs } from './relationship_memory_backfill_runner.js';

describe('relationship-memory backfill shared runner', () => {
  it('keeps the existing CLI defaults and option parsing', () => {
    expect(parseRelationshipMemoryBackfillArgs([
      '--transcript', '/tmp/transcript.jsonl', '--state', '/tmp/checkpoint.json', '--agent-id', 'agent-22222222-2222-4222-8222-222222222222',
    ])).toEqual({
      transcript: '/tmp/transcript.jsonl', state: '/tmp/checkpoint.json', agentId: 'agent-22222222-2222-4222-8222-222222222222',
      maxBatches: 1, maxRecords: 40, maxBytes: 2 * 1024 * 1024,
    });
    expect(parseRelationshipMemoryBackfillArgs([
      '--snapshot-manifest', '/tmp/snapshot.json', '--state', '/tmp/checkpoint.json', '--root', '/tmp/memory', '--cwd', '/tmp/work',
      '--max-batches', '3', '--max-records', '17', '--max-bytes', '4096',
    ])).toEqual({
      snapshotManifest: '/tmp/snapshot.json', state: '/tmp/checkpoint.json', root: '/tmp/memory', cwd: '/tmp/work',
      maxBatches: 3, maxRecords: 17, maxBytes: 4096,
    });
  });

  it('reuses clean paused checkpoints but rotates checkpointed retryable batches through the existing recovery boundary', () => {
    const clean: BackfillState = { schema_version: 1, backfill_session_id: 'session', conversation_id: 'conversation-old', agent_id: 'agent-old', sources: {} };
    const retryable: BackfillState = { ...clean, sources: { '/tmp/source.jsonl': { generation: 0, committed_offset: 123, integrity_chunks: [], blocked: { kind: 'retryable_batch', offset: 123 } } } };
    expect(backfillStateNeedsFreshConversation(clean)).toBe(false);
    expect(backfillStateNeedsFreshConversation(retryable)).toBe(true);
    const runner = fs.readFileSync(path.join(process.cwd(), 'scripts/relationship_memory_backfill_runner.ts'), 'utf8');
    expect(runner).toContain('if (!state.conversation_id || retryingBlockedBatch)');
    expect(runner).toContain('Rotated observer conversation before retrying a checkpointed retryable batch');
  });

  it('lets both legacy entry modules be imported without starting a CLI run', async () => {
    const ordinary = await import('./relationship_memory_backfill.js');
    const omen = await import('./relationship_memory_backfill_omen.js');
    expect(ordinary.runRelationshipMemoryBackfill).toBeTypeOf('function');
    expect(omen.runRelationshipMemoryBackfill).toBe(ordinary.runRelationshipMemoryBackfill);
  });
});
