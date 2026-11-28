import { describe, expect, it } from 'vitest';
import type { EffectiveMemoryRecord, WorldRevisionRecord } from '../relationship-memory/src/schema/index.js';
import { renderWorldUpdateTimeline } from './world_update_whisper.js';

function revision(index: number, fact: string, asOf: string, recordedAt: string): WorldRevisionRecord {
  return {
    schema_version: 1, revision_id: `world_rev_${index}`, memory_id: 'mem-world', fact, as_of: asOf, source: 'user',
    evidence_ids: [`ev-${index}`], batch_id: `batch-${index}`, recorded_at: recordedAt,
  };
}

function view(revisions: WorldRevisionRecord[], lastConfirmed: string): Pick<EffectiveMemoryRecord, 'kind' | 'payload' | 'world_update'> {
  const head = revisions.at(-1)!;
  return {
    kind: 'world_update',
    payload: { topic: 'Prime minister of Country X', fact: head.fact },
    world_update: {
      head: { revision_id: head.revision_id, fact: head.fact, as_of: head.as_of, source: head.source, recorded_at: head.recorded_at },
      revision_count: revisions.length,
      last_confirmed: lastConfirmed,
      head_evidence_ids: head.evidence_ids,
      revisions,
    },
  };
}

describe('world_update timeline renderer', () => {
  it('renders one revision with the head marker and last_confirmed', () => {
    expect(renderWorldUpdateTimeline(view([revision(1, 'Person A', '2026-04-01T10:00:00Z', '2026-05-01T00:00:00.000Z')], '2026-04-20T09:00:00Z'))).toBe([
      '（知识补丁）Prime minister of Country X',
      '· 2026-04-01 起：Person A　← 最新（截至 2026-04-20）',
    ].join('\n'));
  });

  it('renders three revisions oldest first by recorded_at, with last_confirmed only on the head', () => {
    const chain = [
      revision(1, 'Person A', '2026-01-10', '2026-02-01T00:00:00.000Z'),
      revision(3, 'Person C', '2026-03-01T08:00:00Z', '2026-04-01T00:00:00.000Z'),
      revision(2, 'Person B', '2025-12-01', '2026-03-01T00:00:00.000Z'),
    ];
    const text = renderWorldUpdateTimeline(view(chain, '2026-04-05T12:00:00Z'))!;
    expect(text).toBe([
      '（知识补丁）Prime minister of Country X',
      '· 2026-01-10 起：Person A',
      '· 2025-12-01 起：Person B',
      '· 2026-03-01 起：Person C　← 最新（截至 2026-04-05）',
    ].join('\n'));
    expect(text.match(/最新/gu)).toHaveLength(1);
    expect(text.match(/截至/gu)).toHaveLength(1);
  });

  it('falls back to the head when the chain is not present, and returns null for other kinds', () => {
    const headOnly = view([revision(1, 'Person A', '2026-04-01', '2026-05-01T00:00:00.000Z')], '2026-04-02T00:00:00Z');
    delete headOnly.world_update!.revisions;
    expect(renderWorldUpdateTimeline(headOnly)).toBe('（知识补丁）Prime minister of Country X\n· 2026-04-01 起：Person A　← 最新（截至 2026-04-02）');
    expect(renderWorldUpdateTimeline({ kind: 'user_preference', payload: { topic: 'news' } })).toBeNull();
    expect(renderWorldUpdateTimeline({ kind: 'world_update', payload: { topic: 'news' } })).toBeNull();
  });
});
