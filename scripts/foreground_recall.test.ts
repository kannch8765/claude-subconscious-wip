import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildForegroundRecallBundle, renderForegroundRecallBundle } from './foreground_recall.js';
import { persistForegroundRecallBundle, readForegroundRecallTurnState, writeForegroundRecallReceipt } from './foreground_recall_state.js';
import { acknowledgePendingSubconWhispers, queueSubconWhisper, readPendingSubconWhispers } from './subcon_whisper_queue.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('foreground recall bundle and receipt', () => {
  it('prefetches a bounded source-faithful bundle without requiring a model search tool', async () => {
    const calls: unknown[] = [];
    const bundle = await buildForegroundRecallBundle({
      async memorySearchRecallHybridWithEvidence(args) {
        calls.push(args);
        return [{
          memory_id: 'mem-1', summary: '一起喝过咖啡', kind: 'shared_experience',
          quote_snippets: [
            { snippet_id: 's-user', source_kind: 'transcript', role: 'user', quote: '今天想喝咖啡。', captured_at: '2026-08-01T10:00:00.000Z' },
            { snippet_id: 's-assistant', source_kind: 'transcript', role: 'assistant', quote: '那我陪猫去。', captured_at: '2026-08-01T10:00:01.000Z' },
          ],
        }];
      },
    }, '咖啡><🐾', { sessionId: 'session-a', turnId: 'turn-a', limit: 8, now: () => '2026-08-25T00:00:00.000Z' });

    expect(calls).toEqual([{ query: '咖啡><🐾', limit: 8 }]);
    expect(bundle.candidates).toHaveLength(1);
    const rendered = renderForegroundRecallBundle(bundle);
    expect(rendered).toContain('<foreground_recall_bundle');
    expect(rendered).toContain('memory_id="mem-1"');
    expect(rendered).toContain('snippet_id="s-user"');
    expect(rendered).toContain('猫：今天想喝咖啡。');
  });

  it('persists reference-only search state and derives delivery from the whisper marker', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-state-'));
    dirs.push(cwd);
    const bundle = await buildForegroundRecallBundle({
      async memorySearchRecallHybridWithEvidence() {
        return [{
          memory_id: 'mem-1', summary: 'private summary',
          quote_snippets: [{ snippet_id: 's-1', source_kind: 'legacy_memory', quote: 'private quote', captured_at: '2026-08-01T00:00:00.000Z' }],
        }];
      },
    }, 'raw private query', { sessionId: 'session-a', turnId: 'turn-a', now: () => '2026-08-25T00:00:00.000Z' });
    persistForegroundRecallBundle(cwd, bundle);
    const queued = queueSubconWhisper(cwd, 'session-a', 'batch-a', 'grounded whisper', { source: 'sync', turnId: 'turn-a' });
    expect(queued).toBeTruthy();
    writeForegroundRecallReceipt(cwd, {
      schema_version: 1,
      session_id: 'session-a', turn_id: 'turn-a', bundle_id: bundle.bundle_id,
      recorded_at: '2026-08-25T00:00:01.000Z', decision: 'selected',
      searches: [{ kind: 'prefetch', query_sha256: bundle.query_sha256, memory_ids: ['mem-1'] }],
      selected: { memory_id: 'mem-1', snippet_ids: ['s-1'] }, whisper_id: queued!.whisper_id,
    });

    const stateBefore = readForegroundRecallTurnState(cwd, 'session-a', 'turn-a');
    expect(stateBefore.bundle?.candidate_refs).toEqual([{ memory_id: 'mem-1', snippet_ids: ['s-1'] }]);
    expect(stateBefore.delivery_state).toBe('pending');
    const persisted = JSON.stringify(stateBefore.bundle);
    expect(persisted).not.toContain('raw private query');
    expect(persisted).not.toContain('private summary');
    expect(persisted).not.toContain('private quote');

    acknowledgePendingSubconWhispers(readPendingSubconWhispers(cwd, 'session-a'));
    expect(readForegroundRecallTurnState(cwd, 'session-a', 'turn-a').delivery_state).toBe('emitted');
  });
});
