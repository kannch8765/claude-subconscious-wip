import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import type { ChatTransport, TransportReply } from './llm.js';
import { buildUserMessage, harnessTools, runAsyncPass } from './pass.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

type Call = { name: string; args: unknown };
/** Replies in order: each entry is the tool calls of one model step (empty = a text reply). */
function scripted(steps: Call[][]): ChatTransport {
  let i = 0;
  return {
    async chat(): Promise<TransportReply> {
      const calls = steps[Math.min(i++, steps.length - 1)];
      const message = calls.length
        ? { role: 'assistant', content: null, tool_calls: calls.map((c, n) => ({ id: `c${i}-${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: 'assistant', content: 'done' };
      return { status: 200, ms: 1, body: { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 1 } } };
    },
  };
}

function run(steps: Call[][], maxSteps = 4, opts: { known?: string[]; hits?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-test-'));
  dirs.push(root);
  const runtime = new RelationshipMemoryRuntime(new RelationshipMemoryStore(root, 'local-user'), new Map(), () => new Date().toISOString(), new Map(), true);
  if (opts.hits) {
    // Search returns made-up memories with one quote each, so deliver_whisper has something to pick.
    (runtime as any).memorySearchRecallHybridWithEvidence = async () => opts.hits!.map((memory_id) => ({
      memory_id, kind: 'inside_joke', summary: 'made up', participants: [], observed_at: '2026-10-01T00:00:00Z', payload: {},
      quote_snippets: [{ snippet_id: `${memory_id}-q1`, role: 'user', captured_at: '2026-10-01T00:00:00Z', quote: 'made up' }],
    }));
  }
  return runAsyncPass(runtime, scripted(steps), {
    batchId: 'batch-test', sessionId: 's', latestUserMessage: '今天好累', canonicalMessages: [], assistantIntents: [], sessionKnownMemoryIds: opts.known ?? [], recentSeen: [],
  }, { model: 'm', maxSteps });
}

const search: Call = { name: 'memory_search', args: { queries: ['累'] } };
const skip: Call = { name: 'skip_whisper', args: {} };

describe('async pass completion', () => {
  it('completes after a search and a decision', async () => {
    const result = await run([[search], [skip]]);
    expect(result.succeeded).toBe(true);
    expect(result.decisions.searches).toBe(1);
  });

  it('does not complete when the model never searches, even after the nudge', async () => {
    const result = await run([[], []]);
    expect(result.succeeded).toBe(false);
    expect(result.decisions.searches).toBe(0);
  });

  it('does not count a search that failed', async () => {
    const result = await run([[{ name: 'memory_search', args: { queries: [] } }], []]);
    expect(result.decisions.searches).toBe(0);
    expect(result.succeeded).toBe(false);
  });

  it('does not complete at the step limit when the last step failed', async () => {
    const result = await run([[search], [{ name: 'deliver_whisper', args: { memory_id: 'not-surfaced', quotes: [1] } }]], 2);
    expect(result.tool_errors.length).toBeGreaterThan(0);
    expect(result.succeeded).toBe(false);
  });

  it('treats a whisper of a session-known memory as a quiet skip, not an error', async () => {
    const result = await run([[search], [{ name: 'deliver_whisper', args: { memory_id: 'mem_known', quotes: [1] } }]], 2, { known: ['mem_known'], hits: ['mem_known', 'mem_new'] });
    expect(result.tool_errors).toEqual([]);
    expect(result.succeeded).toBe(true);
    expect(result.decisions.whisper).toBeUndefined();
    expect(result.decisions).toMatchObject({ whisper_skipped: true, whisper_known_skip: true });
    expect(result.steps).toHaveLength(2);
  });

  it('does not let a second deliver_whisper replace a known skip', async () => {
    const result = await run([[search], [{ name: 'deliver_whisper', args: { memory_id: 'mem_known', quotes: [1] } }, { name: 'deliver_whisper', args: { memory_id: 'mem_new', quotes: [1] } }]], 2, { known: ['mem_known'], hits: ['mem_known', 'mem_new'] });
    expect(result.decisions.whisper).toBeUndefined();
    expect(result.decisions.whisper_known_skip).toBe(true);
  });

  it('still whispers an eligible memory', async () => {
    const result = await run([[search], [{ name: 'deliver_whisper', args: { memory_id: 'mem_new', quotes: [1] } }]], 2, { known: ['mem_known'], hits: ['mem_known', 'mem_new'] });
    expect(result.succeeded).toBe(true);
    expect(result.decisions.whisper).toEqual({ memory_id: 'mem_new', snippet_ids: ['mem_new-q1'] });
    expect(result.decisions.whisper_known_skip).toBeUndefined();
  });

  it('records unknown tool names as unknown', async () => {
    const result = await run([[{ name: 'SENTINEL_tool_name', args: {} }], [search], [skip]]);
    expect(result.steps[0].tool_calls).toEqual(['unknown']);
    expect(JSON.stringify(result.steps)).not.toContain('SENTINEL');
  });
});

describe('intent field', () => {
  const props = (withIntents: boolean, name: string) =>
    (harnessTools(withIntents).find((tool) => tool.function.name === name)!.function.parameters as any).properties;

  it('is offered only when the batch has intents', () => {
    for (const name of ['memory_reinforce', 'memory_remember']) {
      expect(props(false, name)).not.toHaveProperty('assistant_intent_id');
      expect(props(true, name)).toHaveProperty('assistant_intent_id');
    }
  });
});

describe('conversation prompt', () => {
  const message = (id: string, quote: string) => ({ message_id: id, evidence_id: `${id}-e`, role: 'user', quote, event_kind: 'user_text', captured_at: '2026-10-10T00:00:00Z' }) as any;
  const input = (conversation: any[], fresh: any[]) => ({
    batchId: 'b', sessionId: 's', latestUserMessage: fresh.at(-1).quote, canonicalMessages: fresh, conversation, assistantIntents: [],
    sessionKnownMemoryIds: [], recentSeen: [{ memory_id: 'mem_x', summary: '编的摘要' }],
  });

  it('opens with the conversation, names the new messages, and keeps the earlier prompt as a prefix', () => {
    const one = [message('m1', '早'), message('m2', '去上班')];
    const first = buildUserMessage(input(one, [one[1]]));
    const second = buildUserMessage(input([...one, message('m3', '到了')], [message('m3', '到了')]));
    expect(first.startsWith('<conversation>')).toBe(true);
    expect(second).toContain('<new_messages>m3-e</new_messages>');
    expect(second).not.toContain('<evidence_catalog>');
    const stable = first.slice(0, first.indexOf('\n</conversation>'));
    expect(second.startsWith(stable)).toBe(true);
  });
});
