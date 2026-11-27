import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBackedSemanticRetriever } from '../relationship-memory/src/retrieval/index.js';
import type { Backends } from './backends.js';
import type { ChatTransport, TransportReply } from './llm.js';
import { Paused, Refused, runSequentialReplay, type ReplayOptions } from './sequential_replay.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const MEMORY = {
  schema_version: 1, memory_id: 'mem_seed', subject_id: 'local-user', kind: 'inside_joke', status: 'active',
  summary: '一个编出来的笑话', payload: {}, participants: [], observed_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
  dedupe_key: 'd', source_key: 's',
};

function setup(opts: { documents?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-test-'));
  dirs.push(root);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'memories.jsonl'), `${JSON.stringify(MEMORY)}\n`);
  fs.mkdirSync(path.join(seed, '.write-index-v1'));
  const index = path.join(root, 'index.json');
  const documents = Object.fromEntries(Array.from({ length: opts.documents ?? 1 }, (_, i) => [`memory:other${i}`, { content_hash: 'x', vector: [0.1, 0.2] }]));
  fs.writeFileSync(index, JSON.stringify({ schema_version: 1, provider_fingerprint: 'fp', documents }));
  const batches = path.join(root, 'batches.jsonl');
  const turn = (id: string, text: string) => ({
    batch_id: id, letta_session: 'conv-1', group: 'silent', latest_user_message: text, assistant_intents: [],
    canonical_messages: [{ message_id: `${id}-u`, evidence_id: `${id}-e`, role: 'user', quote: text, event_kind: 'user_text', captured_at: '2026-10-10T00:00:00Z' }],
    sync_context: { prev_user: '', prev_kohaku: '' },
  });
  fs.writeFileSync(batches, [turn('t1', '今天好累'), turn('t2', '到家了'), turn('t3', '🫳')].map((b) => JSON.stringify(b)).join('\n') + '\n');
  const live = path.join(root, 'live');
  fs.mkdirSync(live);
  const options: ReplayOptions = { batchesFile: batches, seedStore: seed, seedIndex: index, outDir: path.join(root, 'out'), forbid: [live], metered: false };
  return { root, seed, index, live, options };
}

/** Sync: phrases, then the gate says none. Async: search, then skip. failOn: return 429 to async on that batch. */
function model(failOn?: string, opts: { slowSyncPhrase429?: number } = {}): ChatTransport & { calls: number } {
  const t = {
    calls: 0,
    async chat(body: any): Promise<TransportReply> {
      t.calls++;
      const reply = (message: any, status = 200): TransportReply => ({ status, ms: 1, body: status === 200 ? { choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } } : { error: 'rate limited' } });
      if (!body.tools && opts.slowSyncPhrase429 && !String(body.messages.at(-1).content).includes('Candidate memories')) {
        await new Promise((resolve) => setTimeout(resolve, opts.slowSyncPhrase429));
        return reply(null, 429);
      }
      if (!body.tools) {
        const prompt = String(body.messages.at(-1).content);
        return reply({ role: 'assistant', content: prompt.includes('Candidate memories') ? '{"memory_id": null}' : '{"queries": ["累"]}' });
      }
      if (failOn && JSON.stringify(body.messages).includes(failOn)) return reply(null, 429);
      const last = body.messages.at(-1);
      const call = last.role === 'tool' ? { name: 'skip_whisper', args: {} } : { name: 'memory_search', args: { queries: ['累'] } };
      return reply({ role: 'assistant', content: null, tool_calls: [{ id: `c${t.calls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
    },
  };
  return t;
}

interface ProviderOptions { fingerprint?: string; failDocuments?: boolean; failQueries?: boolean; failQueriesOnce?: { done: boolean }; counts?: { queries: number; documents: number } }

function provider(opts: ProviderOptions) {
  return {
    model: 'm', dimensions: 2, maxBatchSize: 10, fingerprint: opts.fingerprint ?? 'fp',
    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (opts.counts) opts.counts.documents++;
      if (opts.failDocuments) throw new Error('down');
      return texts.map(() => [0.3, 0.4]);
    },
    async embedQuery(): Promise<number[]> {
      if (opts.counts) opts.counts.queries++;
      if (opts.failQueries) throw new Error('down');
      if (opts.failQueriesOnce && !opts.failQueriesOnce.done) { opts.failQueriesOnce.done = true; throw new Error('blip'); }
      return [0.1, 0.2];
    },
  };
}

function deps(transport: ChatTransport, opts: ProviderOptions & { meters?: () => Promise<any> } = {}) {
  const backends: Backends = {
    transport,
    canEmbedDocuments: true,
    retrieverFor: (indexFile) => new FileBackedSemanticRetriever(provider(opts) as any, indexFile),
    close: async () => {},
  };
  return { backends, meters: opts.meters ?? (async () => undefined), log: () => {} };
}

/** Time passes: every saved cooldown, and any the provider left in work/, has expired. */
function expireCooldowns(out: string): void {
  for (const dir of [path.join(out, 'cooldown'), path.join(out, 'work', 'semantic-index')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.includes('.provider-cooldown.'))) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), retry_after: '2000-01-01T00:00:00Z' }));
    }
  }
}

const results = (out: string): any[] => fs.readFileSync(path.join(out, 'checkpoint', 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('sequential replay', () => {
  it('runs turns in order, commits a checkpoint per turn, and resumes after the last one', async () => {
    const { options } = setup();
    expect(await runSequentialReplay({ ...options, limit: 2 }, deps(model()))).toEqual({ ran: 2, done: 2 });
    expect(results(options.outDir).map((r) => r.batch_id)).toEqual(['t1', 't2']);
    expect(fs.existsSync(path.join(options.outDir, 'INIT.json'))).toBe(true);
    expect(fs.readdirSync(path.join(options.outDir, 'checkpoint', 'store'))).not.toContain('.write-index-v1');
    const rest = await runSequentialReplay(options, deps(model()));
    expect(rest).toEqual({ ran: 1, done: 3 });
    expect(results(options.outDir).at(-1)).toMatchObject({ batch_id: 't3', skip: 'input_empty' });
  });

  it('refuses an output inside a forbidden path, an uninitialized directory, and a symlinked seed file', async () => {
    const { options, live, seed, root } = setup();
    await expect(runSequentialReplay({ ...options, outDir: path.join(live, 'out') }, deps(model()))).rejects.toBeInstanceOf(Refused);
    await expect(runSequentialReplay({ ...options, outDir: path.join(live, '..review') }, deps(model()))).rejects.toThrow(/forbidden/);
    fs.mkdirSync(options.outDir);
    fs.writeFileSync(path.join(options.outDir, 'stray'), '');
    await expect(runSequentialReplay(options, deps(model()))).rejects.toThrow(/not initialized/);
    fs.writeFileSync(path.join(root, 'elsewhere.jsonl'), '');
    fs.symlinkSync(path.join(root, 'elsewhere.jsonl'), path.join(seed, 'evidence.jsonl'));
    await expect(runSequentialReplay({ ...options, outDir: path.join(root, 'out2') }, deps(model()))).rejects.toThrow(/symlink/);
  });

  it('refuses an index whose fingerprint does not match the provider, or that has no documents', async () => {
    const { options, root } = setup();
    await expect(runSequentialReplay(options, deps(model(), { fingerprint: 'other' }))).rejects.toThrow(/fingerprint/);
    const empty = setup({ documents: 0 });
    await expect(runSequentialReplay({ ...empty.options, outDir: path.join(root, 'out3') }, deps(model()))).rejects.toThrow(/no documents/);
  });

  it('pauses before any model call when metered usage is unreadable or over a cap', async () => {
    const { options } = setup();
    const transport = model();
    await expect(runSequentialReplay({ ...options, metered: true }, deps(transport))).rejects.toBeInstanceOf(Paused);
    await expect(runSequentialReplay({ ...options, metered: true }, deps(transport, { meters: async () => ({ rolling: 61, weekly: 1 }) }))).rejects.toThrow(/caps/);
    await expect(runSequentialReplay({ ...options, metered: true }, deps(transport, { meters: async () => ({ rolling: NaN, weekly: 1 }) }))).rejects.toThrow(/unavailable/);
    expect(transport.calls).toBe(0);
    await expect(runSequentialReplay({ ...options, rollingCap: 0 }, deps(transport))).rejects.toThrow(/rolling-cap/);
  });

  it('does not commit a turn that hit a provider failure, and repeats it from the checkpoint', async () => {
    const { options } = setup();
    await expect(runSequentialReplay(options, deps(model('到家了')))).rejects.toThrow(/provider failure in t2/);
    expect(results(options.outDir).map((r) => r.batch_id)).toEqual(['t1']);
    const ledger = fs.readFileSync(path.join(options.outDir, 'checkpoint', 'store', 'batches.jsonl'), 'utf8');
    expect(ledger).toContain('t1');
    expect(ledger).not.toContain('t2');
    expect(await runSequentialReplay(options, deps(model()))).toEqual({ ran: 2, done: 3 });
  }, 30_000); // chat() backs off 1 + 2 + 4 s on a 429 before giving up

  it('does not report done while vectors are pending, and embeds them on the next start', async () => {
    const { options } = setup();
    await runSequentialReplay(options, deps(model()));
    const stateFile = path.join(options.outDir, 'checkpoint', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, pending_embed: ['mem_seed'] }));
    await expect(runSequentialReplay(options, deps(model(), { failDocuments: true }))).rejects.toThrow(/pending memory embeddings/);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending_embed).toEqual(['mem_seed']);
    // The failed embedding also set a provider cooldown; the next start waits for it. Let it expire.
    await expect(runSequentialReplay(options, deps(model()))).rejects.toThrow(/embedding cooldown until/);
    expireCooldowns(options.outDir);
    const counts = { queries: 0, documents: 0 };
    expect(await runSequentialReplay(options, deps(model(), { counts }))).toEqual({ ran: 0, done: 3 });
    expect(counts.documents).toBe(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending_embed).toEqual([]);
    const index = JSON.parse(fs.readFileSync(path.join(options.outDir, 'checkpoint', 'semantic-index', 'index.json'), 'utf8'));
    expect(Object.keys(index.documents)).toEqual(expect.arrayContaining(['memory:other0', 'memory:mem_seed']));
  });

  it('refuses a second runner while the first holds the lock', async () => {
    const { options } = setup();
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    fs.writeFileSync(path.join(options.outDir, 'RUN.lock'), JSON.stringify({ pid: process.pid, token: 'other' }));
    await expect(runSequentialReplay(options, deps(model()))).rejects.toThrow(/RUN.lock/);
    // A dead holder is not taken over either: two takers could both win. It is removed by hand.
    fs.writeFileSync(path.join(options.outDir, 'RUN.lock'), JSON.stringify({ pid: 999_999_999, token: 'dead' }));
    await expect(runSequentialReplay(options, deps(model()))).rejects.toThrow(/RUN.lock/);
    fs.rmSync(path.join(options.outDir, 'RUN.lock'));
    expect((await runSequentialReplay(options, deps(model()))).done).toBe(3);
    expect(fs.existsSync(path.join(options.outDir, 'RUN.lock'))).toBe(false);
  });

  it('rebuilds a seed that stopped before INIT.json, but never an unmarked checkpoint with progress', async () => {
    const { options, root } = setup();
    fs.mkdirSync(path.join(options.outDir, 'checkpoint', 'store'), { recursive: true });
    fs.writeFileSync(path.join(options.outDir, 'checkpoint', 'SEED.json'), '{}');
    expect(await runSequentialReplay(options, deps(model()))).toEqual({ ran: 3, done: 3 });

    // A copy of a committed checkpoint without its INIT.json (say, a recovery copy) is refused and left untouched.
    const copy = path.join(root, 'recovery');
    fs.mkdirSync(copy);
    fs.cpSync(path.join(options.outDir, 'checkpoint'), path.join(copy, 'checkpoint'), { recursive: true });
    const before = fs.readFileSync(path.join(copy, 'checkpoint', 'results.jsonl'));
    await expect(runSequentialReplay({ ...options, outDir: copy }, deps(model()))).rejects.toThrow(/not a seed/);
    expect(fs.readFileSync(path.join(copy, 'checkpoint', 'results.jsonl')).equals(before)).toBe(true);
    // Without a seed mark it is refused too, even with no results yet.
    const bare = path.join(root, 'bare');
    fs.mkdirSync(path.join(bare, 'checkpoint'), { recursive: true });
    await expect(runSequentialReplay({ ...options, outDir: bare }, deps(model()))).rejects.toThrow(/not a seed/);
  });

  it('writes listed intents to the store copy and drops resolved ones from the catalog', async () => {
    const { options } = setup();
    const intent = {
      schema_version: 1, intent_id: 'intent_made_up', subject_id: 'local-user', session_id: 'conv-1', assistant_message_id: 'a1',
      tool_use_id: 'tu1', tool_name: 'remember', memory: { text: '编出来的一件事' }, feel: { text: '开心' }, captured_at: '2026-10-10T00:00:00Z',
    };
    const lines = fs.readFileSync(options.batchesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    fs.writeFileSync(options.batchesFile, lines.map((b) => JSON.stringify(b.batch_id === 't3' ? b : { ...b, assistant_intents: [intent] })).join('\n') + '\n');
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    const intentsFile = path.join(options.outDir, 'checkpoint', 'store', 'assistant-intents.jsonl');
    expect(fs.readFileSync(intentsFile, 'utf8')).toContain('intent_made_up');
    expect(results(options.outDir)[0].input).toMatchObject({ intents_listed: 1, intents_open: 1 });
    // Resolved in between (as a pass would record it): the next turn no longer offers it.
    fs.appendFileSync(path.join(options.outDir, 'checkpoint', 'store', 'assistant-intent-outcomes.jsonl'), `${JSON.stringify({ intent_id: 'intent_made_up', batch_id: 't1', outcome: 'accepted', memory_id: 'mem_seed', recorded_at: '2026-10-10T00:00:01Z' })}\n`);
    await runSequentialReplay({ ...options, limit: 2 }, deps(model()));
    expect(results(options.outDir)[1].input).toMatchObject({ intents_listed: 1, intents_open: 0 });
    expect(fs.readFileSync(intentsFile, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('drops messages a committed turn of the same session already handled, whatever conversation re-sent them', async () => {
    const { options } = setup();
    const lines = fs.readFileSync(options.batchesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const first = lines[0].canonical_messages[0];
    // t2 re-sends t1's message under a rotated conversation (new evidence id); t3 belongs to another session.
    lines[0] = { ...lines[0], session_id: 's-1' };
    lines[1] = { ...lines[1], session_id: 's-1', letta_session: 'conv-2', canonical_messages: [{ ...first, evidence_id: 'rotated-e' }, ...lines[1].canonical_messages] };
    lines[2] = { ...lines[2], session_id: 's-2', latest_user_message: '下班了', canonical_messages: [{ ...first, evidence_id: 'other-e' }] };
    fs.writeFileSync(options.batchesFile, lines.map((b) => JSON.stringify(b)).join('\n') + '\n');
    await runSequentialReplay(options, deps(model()));
    expect(results(options.outDir).map((r) => [r.session, r.input.messages_resent])).toEqual([['s-1', 0], ['s-1', 1], ['s-2', 0]]);
  });

  it('refuses to resume with a different batches file', async () => {
    const { options } = setup();
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    const lines = fs.readFileSync(options.batchesFile, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(options.batchesFile, [lines[0], lines[2]].join('\n') + '\n');
    await expect(runSequentialReplay(options, deps(model()))).rejects.toThrow(/--batches differs/);
    expect(results(options.outDir).map((r) => r.batch_id)).toEqual(['t1']);
  });

  it('keeps an embedding cooldown across the rollback and pauses until it expires', async () => {
    const { options } = setup();
    // Give the index a vector that matches the seed memory, so search embeds its query.
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    const stateFile = path.join(options.outDir, 'checkpoint', 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), pending_embed: ['mem_seed'] }));
    await expect(runSequentialReplay(options, deps(model(), { failQueries: true }))).rejects.toThrow(/cooldown during t2/);
    expect(fs.readdirSync(path.join(options.outDir, 'cooldown')).length).toBe(1);
    // As if the runner had been killed before its cleanup: the cooldown survives only in work/.
    fs.rmSync(path.join(options.outDir, 'cooldown'), { recursive: true });
    const counts = { queries: 0, documents: 0 };
    await expect(runSequentialReplay(options, deps(model(), { counts }))).rejects.toThrow(/embedding cooldown until/);
    expect(counts.queries).toBe(0);
    expect(results(options.outDir).map((r) => r.batch_id)).toEqual(['t1']);
    expireCooldowns(options.outDir);
    expect(await runSequentialReplay(options, deps(model(), { counts }))).toEqual({ ran: 2, done: 3 });
    expect(counts.queries).toBeGreaterThan(0);
  });

  it('waits out a short cooldown in-process and repeats the turn', async () => {
    const { options } = setup();
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    const stateFile = path.join(options.outDir, 'checkpoint', 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), pending_embed: ['mem_seed'] }));
    const previous = process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS;
    process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS = '50';
    try {
      const lines: string[] = [];
      const d = { ...deps(model(), { failQueriesOnce: { done: false } }), log: (line: string) => lines.push(line) };
      expect(await runSequentialReplay({ ...options, cooldownWaitMs: 5_000 }, d)).toEqual({ ran: 2, done: 3 });
      expect(lines.some((line) => /cooldown during t2; waiting/.test(line))).toBe(true);
      expect(results(options.outDir).map((r) => r.batch_id)).toEqual(['t1', 't2', 't3']);
    } finally {
      if (previous === undefined) delete process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS;
      else process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS = previous;
    }
  }, 15_000);

  it('names the failing call in a provider-failure pause', async () => {
    const { options } = setup();
    await expect(runSequentialReplay(options, deps(model('到家了')))).rejects.toThrow(/provider failure in t2 \(async step 1 rate_limited 429\)/);
  }, 30_000);

  it('waits for a sync call that missed its deadline and pauses when it fails at the provider', async () => {
    const { options } = setup();
    await expect(runSequentialReplay({ ...options, syncTimeoutMs: 20 }, deps(model(undefined, { slowSyncPhrase429: 60 })))).rejects.toThrow(/late provider failure \(rate_limited\) in sync of t1/);
    expect(fs.existsSync(path.join(options.outDir, 'checkpoint', 'results.jsonl'))).toBe(false);
  });
});
