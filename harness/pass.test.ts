import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import type { ChatTransport, TransportReply } from './llm.js';
import { harnessTools, runAsyncPass } from './pass.js';

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

function run(steps: Call[][], maxSteps = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-test-'));
  dirs.push(root);
  const runtime = new RelationshipMemoryRuntime(new RelationshipMemoryStore(root, 'local-user'), new Map(), () => new Date().toISOString(), new Map(), true);
  return runAsyncPass(runtime, scripted(steps), {
    batchId: 'batch-test', sessionId: 's', latestUserMessage: '今天好累', canonicalMessages: [], assistantIntents: [], sessionKnownMemoryIds: [], recentSeen: [],
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
