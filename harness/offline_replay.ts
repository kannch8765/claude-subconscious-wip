#!/usr/bin/env npx tsx
/**
 * Offline replay of archived passes through the own-harness async pass
 * (docs/specs/OWN-HARNESS-DESIGN.md §6 step 1).
 *
 * Input: a JSONL of prepared batches (each with its own time-sliced store copy).
 * Each batch runs on a fresh copy of its store, so writes never reach a live store.
 * LLM calls and query embeddings go through a relay process (keys stay remote).
 * Output: one JSONL line per batch with step traces, decisions and ledger outcome
 * (IDs and numbers; no transcript text).
 *
 * Usage: tsx harness/offline_replay.ts --batches <file> --out <dir> --relay-host <ssh host>
 *        --relay-script <file> --index <semantic index.json> [--model m] [--max-steps n] [--parallel n] [--only id,id]
 */
import * as fs from 'fs';
import * as path from 'path';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { FileBackedSemanticRetriever, type EmbeddingProvider } from '../relationship-memory/src/retrieval/index.js';
import { RelayChatTransport, RelayProcess } from './llm.js';
import { runAsyncPass } from './pass.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class RelayQueryEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'text-embedding-v4';
  readonly dimensions = 1024;
  readonly maxBatchSize = 10;
  constructor(readonly fingerprint: string, private readonly relay: RelayProcess) {}
  async embedDocuments(): Promise<number[][]> {
    throw new Error('offline replay never embeds documents');
  }
  async embedQuery(text: string): Promise<number[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await this.relay.request({ op: 'embed_query', text });
      if (reply.status === 200 && Array.isArray(reply.body?.vector)) return reply.body.vector;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
    throw new Error('query embedding failed');
  }
}

async function main(): Promise<void> {
  const batchesFile = arg('batches');
  const outDir = arg('out');
  const model = arg('model', 'deepseek-v4.1-flash');
  const maxSteps = Number(arg('max-steps', '4'));
  const parallel = Number(arg('parallel', '3'));
  const only = new Set(arg('only', '').split(',').filter(Boolean));
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  // One shared, read-only copy of the semantic index for this run (cooldown files land here, not in the source).
  const indexSource = arg('index');
  const indexDir = path.join(outDir, 'semantic-index');
  fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 });
  const indexFile = path.join(indexDir, 'index.json');
  if (!fs.existsSync(indexFile)) fs.copyFileSync(indexSource, indexFile);
  const fingerprint = JSON.parse(fs.readFileSync(indexFile, 'utf8')).provider_fingerprint as string;

  const script = fs.readFileSync(arg('relay-script'), 'utf8');
  const relay = new RelayProcess('ssh', [arg('relay-host'), `python3 -u -c ${shellQuote(script)}`]);
  const transport = new RelayChatTransport(relay);
  const retriever = new FileBackedSemanticRetriever(new RelayQueryEmbeddingProvider(fingerprint, relay), indexFile);

  const batches = fs.readFileSync(batchesFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((batch) => only.size === 0 || only.has(batch.batch_id));
  const resultsFile = path.join(outDir, 'results.jsonl');
  const done = new Set(fs.existsSync(resultsFile)
    ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).batch_id)
    : []);
  const queue = batches.filter((batch) => !done.has(batch.batch_id));
  process.stderr.write(`replay: ${queue.length} batches (${done.size} already done), model=${model}, max_steps=${maxSteps}\n`);

  const runOne = async (batch: any): Promise<void> => {
    const storeDir = path.join(outDir, 'stores', batch.batch_id);
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.cpSync(batch.store_dir, storeDir, { recursive: true });
    const store = new RelationshipMemoryStore(storeDir, 'local-user');
    const runtime = new RelationshipMemoryRuntime(
      store,
      new Map(batch.canonical_messages.map((m: any) => [m.evidence_id ?? m.message_id, { ...m, conversation_id: batch.letta_session }])),
      () => new Date().toISOString(),
      new Map(batch.assistant_intents.map((intent: any) => [intent.intent_id, intent])),
      true,
      retriever,
    );
    const started = Date.now();
    let record: Record<string, unknown>;
    try {
      const result = await runAsyncPass(runtime, transport, {
        batchId: batch.batch_id,
        sessionId: batch.letta_session,
        latestUserMessage: batch.latest_user_message,
        canonicalMessages: batch.canonical_messages,
        assistantIntents: batch.assistant_intents,
        sessionKnownMemoryIds: batch.session_known,
        recentSeen: batch.recent_seen,
      }, { model, maxSteps, reasoningEffort: 'none' });
      record = { batch_id: batch.batch_id, group: batch.group, wall_ms: Date.now() - started, ...result };
    } catch (error) {
      record = { batch_id: batch.batch_id, group: batch.group, wall_ms: Date.now() - started, crashed: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown' };
    }
    for (const file of fs.readdirSync(indexDir)) if (file.includes('provider-cooldown')) fs.rmSync(path.join(indexDir, file), { force: true });
    fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    process.stderr.write(`  ${batch.batch_id} ${batch.group}: ${'crashed' in record ? 'CRASHED' : (record as any).completion} in ${record.wall_ms} ms\n`);
  };

  const workers = Array.from({ length: Math.max(1, parallel) }, async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) await runOne(batch);
  });
  await Promise.all(workers);
  await relay.close();
}

main().catch((error) => {
  process.stderr.write(`replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
