#!/usr/bin/env npx tsx
/**
 * Sequential replay (docs/specs/OWN-HARNESS-DESIGN.md §6): archived turns of one period run in time order on ONE
 * store copy, so the harness's own writes accumulate and later turns see them. Each turn runs the sync pass, then
 * the async pass with sync's pick as session-known. Session-known and recently seen come from the harness's own
 * earlier passes in that session (picks, memories it created, last three searches).
 *
 * Layout of --out:
 *   RUN.lock       taken before anything else and held to the end; never taken over (a stale one is removed by hand)
 *   INIT.json      written last at initialization: seed paths, index fingerprint, sha256 of the batches file
 *   checkpoint/    the last committed state: store data files, semantic index, sessions, pending embeddings, results
 *   work/          rebuilt from checkpoint/ at every start; a turn runs here and is committed only when it is clean
 *   cooldown/      embedding-provider cooldowns; outside the checkpoint, so a rollback does not forget them
 *
 * The run contract:
 *   - Ownership: one runner per --out (RUN.lock, created exclusively). Initialization, restore and every commit
 *     happen while it is held. An existing --out is used only if this runner initialized it (INIT.json).
 *   - Input: a resume must use the same batches file (sha256 in INIT.json), and the committed results must be
 *     exactly the first n batches of it, in order.
 *   - Commit: a turn is committed (atomic rename of a full copy) only when it ran clean. Interrupted, a provider
 *     failure (429, 5xx, transport) in sync or async, including a sync call that timed out and failed later, or a
 *     query-embedding cooldown: nothing is committed, the run pauses (exit 3) and the next start repeats the turn.
 *   - Vectors: memories the harness creates are embedded after their turn; failures stay pending in the checkpoint
 *     and are retried before the next model call and before the run reports done. While any remain, it pauses.
 *   - Cooldown: a saved embedding cooldown is honored before any call. One that ends within --cooldown-wait-ms
 *     (default 5 min) is waited out in-process and the uncommitted turn repeated; a longer one pauses the run.
 *   - Usage: in HTTP mode the OpenCode Go 5-hour and weekly meters must read below their caps before every turn;
 *     an unreadable meter pauses the run.
 *
 * Nothing live is written: --out must not overlap a --forbid path, seed files must be regular files, search uses
 * the existing vectors (rankExisting) and only memories the harness creates get vectors (HTTP mode). Recall timing
 * is off.
 *
 * Usage: tsx harness/sequential_replay.ts --batches <chronological jsonl> --store <seed store dir> --index <index.json>
 *        --out <dir> [--forbid <path>]... [--limit n] [--model m] [--sync-model m] [--max-steps n]
 *        [--rolling-cap pct] [--weekly-cap pct] [--cooldown-wait-ms ms]
 * Exit: 0 done (or --limit reached), 2 refused (paths, seed, input, lock, caps), 3 paused (resume by rerunning).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FileBackedSemanticRetriever, type SemanticRetriever } from '../relationship-memory/src/retrieval/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { backends as defaultBackends, type Backends } from './backends.js';
import { commonBigrams, evidenceCoverage } from './evidence_coverage.js';
import { runAsyncPass } from './pass.js';
import { runSyncPassSettled } from './sync_pass.js';
import { prepareTurn } from './turn_input.js';

export class Refused extends Error {}
export class Paused extends Error {
  /** True when the pause is an embedding-provider cooldown, which ends on its own at retry_after. */
  constructor(message: string, readonly cooldown = false) { super(message); }
}

export interface ReplayOptions {
  batchesFile: string;
  seedStore: string;
  seedIndex: string;
  outDir: string;
  forbid: string[];
  limit?: number;
  model?: string;
  syncModel?: string;
  maxSteps?: number;
  rollingCap?: number;
  weeklyCap?: number;
  /** Sync model-call deadline (phrases and gate); the default is the hook's. */
  syncTimeoutMs?: number;
  /** A cooldown that ends within this many ms is waited out in-process (the turn is repeated); longer ones pause. */
  cooldownWaitMs?: number;
  /** Meters are required (HTTP mode); undefined meters pause the run. */
  metered: boolean;
}

export interface ReplayDeps {
  backends: Backends;
  meters: () => Promise<{ rolling: number; weekly: number } | undefined>;
  log?: (line: string) => void;
}

interface Session { picked: string[]; written: string[]; passes: Array<Array<{ memory_id: string; summary: string }>> }
// handled: per session, the transcript messages a committed turn has already seen (see messageKey).
interface State { sessions: Record<string, Session>; pending_embed: string[]; handled?: Record<string, string[]> }

// One transcript message block, whatever conversation (and so evidence id) a batch carried it under.
const messageKey = (m: any): string => [m.message_id, m.block_index ?? '', m.event_kind ?? '', m.tool_use_id ?? ''].join('|');

const STATE = 'state.json';
const RESULTS = 'results.jsonl';

// ---- paths and copies

function real(p: string): string {
  return fs.realpathSync(p);
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** --out (and its parent, before it exists) must not be inside or contain any forbidden path. */
export function checkOutPath(outDir: string, forbid: string[]): string {
  const parent = real(path.dirname(path.resolve(outDir)));
  const out = path.join(parent, path.basename(path.resolve(outDir)));
  const resolved = fs.existsSync(out) ? real(out) : out;
  for (const f of forbid) {
    if (!fs.existsSync(f)) continue;
    const fr = real(f);
    if (inside(resolved, fr) || inside(fr, resolved)) throw new Refused(`--out ${resolved} overlaps a forbidden path`);
  }
  return resolved;
}

/** The store's data files: top-level regular JSON/JSONL files. Symlinks are refused; dot entries are caches or locks. */
function storeDataFiles(dir: string): string[] {
  const names: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !/\.jsonl?$/.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Refused(`seed store file is a symlink: ${entry.name}`);
    if (entry.isFile()) names.push(entry.name);
  }
  return names.sort();
}

function copyRegular(src: string, dest: string): void {
  if (!fs.lstatSync(src).isFile()) throw new Refused(`not a regular file: ${src}`);
  fs.copyFileSync(src, dest);
}

function copyState(fromDir: string, toDir: string): void {
  fs.mkdirSync(path.join(toDir, 'store'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(toDir, 'semantic-index'), { recursive: true, mode: 0o700 });
  for (const name of storeDataFiles(path.join(fromDir, 'store'))) copyRegular(path.join(fromDir, 'store', name), path.join(toDir, 'store', name));
  copyRegular(path.join(fromDir, 'semantic-index', 'index.json'), path.join(toDir, 'semantic-index', 'index.json'));
  for (const name of [STATE, RESULTS]) if (fs.existsSync(path.join(fromDir, name))) copyRegular(path.join(fromDir, name), path.join(toDir, name));
}

function indexFingerprint(file: string): { fingerprint: string; documents: number } {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw?.schema_version !== 1 || typeof raw.provider_fingerprint !== 'string' || !raw.documents || typeof raw.documents !== 'object') throw new Refused('seed index is not a semantic index v1');
  return { fingerprint: raw.provider_fingerprint, documents: Object.keys(raw.documents).length };
}

function providerFingerprint(retriever: SemanticRetriever | undefined): string | undefined {
  return retriever instanceof FileBackedSemanticRetriever ? retriever.provider.fingerprint : undefined;
}

/** The seed index and the configured provider must agree, or the reader would treat the index as empty. */
function checkIndex(indexFile: string, storeDir: string, b: Backends): void {
  const { fingerprint, documents } = indexFingerprint(indexFile);
  if (!documents) throw new Refused('seed index has no documents');
  const provider = providerFingerprint(b.retrieverFor(indexFile, storeDir));
  if (provider !== fingerprint) throw new Refused('index fingerprint does not match the embedding provider');
}

// ---- run lock

function takeRunLock(outDir: string): () => void {
  const file = path.join(outDir, 'RUN.lock');
  const token = crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch {
    throw new Refused(`RUN.lock exists in ${outDir}: another runner is active, or one died. Check, then remove it by hand.`);
  }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file, { force: true }); } catch { /* gone */ }
  };
}

// ---- embedding cooldowns survive rollback

function saveCooldowns(outDir: string, indexDir: string): void {
  if (!fs.existsSync(indexDir)) return;
  const names = fs.readdirSync(indexDir).filter((name) => name.includes('.provider-cooldown.') && name.endsWith('.json'));
  if (!names.length) return;
  fs.mkdirSync(path.join(outDir, 'cooldown'), { recursive: true, mode: 0o700 });
  for (const name of names) copyRegular(path.join(indexDir, name), path.join(outDir, 'cooldown', name));
}

function checkCooldowns(outDir: string, now = Date.now()): void {
  const dir = path.join(outDir, 'cooldown');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    let until = NaN;
    try { until = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).retry_after); } catch { /* unreadable */ }
    if (!Number.isFinite(until)) throw new Paused(`unreadable embedding cooldown ${name}; check it, then remove it`);
    if (until > now) throw new Paused(`embedding cooldown until ${new Date(until).toISOString()}`, true);
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

// ---- checkpoint

function commit(outDir: string, work: string): void {
  const tmp = path.join(outDir, `checkpoint.tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  copyState(work, tmp);
  const checkpoint = path.join(outDir, 'checkpoint');
  const old = path.join(outDir, `checkpoint.old-${process.pid}`);
  if (fs.existsSync(checkpoint)) fs.renameSync(checkpoint, old);
  fs.renameSync(tmp, checkpoint);
  fs.rmSync(old, { recursive: true, force: true });
}

function restoreWork(outDir: string): string {
  const work = path.join(outDir, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  // A crash between the two renames of commit() leaves only checkpoint.old-*; it is the last committed state.
  if (!fs.existsSync(path.join(outDir, 'checkpoint'))) {
    const old = fs.readdirSync(outDir).find((name) => name.startsWith('checkpoint.old-'));
    if (!old) throw new Refused('no checkpoint to resume from');
    fs.renameSync(path.join(outDir, old), path.join(outDir, 'checkpoint'));
  }
  for (const name of fs.readdirSync(outDir)) if (name.startsWith('checkpoint.tmp-') || name.startsWith('checkpoint.old-')) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  copyState(path.join(outDir, 'checkpoint'), work);
  return work;
}

/**
 * Entries a crashed initialization can leave behind; anything else means the directory is not ours. A checkpoint/
 * without INIT.json is replaced only if it is provably the seed (see isSeedCheckpoint); otherwise it is refused.
 */
const INIT_LEFTOVERS = new Set(['RUN.lock', 'checkpoint.tmp-init', 'checkpoint']);
const SEED_MARK = 'SEED.json';

/** The seed carries SEED.json and has no results. A commit copies data files only, so it never carries the mark. */
function isSeedCheckpoint(dir: string): boolean {
  return fs.existsSync(path.join(dir, SEED_MARK)) && !fs.existsSync(path.join(dir, RESULTS));
}

function initialize(opts: ReplayOptions, out: string, b: Backends, batchesSha256: string): void {
  const checkpoint = path.join(out, 'checkpoint');
  if (fs.existsSync(checkpoint) && !isSeedCheckpoint(checkpoint)) {
    throw new Refused(`--out ${out} has a checkpoint/ without INIT.json that is not a seed; it may hold committed turns`);
  }
  const seed = path.join(out, 'checkpoint.tmp-init');
  fs.rmSync(seed, { recursive: true, force: true });
  fs.mkdirSync(path.join(seed, 'store'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(seed, 'semantic-index'), { recursive: true, mode: 0o700 });
  for (const name of storeDataFiles(opts.seedStore)) copyRegular(path.join(opts.seedStore, name), path.join(seed, 'store', name));
  copyRegular(opts.seedIndex, path.join(seed, 'semantic-index', 'index.json'));
  checkIndex(path.join(seed, 'semantic-index', 'index.json'), path.join(seed, 'store'), b);
  fs.writeFileSync(path.join(seed, STATE), JSON.stringify({ sessions: {}, pending_embed: [] } satisfies State), { mode: 0o600 });
  fs.writeFileSync(path.join(seed, SEED_MARK), '{}', { mode: 0o600 });
  // The new seed is complete and checked; only now replace an interrupted one.
  fs.rmSync(checkpoint, { recursive: true, force: true });
  fs.renameSync(seed, checkpoint);
  const { fingerprint, documents } = indexFingerprint(path.join(out, 'checkpoint', 'semantic-index', 'index.json'));
  fs.writeFileSync(path.join(out, 'INIT.json'), JSON.stringify({ created_at: new Date().toISOString(), seed_store: real(opts.seedStore), seed_index: real(opts.seedIndex), fingerprint, seed_documents: documents, batches_sha256: batchesSha256 }), { mode: 0o600 });
}

// ---- the run

function validCap(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 100) throw new Refused(`${name} must be a number in (0, 100]`);
  return value;
}

/** Which call failed and how, for the pause message: fixed classes and status codes only. */
function failureClasses(sync: { provider_error?: string }, steps: Array<{ step: number; status: number; error_class: string }>): string {
  return [
    ...(sync.provider_error ? [`sync ${sync.provider_error}`] : []),
    ...steps.filter((s) => s.error_class !== 'none').map((s) => `async step ${s.step} ${s.error_class} ${s.status}`),
  ].join(', ');
}

/** The latest retry_after among saved cooldowns, or undefined. */
function cooldownUntil(outDir: string): number | undefined {
  const dir = path.join(outDir, 'cooldown');
  if (!fs.existsSync(dir)) return undefined;
  let latest: number | undefined;
  for (const name of fs.readdirSync(dir)) {
    try {
      const until = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).retry_after);
      if (Number.isFinite(until)) latest = Math.max(latest ?? until, until);
    } catch { /* checkCooldowns reports it */ }
  }
  return latest;
}

const MAX_COOLDOWN_WAITS = 10;

function providerFailed(sync: { provider_error?: string }, steps: Array<{ error_class: string }>): boolean {
  return Boolean(sync.provider_error) || steps.some((s) => s.error_class !== 'none');
}

export async function runSequentialReplay(opts: ReplayOptions, deps: ReplayDeps): Promise<{ ran: number; done: number }> {
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING;
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE;
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  const rollingCap = validCap(opts.rollingCap ?? 60, '--rolling-cap');
  const weeklyCap = validCap(opts.weeklyCap ?? 70, '--weekly-cap');
  const out = checkOutPath(opts.outDir, opts.forbid);
  const b = deps.backends;
  const initFile = path.join(out, 'INIT.json');
  if (fs.existsSync(out) && !fs.existsSync(initFile) && fs.readdirSync(out).some((name) => !INIT_LEFTOVERS.has(name))) {
    throw new Refused(`--out ${out} exists but was not initialized by this runner`);
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const release = takeRunLock(out);
  let ran = 0;
  let indexDir: string | undefined;
  try {
    // One read: the bytes that are hashed are the bytes that are replayed.
    const batchesBytes = fs.readFileSync(opts.batchesFile);
    const batchesSha256 = crypto.createHash('sha256').update(batchesBytes).digest('hex');
    if (!fs.existsSync(initFile)) initialize(opts, out, b, batchesSha256);
    else if (JSON.parse(fs.readFileSync(initFile, 'utf8')).batches_sha256 !== batchesSha256) throw new Refused('--batches differs from the file this run was initialized with');
    // A short embedding cooldown is waited out here: the uncommitted turn is rebuilt from the checkpoint and repeated.
    let waits = 0;
    for (;;) {
      let ranHere = 0;
      try {
        // A runner killed before its cleanup leaves the provider's cooldown only in work/: keep it before work/ is rebuilt.
        saveCooldowns(out, path.join(out, 'work', 'semantic-index'));
        checkCooldowns(out);
        const work = restoreWork(out);
        const storeDir = path.join(work, 'store');
        const indexFile = path.join(work, 'semantic-index', 'index.json');
        indexDir = path.dirname(indexFile);
        checkIndex(indexFile, storeDir, b);
        const resultsFile = path.join(work, RESULTS);
        const doneIds: string[] = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).batch_id) : [];
        const state: State = JSON.parse(fs.readFileSync(path.join(work, STATE), 'utf8'));
        const saveState = (): void => fs.writeFileSync(path.join(work, STATE), JSON.stringify(state), { mode: 0o600 });

        const batches = batchesBytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        if (doneIds.some((id, i) => batches[i]?.batch_id !== id)) throw new Refused('committed results are not a prefix of --batches');
        let queue = batches.slice(doneIds.length);
        if (opts.limit && opts.limit > 0) queue = queue.slice(0, Math.max(0, opts.limit - doneIds.length));
        log(`sequential replay: ${queue.length} turns to run (${doneIds.length} done)`);
        const listing = new RelationshipMemoryStore(storeDir, 'local-user');
        const ignore = commonBigrams(listing.listEvidenceForMemoryIds(listing.listMemories().map((m) => m.memory_id)).map((e) => e.quote));
        const cooldown = (): boolean => fs.readdirSync(indexDir!).some((file) => file.includes('.provider-cooldown.'));
        // Vectors still missing from an earlier turn: embed them and commit, or pause. Without them store and index disagree.
        const drainPending = async (): Promise<void> => {
          if (!state.pending_embed.length || !b.canEmbedDocuments) return;
          const runtime = new RelationshipMemoryRuntime(new RelationshipMemoryStore(storeDir, 'local-user'), new Map(), () => new Date().toISOString(), new Map(), true, b.retrieverFor(indexFile, storeDir));
          try { await runtime.prepareCurrentMemorySemanticIndex(new Set(state.pending_embed)); } catch { throw new Paused(`${state.pending_embed.length} pending memory embeddings still fail`); }
          state.pending_embed = [];
          saveState();
          commit(out, work);
        };

        for (const batch of queue) {
          const meters = await deps.meters();
          if (opts.metered) {
            if (!meters || !Number.isFinite(meters.rolling) || !Number.isFinite(meters.weekly)) throw new Paused('usage meters unavailable');
            if (meters.rolling >= rollingCap || meters.weekly >= weeklyCap) throw new Paused(`usage rolling ${meters.rolling}% weekly ${meters.weekly}% (caps ${rollingCap}/${weeklyCap})`);
          }
          const store = new RelationshipMemoryStore(storeDir, 'local-user');
          // Live, the capture hook writes an intent to the store when Kohaku calls remember; the archive only lists it.
          // The archive's catalog also keeps the backlog of the agent that ran then: an intent the harness has already
          // resolved leaves the catalog here, as it would live.
          for (const intent of batch.assistant_intents) store.appendAssistantIntent(intent);
          const intents = batch.assistant_intents.filter((intent: any) => !store.getTerminalAssistantIntentOutcome(intent.intent_id));
          // Kohaku's session is the Claude session; the recorded Letta conversation inside it rotated on retries.
          const sessionKey: string = batch.session_id ?? batch.letta_session;
          // Live, the hook's cursor moves on once a pass completes, so the harness never gets a message twice. The recorded
          // batches re-send Letta's backlog (held cursor, retry rotation): keep only what this run has not handled yet.
          const handled = new Set((state.handled ??= {})[sessionKey] ?? []);
          const fresh = batch.canonical_messages.filter((m: any) => !handled.has(messageKey(m)));
          const makeRuntime = (canonical: any[]) => new RelationshipMemoryRuntime(
            store,
            new Map(canonical.map((m: any) => [m.evidence_id ?? m.message_id, { ...m, conversation_id: sessionKey }])),
            () => new Date().toISOString(),
            new Map(intents.map((intent: any) => [intent.intent_id, intent])),
            true,
            b.retrieverFor(indexFile, storeDir),
          );
          await drainPending();

          const session = (state.sessions[sessionKey] ??= { picked: [], written: [], passes: [] });
          const started = Date.now();
          const turn = prepareTurn({
            latestUserMessage: batch.latest_user_message as string,
            canonicalMessages: fresh,
            previousUserMessage: batch.sync_context?.prev_user ?? '',
            previousKohakuReply: batch.sync_context?.prev_kohaku ?? '',
          });
          const input = { dropped: turn.dropped, ...(turn.latest_dropped ? { latest_dropped: turn.latest_dropped } : {}), intents_listed: batch.assistant_intents.length, intents_open: intents.length, messages_resent: batch.canonical_messages.length - fresh.length };
          let record: Record<string, unknown>;
          if (turn.empty) {
            record = { batch_id: batch.batch_id, session: sessionKey, input, skip: 'input_empty', usage_before: meters };
          } else {
            const runtime = makeRuntime(turn.canonicalMessages!);
            const knownBefore = [...new Set([...session.picked, ...session.written])];
            const { result: sync, settled } = await runSyncPassSettled(runtime, b.transport, {
              batchId: batch.batch_id,
              sessionId: sessionKey,
              latestUserMessage: turn.latestUserMessage,
              previousUserMessage: turn.previousUserMessage!,
              previousKohakuReply: turn.previousKohakuReply!,
              sessionKnownMemoryIds: knownBefore,
            }, { model: opts.syncModel ?? 'glm-5.3-flash', reasoningEffort: 'none', ...(opts.syncTimeoutMs ? { phraseTimeoutMs: opts.syncTimeoutMs } : {}) });
            // A sync call that missed its deadline is still running: let it finish before anything else, and pause if it
            // failed at the provider. The record keeps the latency outcome (timeout); the provider outcome gates the commit.
            const lateError = await settled();
            if (lateError) throw new Paused(`late provider failure (${lateError}) in sync of ${batch.batch_id}`);
            const known = sync.whisper ? [...knownBefore, sync.whisper.memory_id] : knownBefore;
            const seen = new Map<string, string>();
            for (const pass of session.passes) for (const item of pass) seen.set(item.memory_id, item.summary);
            const asyncStarted = Date.now();
            const result = await runAsyncPass(runtime, b.transport, {
              batchId: batch.batch_id,
              sessionId: sessionKey,
              latestUserMessage: turn.latestUserMessage,
              canonicalMessages: turn.canonicalMessages!,
              assistantIntents: intents,
              sessionKnownMemoryIds: known,
              recentSeen: [...seen].map(([memory_id, summary]) => ({ memory_id, summary })),
            }, { model: opts.model ?? 'deepseek-v4.1-flash', maxSteps: opts.maxSteps ?? 4, reasoningEffort: 'none' });
            const asyncMs = Date.now() - asyncStarted;
            // Provider trouble or degraded search: the turn is not a fair sample. Leave work/ uncommitted and pause.
            if (providerFailed(sync, result.steps)) throw new Paused(`provider failure in ${batch.batch_id} (${failureClasses(sync, result.steps)})`);
            if (cooldown()) throw new Paused(`query-embedding cooldown during ${batch.batch_id}`, true);

            const created = result.decisions.remember.filter((r) => r.outcome === 'accepted' && r.memory_id).map((r) => r.memory_id!);
            let embedMs: number | undefined;
            if (created.length && b.canEmbedDocuments) {
              const embedStarted = Date.now();
              try { await runtime.prepareCurrentMemorySemanticIndex(new Set(created)); } catch { state.pending_embed.push(...created); }
              embedMs = Date.now() - embedStarted;
            }
            if (sync.whisper) session.picked.push(sync.whisper.memory_id);
            if (result.decisions.whisper) session.picked.push(result.decisions.whisper.memory_id);
            session.written.push(...created);
            session.passes = [...session.passes, result.surfaced_memory_ids.map((id) => ({ memory_id: id, summary: Array.from(store.getMemory(id)?.summary ?? '').slice(0, 150).join('') }))].slice(-3);
            record = {
              batch_id: batch.batch_id, session: sessionKey, group: batch.group, input, usage_before: meters,
              known_count: knownBefore.length, wall_ms: Date.now() - started, async_ms: asyncMs, sync, ...result,
              new_memory_coverage: created.map((id) => ({ memory_id: id, coverage: evidenceCoverage(store.getMemory(id)?.summary ?? '', store.listEvidenceForMemoryIds([id]).map((e) => e.quote), ignore) })),
              ...(embedMs !== undefined ? { embed_ms: embedMs } : {}),
              ...(created.length && !b.canEmbedDocuments ? { embed: 'unsupported' } : {}),
              ...(state.pending_embed.length ? { pending_embed: state.pending_embed.length } : {}),
            };
          }
          for (const m of batch.canonical_messages) handled.add(messageKey(m));
          state.handled[sessionKey] = [...handled];
          saveState();
          fs.appendFileSync(resultsFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
          commit(out, work);
          ran++;
          ranHere++;
          const r = record as any;
          log(`  ${batch.batch_id}: ${r.skip ?? r.completion} sync=${r.sync?.whisper ? 'whisper' : r.sync?.skip_reason ?? '-'} async=${r.decisions?.whisper ? 'whisper' : '-'} r${r.decisions?.reinforce?.length ?? 0} m${(r.decisions?.remember ?? []).filter((x: any) => x.outcome === 'accepted').length} ${r.wall_ms ?? 0} ms`);
        }
        await drainPending();
        return { ran, done: doneIds.length + ranHere };
      } catch (error) {
        if (!(error instanceof Paused) || !error.cooldown) throw error;
        if (indexDir) saveCooldowns(out, indexDir);
        const until = cooldownUntil(out);
        const wait = until === undefined ? 0 : until - Date.now();
        if (until === undefined || wait > (opts.cooldownWaitMs ?? 0) || waits >= MAX_COOLDOWN_WAITS) throw error;
        waits++;
        log(`  ${error.message}; waiting ${Math.max(0, Math.ceil(wait / 1000))} s (${waits}/${MAX_COOLDOWN_WAITS})`);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait) + 1_000));
      }
    }
  } finally {
    if (indexDir) saveCooldowns(out, indexDir);
    await b.close();
    release();
  }
}

// ---- command line

const USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';

async function readMeters(): Promise<{ rolling: number; weekly: number } | undefined> {
  const keyFile = process.env.HARNESS_LLM_KEY_FILE?.trim();
  if (!keyFile) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${fs.readFileSync(keyFile, 'utf8').trim()}`, 'User-Agent': 'subcon-harness/0.1' }, signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const usage = (await response.json() as any)?.usage;
        const rolling = usage?.rolling?.percent, weekly = usage?.weekly?.percent;
        if (typeof rolling === 'number' && typeof weekly === 'number') return { rolling, weekly };
      }
    } catch { /* retried */ }
    await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
  }
  return undefined;
}

function args(): ReplayOptions {
  const get = (name: string, fallback?: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : fallback;
    if (value === undefined) throw new Refused(`--${name} is required`);
    return value;
  };
  const forbid: string[] = [];
  process.argv.forEach((value, index) => { if (value === '--forbid' && process.argv[index + 1]) forbid.push(process.argv[index + 1]); });
  return {
    batchesFile: get('batches'), seedStore: get('store'), seedIndex: get('index'), outDir: get('out'), forbid,
    limit: Number(get('limit', '0')), model: get('model', 'deepseek-v4.1-flash'), syncModel: get('sync-model', 'glm-5.3-flash'),
    cooldownWaitMs: Number(get('cooldown-wait-ms', '300000')),
    maxSteps: Number(get('max-steps', '4')), rollingCap: Number(get('rolling-cap', '60')), weeklyCap: Number(get('weekly-cap', '70')),
    metered: !process.env.HARNESS_RELAY_HOST,
  };
}

const invokedAsMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedAsMain) {
  (async () => {
    let code = 0;
    try {
      const result = await runSequentialReplay(args(), { backends: defaultBackends(), meters: readMeters });
      process.stderr.write(`done: ran ${result.ran}, total ${result.done}\n`);
    } catch (error) {
      code = error instanceof Paused ? 3 : error instanceof Refused ? 2 : 1;
      process.stderr.write(`${error instanceof Paused ? 'paused' : error instanceof Refused ? 'refused' : 'failed'}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(code);
  })();
}
