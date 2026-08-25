import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildForegroundRecallBundle, renderForegroundRecallBundle } from './foreground_recall.js';
import { bindForegroundRecallTurnToMessage, persistForegroundRecallBundle, readForegroundRecallTurnState, readForegroundRecallTurnStateForMessage, writeForegroundRecallReceipt } from './foreground_recall_state.js';
import { acknowledgePendingSubconWhispers, queueSubconWhisper, readPendingSubconWhispers } from './subcon_whisper_queue.js';
import { findLatestUserMessageUuidForPrompt } from './transcript_utils.js';
import { renderForegroundRecallReceiptCatalog } from './send_worker_native.js';

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
    expect(persisted).toContain(bundle.query_sha256);
    expect(persisted).not.toContain('private summary');
    expect(persisted).not.toContain('private quote');

    acknowledgePendingSubconWhispers(readPendingSubconWhispers(cwd, 'session-a'));
    expect(readForegroundRecallTurnState(cwd, 'session-a', 'turn-a').delivery_state).toBe('emitted');
  });

  it('binds foreground turns to the exact transcript user UUID so repeated prompts cannot cross wires', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-binding-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '一样的问题' }] } },
      { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '第一次回答' }] } },
      { type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '一样的问题' }] } },
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    expect(findLatestUserMessageUuidForPrompt(transcript, '一样的问题')).toBe('user-2');
    expect(findLatestUserMessageUuidForPrompt(transcript, '不存在')).toBeUndefined();

    const bundle = await buildForegroundRecallBundle({
      async memorySearchRecallHybridWithEvidence() { return []; },
    }, '一样的问题', { sessionId: 'session-a', turnId: 'turn-2', now: () => '2026-08-25T00:00:00.000Z' });
    persistForegroundRecallBundle(cwd, bundle);
    writeForegroundRecallReceipt(cwd, {
      schema_version: 1, session_id: 'session-a', turn_id: 'turn-2', bundle_id: bundle.bundle_id,
      recorded_at: '2026-08-25T00:00:01.000Z', decision: 'none', searches: [],
    });
    bindForegroundRecallTurnToMessage(cwd, 'session-a', 'turn-2', 'user-2', () => '2026-08-25T00:00:02.000Z');
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-1')).toBeUndefined();
    const bound = readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-2');
    expect(bound?.binding.turn_id).toBe('turn-2');
    expect(bound?.receipt?.decision).toBe('none');
    expect(() => bindForegroundRecallTurnToMessage(cwd, 'session-a', 'other-turn', 'user-2')).toThrow('binding conflict');
  });

  it('renders receipt history as bookkeeping only, including delivery state but no raw query or quotes', () => {
    const rendered = renderForegroundRecallReceiptCatalog([{
      message_id: 'user-2', turn_id: 'turn-2', delivery_state: 'emitted',
      receipt: {
        schema_version: 1, session_id: 'session-a', turn_id: 'turn-2', bundle_id: 'bundle-2',
        recorded_at: '2026-08-25T00:00:01.000Z', decision: 'selected',
        searches: [{ kind: 'prefetch', query_sha256: 'hash-only', memory_ids: ['mem-1'] }],
        selected: { memory_id: 'mem-1', snippet_ids: ['snippet-1'] }, whisper_id: 'whisper-1',
      },
    }]);
    expect(rendered).toContain('message_id="user-2"');
    expect(rendered).toContain('decision="selected"');
    expect(rendered).toContain('delivery_state="emitted"');
    expect(rendered).toContain('memory_id="mem-1"');
    expect(rendered).not.toContain('raw query');
  });

});
