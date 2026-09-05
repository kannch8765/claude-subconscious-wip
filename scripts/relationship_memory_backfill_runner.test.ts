import { describe, expect, it } from 'vitest';
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

  it('lets both legacy entry modules be imported without starting a CLI run', async () => {
    const ordinary = await import('./relationship_memory_backfill.js');
    const omen = await import('./relationship_memory_backfill_omen.js');
    expect(ordinary.runRelationshipMemoryBackfill).toBeTypeOf('function');
    expect(omen.runRelationshipMemoryBackfill).toBe(ordinary.runRelationshipMemoryBackfill);
  });
});
