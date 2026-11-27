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
function model(failOn?: string): ChatTransport & { calls: number } {
  const t = {
    calls: 0,
    async chat(body: any): Promise<TransportReply> {
      t.calls++;
      const reply = (message: any, status = 200): TransportReply => ({ status, ms: 1, body: status === 200 ? { choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } } : { error: 'rate limited' } });
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

function provider(fingerprint = 'fp', failDocuments = false) {
  return {
    model: 'm', dimensions: 2, maxBatchSize: 10, fingerprint,
    async embedDocuments(texts: string[]): Promise<number[][]> { if (failDocuments) throw new Error('down'); return texts.map(() => [0.3, 0.4]); },
    async embedQuery(): Promise<number[]> { return [0.1, 0.2]; },
  };
}

function deps(transport: ChatTransport, opts: { fingerprint?: string; failDocuments?: boolean; meters?: () => Promise<any> } = {}) {
  const backends: Backends = {
    transport,
    canEmbedDocuments: true,
    retrieverFor: (indexFile) => new FileBackedSemanticRetriever(provider(opts.fingerprint, opts.failDocuments) as any, indexFile),
    close: async () => {},
  };
  return { backends, meters: opts.meters ?? (async () => undefined), log: () => {} };
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

  it('keeps vectors still to be embedded across a pause and retries them first', async () => {
    const { options } = setup();
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    const stateFile = path.join(options.outDir, 'checkpoint', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, pending_embed: ['mem_seed'] }));
    await expect(runSequentialReplay(options, deps(model(), { failDocuments: true }))).rejects.toThrow(/pending memory embeddings/);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending_embed).toEqual(['mem_seed']);
    await runSequentialReplay(options, deps(model()));
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending_embed).toEqual([]);
    const index = JSON.parse(fs.readFileSync(path.join(options.outDir, 'checkpoint', 'semantic-index', 'index.json'), 'utf8'));
    expect(Object.keys(index.documents)).toEqual(expect.arrayContaining(['memory:other0', 'memory:mem_seed']));
  });

  it('refuses a second runner while the first holds the lock', async () => {
    const { options } = setup();
    await runSequentialReplay({ ...options, limit: 1 }, deps(model()));
    fs.writeFileSync(path.join(options.outDir, 'RUN.lock'), JSON.stringify({ pid: process.pid, token: 'other' }));
    await expect(runSequentialReplay(options, deps(model()))).rejects.toThrow(/RUN.lock/);
    fs.writeFileSync(path.join(options.outDir, 'RUN.lock'), JSON.stringify({ pid: 999_999_999, token: 'dead' }));
    expect((await runSequentialReplay(options, deps(model()))).done).toBe(3);
  });
});
