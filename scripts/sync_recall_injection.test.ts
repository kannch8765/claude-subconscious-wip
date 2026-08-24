import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncRecallRunResult } from './sync_recall.js';
import { composeWhisperModeInjection, decideSyncRecallAdmission, resolveSyncRecallInjection } from './sync_recall_injection.js';
import { formatPendingSubconWhispers, queueSubconWhisper, readPendingSubconWhispers } from './subcon_whisper_queue.js';

function selectedResult(summary = '猫和琥珀以前修过唤醒桥'): SyncRecallRunResult {
  return {
    status: 'ok',
    query_sha256: 'hash',
    elapsed_ms: 12,
    reranker_model: 'fake',
    candidates: [{
      memory_id: 'm1',
      summary,
      first_stage_rank: 1,
      lexical_score: 0,
      semantic_score: 0.1,
      hybrid_score: 10,
      rerank_rank: 1,
      rerank_score: 0.6,
      quote_snippet_count: 1,
    }],
    selected: {
      memory: {
        schema_version: 1,
        subject_id: 'subject',
        memory_id: 'm1',
        kind: 'shared_experience',
        summary,
        participants: ['user', 'assistant'],
        payload: { title: '唤醒桥', event: '修过桥' },
        status: 'active',
        observed_at: '2026-08-20T00:00:00.000Z',
        created_at: '2026-08-20T00:00:00.000Z',
        source_key: 'source',
        dedupe_key: 'dedupe',
        owner_corrected: false,
        quote_snippets: [{ snippet_id: 's1', source_kind: 'transcript', role: 'user', quote: '修桥原话', captured_at: '2026-08-20T00:00:00.000Z' }],
        retrieval: { lexical_score: 0, semantic_score: 0.1, hybrid_score: 10, first_stage_rank: 1 },
      },
      memory_rerank_score: 0.6,
      memory_rerank_rank: 1,
      snippets: [{ snippet_id: 's1', source_kind: 'transcript', role: 'user', quote: '修桥原话', captured_at: '2026-08-20T00:00:00.000Z', rerank_score: 0.8, rerank_rank: 1 }],
      body: `记忆：${summary}\n\n[2026-08-20]\n猫：「修桥原话」`,
      envelope: `<subcon_whisper source="sync_recall">记忆：${summary}</subcon_whisper>`,
    },
  } as SyncRecallRunResult;
}

const roots: string[] = [];

afterEach(() => {
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_CANARY_BYPASS;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-recall-injection-'));
  roots.push(root);
  return root;
}

describe('sync recall foreground admission and transport', () => {
  it('defaults to no injection for a grounded selection until admission is calibrated/configured', async () => {
    const weakButGrounded = selectedResult('猫和琥珀以前修过唤醒桥');
    const admission = decideSyncRecallAdmission(weakButGrounded);
    expect(admission).toEqual({ admitted: false, reason: 'policy_unconfigured' });

    const resolved = await resolveSyncRecallInjection(
      { hook_event_name: 'UserPromptSubmit', prompt: '猫今天想吃冰淇淋' },
      async () => weakButGrounded,
    );
    expect(resolved.output).toBe('');
    expect(resolved.admission?.reason).toBe('policy_unconfigured');
  });

  it('allows an explicit canary-only bypass to exercise successful blocking injection', async () => {
    process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_CANARY_BYPASS = '1';
    const result = selectedResult();
    const resolved = await resolveSyncRecallInjection(
      { hook_event_name: 'UserPromptSubmit', prompt: '唤醒桥后来怎么样了' },
      async () => result,
    );
    expect(resolved.output).toBe(result.selected?.envelope);
    expect(resolved.admission).toEqual({ admitted: true, reason: 'canary_bypass' });
  });

  it('fails open with empty enrichment output when the recall runner/provider fails', async () => {
    process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_CANARY_BYPASS = '1';
    const resolved = await resolveSyncRecallInjection(
      { hook_event_name: 'UserPromptSubmit', prompt: 'anything' },
      async () => { throw new Error('provider unavailable'); },
    );
    expect(resolved.output).toBe('');
    expect(resolved.result).toBeUndefined();
  });

  it('composes admitted sync recall with a real pending async whisper without dropping either', () => {
    const cwd = tempRoot();
    queueSubconWhisper(cwd, 'session-a', 'async-a', 'async memory');
    const pending = formatPendingSubconWhispers(readPendingSubconWhispers(cwd, 'session-a'));
    const sync = '<subcon_whisper source="sync_recall">sync memory</subcon_whisper>';
    const combined = composeWhisperModeInjection(sync, pending);
    expect(combined).toContain(sync);
    expect(combined).toContain('async memory');
    expect(combined).toBe(`${sync}\n\n${pending}`);
    expect(composeWhisperModeInjection('', pending)).toBe(pending);
  });
});
