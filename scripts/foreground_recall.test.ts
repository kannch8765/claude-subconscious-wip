import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildForegroundRecallBundle, renderForegroundRecallBundle } from './foreground_recall.js';
import { bindForegroundRecallTurnToMessage, bindPendingForegroundRecallTurnsToTranscript, bindPendingForegroundRecallTurnsToTranscriptUnlocked, listPendingForegroundRecallTurns, persistForegroundRecallBundle, readForegroundRecallTurnState, readForegroundRecallTurnStateForMessage, registerPendingForegroundRecallTurn, retractUnreleasedForegroundRecallReceipt, writeForegroundRecallReceipt } from './foreground_recall_state.js';
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

  it('binds opaque foreground turns only from full transcript structure plus the unprocessed user suffix', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-pending-binding-'));
    dirs.push(cwd);
    const u1: any = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } };
    const a1: any = { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'reply' }] } };
    const u2: any = { type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: 'two' }] } };

    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-1', { tail_role: 'none' }, () => '2026-08-26T00:00:00.000Z');
    const first = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u1], ['user-1'], () => '2026-08-26T00:00:02.000Z');
    expect(first.bindings.map((item) => [item.turn_id, item.message_id])).toEqual([['fg-1', 'user-1']]);

    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-2', {
      tail_role: 'assistant', tail_message_id: 'assistant-1', last_user_message_id: 'user-1',
    }, () => '2026-08-26T00:00:01.000Z');
    const second = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u1, a1, u2], ['user-2'], () => '2026-08-26T00:00:03.000Z');
    expect(second.bindings.map((item) => [item.turn_id, item.message_id])).toEqual([['fg-2', 'user-2']]);
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-1')?.binding.turn_id).toBe('fg-1');
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-2')?.binding.turn_id).toBe('fg-2');
    expect(listPendingForegroundRecallTurns(cwd, 'session-a')).toEqual([]);
  });

  it('binds multiple self-anchored fast-chat turns from the earliest exact parent edge in one Stop', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-fast-chat-one-stop-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-0', message: { content: [{ type: 'text', text: 'same prompt' }] } };
    const a0: any = { type: 'assistant', uuid: 'assistant-0', parentUuid: 'user-0', message: { content: [{ type: 'text', text: 'reply 0' }] } };
    const u1: any = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'middle' }] } };
    const a1: any = { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', message: { content: [{ type: 'text', text: 'reply 1' }] } };
    const u2: any = { type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: 'same prompt' }] } };
    const a2: any = { type: 'assistant', uuid: 'assistant-2', parentUuid: 'user-2', message: { content: [{ type: 'text', text: 'reply 2' }] } };

    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-0', {
      tail_role: 'user', tail_message_id: 'user-0', last_user_message_id: 'user-0',
    });
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-1', {
      tail_role: 'user', tail_message_id: 'user-1', last_user_message_id: 'user-1',
    });
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-2', {
      tail_role: 'user', tail_message_id: 'user-2', last_user_message_id: 'user-2',
    });

    const result = bindPendingForegroundRecallTurnsToTranscript(
      cwd, 'session-a', [u0, a0, u1, a1, u2, a2], ['user-0', 'user-1', 'user-2'],
    );
    expect(result.bindings.map((item) => [item.turn_id, item.message_id])).toEqual([
      ['fg-0', 'user-0'], ['fg-1', 'user-1'], ['fg-2', 'user-2'],
    ]);
    expect(result.retired_unbound_turn_ids).toEqual([]);
    expect(listPendingForegroundRecallTurns(cwd, 'session-a')).toEqual([]);
  });

  it('does not bind N+1 to N while the next real user UUID has not reached the transcript', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-fast-chat-anchor-'));
    dirs.push(cwd);
    const uN: any = { type: 'user', uuid: 'user-n', message: { content: [{ type: 'text', text: 'n' }] } };
    const aN: any = { type: 'assistant', uuid: 'assistant-n', message: { content: [{ type: 'text', text: 'reply n' }] } };
    const uNext: any = { type: 'user', uuid: 'user-next', message: { content: [{ type: 'text', text: 'next' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-next', {
      tail_role: 'assistant', tail_message_id: 'assistant-n', last_user_message_id: 'user-n',
    });
    const blocked = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [uN, aN], ['user-n']);
    expect(blocked.bindings).toEqual([]);
    expect(blocked.blocked_turn_id).toBe('fg-next');
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-n')).toBeUndefined();
    expect(listPendingForegroundRecallTurns(cwd, 'session-a').map((item) => item.turn_id)).toEqual(['fg-next']);

    const bound = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [uN, aN, uNext], ['user-next']);
    expect(bound.bindings.map((item) => [item.turn_id, item.message_id])).toEqual([['fg-next', 'user-next']]);
  });

  it('treats an interrupted pre-v2 user tail as ambiguous instead of binding the old UUID', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-user-tail-ambiguous-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-old', message: { content: [{ type: 'text', text: 'old' }] } };
    const u1: any = { type: 'user', uuid: 'user-current', message: { content: [{ type: 'text', text: 'current' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-current', {
      tail_role: 'user', tail_message_id: 'user-old', last_user_message_id: 'user-old',
    });

    // Without a raw parent edge both old and current remain structurally possible.
    const ambiguous = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0, u1], ['user-old', 'user-current']);
    expect(ambiguous.bindings).toEqual([]);
    expect(ambiguous.retired_unbound_turn_ids).toEqual(['fg-current']);
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-old')).toBeUndefined();
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-current')).toBeUndefined();
    expect(listPendingForegroundRecallTurns(cwd, 'session-a')).toEqual([]);
  });

  it('retires a self-bindable user-tail ambiguity before maintenance can carry it into the next Stop', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-cross-stop-retire-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-0', message: { content: [{ type: 'text', text: 'zero' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-0', {
      tail_role: 'user', tail_message_id: 'user-0', last_user_message_id: 'user-0',
    });

    // Stop #1 can already consume U0. Without a parent edge, fg-0 might mean
    // either U0 itself or a not-yet-appended next user, so it must terminate
    // unbound before the maintenance cursor can move past U0.
    const first = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0], ['user-0']);
    expect(first.bindings).toEqual([]);
    expect(first.retired_unbound_turn_ids).toEqual(['fg-0']);
    expect(first.blocked_turn_id).toBeUndefined();
    expect(listPendingForegroundRecallTurns(cwd, 'session-a')).toEqual([]);

    // Stop #2 must not resurrect fg-0 and bind it to the next real UUID.
    const u1: any = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } };
    const a1: any = { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', message: { content: [{ type: 'text', text: 'reply' }] } };
    const second = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0, u1, a1], ['user-1']);
    expect(second.bindings).toEqual([]);
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-1')).toBeUndefined();
  });

  it('never transfers a retired resolved receipt onto the next Stop user UUID', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-cross-stop-receipt-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-0', message: { content: [{ type: 'text', text: 'zero' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-0', {
      tail_role: 'user', tail_message_id: 'user-0', last_user_message_id: 'user-0',
    });
    writeForegroundRecallReceipt(cwd, {
      schema_version: 1, session_id: 'session-a', turn_id: 'fg-0', bundle_id: 'bundle-0',
      recorded_at: '2026-08-26T00:00:00.000Z', decision: 'none', searches: [],
    });
    const first = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0], ['user-0']);
    expect(first.retired_unbound_turn_ids).toEqual(['fg-0']);

    const u1: any = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } };
    const a1: any = { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', message: { content: [{ type: 'text', text: 'reply' }] } };
    bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0, u1, a1], ['user-1']);
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-1')).toBeUndefined();
    expect(readForegroundRecallTurnState(cwd, 'session-a', 'fg-0').receipt?.decision).toBe('none');
  });

  it('uses the raw assistant parent edge to bind an interrupted pre-v2 user tail to the actual current UUID', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-parent-edge-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-old', message: { content: [{ type: 'text', text: 'old' }] } };
    const u1: any = { type: 'user', uuid: 'user-current', message: { content: [{ type: 'text', text: 'current' }] } };
    const a1: any = { type: 'assistant', uuid: 'assistant-current', parentUuid: 'user-current', message: { content: [{ type: 'thinking', thinking: 'tool-only response can still anchor' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-current', {
      tail_role: 'user', tail_message_id: 'user-old', last_user_message_id: 'user-old',
    });
    const result = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0, u1, a1], ['user-old', 'user-current']);
    expect(result.bindings.map((item) => [item.turn_id, item.message_id])).toEqual([['fg-current', 'user-current']]);
    expect(result.retired_unbound_turn_ids).toEqual([]);
  });

  it('binds the next UUID after an interrupted user tail when the old UUID is outside the maintenance suffix', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-user-tail-next-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-old', message: { content: [{ type: 'text', text: 'old' }] } };
    const u1: any = { type: 'user', uuid: 'user-current', message: { content: [{ type: 'text', text: 'current' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-current', {
      tail_role: 'user', tail_message_id: 'user-old', last_user_message_id: 'user-old',
    });
    const result = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0, u1], ['user-current']);
    expect(result.bindings.map((item) => [item.turn_id, item.message_id])).toEqual([['fg-current', 'user-current']]);
  });

  it('skips a raw tool-result user tail and binds the next human user text UUID', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-tool-result-tail-'));
    dirs.push(cwd);
    const u0: any = { type: 'user', uuid: 'user-human-old', message: { content: [{ type: 'text', text: 'old' }] } };
    const toolResult: any = { type: 'user', uuid: 'user-tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } };
    const u1: any = { type: 'user', uuid: 'user-current', message: { content: [{ type: 'text', text: 'current' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-current', {
      tail_role: 'user', tail_message_id: 'user-tool-result', last_user_message_id: 'user-human-old',
    });
    const result = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u0, toolResult, u1], ['user-current']);
    expect(result.bindings.map((item) => item.message_id)).toEqual(['user-current']);
  });

  it('never lets a later pending turn overtake an earlier turn whose target is not durable yet', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-prefix-block-'));
    dirs.push(cwd);
    const u1: any = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } };
    const a1: any = { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'thinking', thinking: 'internal only' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-earlier', {
      tail_role: 'assistant', tail_message_id: 'assistant-1', last_user_message_id: 'user-1',
    });
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-later', {
      tail_role: 'user', tail_message_id: 'user-1', last_user_message_id: 'user-1',
    });
    const result = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [u1, a1], ['user-1']);
    expect(result.bindings).toEqual([]);
    expect(result.blocked_turn_id).toBe('fg-earlier');
    expect(listPendingForegroundRecallTurns(cwd, 'session-a').map((item) => item.turn_id)).toEqual(['fg-earlier', 'fg-later']);
  });

  it('recovers when a message binding was published before the pending registration could be removed', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-pending-crash-'));
    dirs.push(cwd);
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-crash');
    bindForegroundRecallTurnToMessage(cwd, 'session-a', 'fg-crash', 'user-crash');
    const result = bindPendingForegroundRecallTurnsToTranscript(cwd, 'session-a', [], []);
    expect(result.bindings).toEqual([]);
    expect(listPendingForegroundRecallTurns(cwd, 'session-a')).toEqual([]);
    expect(readForegroundRecallTurnStateForMessage(cwd, 'session-a', 'user-crash')?.binding.turn_id).toBe('fg-crash');
  });

  it('provides an unlocked binder for composition inside the maintenance enqueue session-lock transaction', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-unlocked-binding-'));
    dirs.push(cwd);
    const u1: any = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } };
    registerPendingForegroundRecallTurn(cwd, 'session-a', 'fg-1', { tail_role: 'none' });
    const result = bindPendingForegroundRecallTurnsToTranscriptUnlocked(cwd, 'session-a', [u1], ['user-1']);
    expect(result.bindings.map((item) => item.message_id)).toEqual(['user-1']);
  });

  it('retracts selected/none receipts that never reached a release checkpoint but preserves failed receipts', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-recall-unreleased-receipt-'));
    dirs.push(cwd);
    writeForegroundRecallReceipt(cwd, {
      schema_version: 1, session_id: 'session-a', turn_id: 'turn-selected', bundle_id: 'bundle-a',
      recorded_at: '2026-08-26T00:00:00.000Z', decision: 'selected', searches: [],
      selected: { memory_id: 'mem-a', snippet_ids: ['snippet-a'] }, whisper_id: 'whisper-a',
    });
    expect(retractUnreleasedForegroundRecallReceipt(cwd, 'session-a', 'turn-selected')).toBe(true);
    expect(readForegroundRecallTurnState(cwd, 'session-a', 'turn-selected').receipt).toBeUndefined();

    writeForegroundRecallReceipt(cwd, {
      schema_version: 1, session_id: 'session-a', turn_id: 'turn-failed', bundle_id: 'bundle-b',
      recorded_at: '2026-08-26T00:00:01.000Z', decision: 'failed', searches: [], error: 'provider failed',
    });
    expect(retractUnreleasedForegroundRecallReceipt(cwd, 'session-a', 'turn-failed')).toBe(false);
    expect(readForegroundRecallTurnState(cwd, 'session-a', 'turn-failed').receipt?.decision).toBe('failed');
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
