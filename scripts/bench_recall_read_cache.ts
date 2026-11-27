#!/usr/bin/env npx tsx
/**
 * Synthetic read-path benchmark for relationship-memory hybrid recall.
 *
 * Generates a made-up store and semantic index at roughly live scale (seeded
 * PRNG, random vectors, generated text; nothing is copied from a real store),
 * then times hybrid recall with a fake query embedder, so there is no network.
 * Every scenario runs in its own child process, so "cold" is a fresh process.
 *
 *   npx tsx scripts/bench_recall_read_cache.ts [--dir <path>] [--runs 15]
 *
 * Set RELATIONSHIP_MEMORY_READ_CACHE=off to time the uncached read path.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_KINDS } from '../relationship-memory/src/schema/index.js';
import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  CanonicalMemoryRecord,
  EvidenceRecord,
  ReinforcementRecord,
} from '../relationship-memory/src/schema/index.js';
import { FileBackedSemanticRetriever, type EmbeddingProvider } from '../relationship-memory/src/retrieval/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';

const DATASET_VERSION = 'bench-v2';
const SUBJECT_ID = 'bench-subject';
const SCALE = { memories: 2_200, evidence: 37_000, reinforcements: 3_000, intents: 120 };
const DIMENSIONS = 1024;
const SCENARIOS = ['index', 'recall1', 'recall4', 'append'] as const;
type Scenario = (typeof SCENARIOS)[number];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(text: string): number {
  return crypto.createHash('sha256').update(text).digest().readUInt32LE(0);
}

function vectorFor(text: string): number[] {
  const rand = mulberry32(seedFor(text));
  return Array.from({ length: DIMENSIONS }, () => rand() * 2 - 1);
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly fingerprint = 'bench-fake-provider-v1';
  readonly model = 'bench-fake';
  readonly dimensions = DIMENSIONS;
  readonly maxBatchSize = 100_000;
  async embedDocuments(texts: string[]): Promise<number[][]> { return texts.map((text) => vectorFor(`doc:${text}`)); }
  async embedQuery(text: string): Promise<number[]> { return vectorFor(`query:${text}`); }
}

/** Made-up vocabulary: ASCII pseudo-words plus runs of random Han code points. */
function vocabulary(rand: () => number): string[] {
  const consonants = 'bcdfghjklmnprstvwz';
  const vowels = 'aeiou';
  const words: string[] = [];
  for (let i = 0; i < 3_000; i += 1) {
    let word = '';
    const syllables = 1 + Math.floor(rand() * 3);
    for (let s = 0; s < syllables; s += 1) word += consonants[Math.floor(rand() * consonants.length)] + vowels[Math.floor(rand() * vowels.length)];
    words.push(word);
  }
  for (let i = 0; i < 3_000; i += 1) {
    const length = 2 + Math.floor(rand() * 3);
    words.push(Array.from({ length }, () => String.fromCodePoint(0x4e00 + Math.floor(rand() * 0x51a6))).join(''));
  }
  return words;
}

function textGenerator(rand: () => number, words: string[]): (minChars: number, maxChars: number) => string {
  return (minChars, maxChars) => {
    const target = minChars + Math.floor(rand() * (maxChars - minChars));
    const parts: string[] = [];
    let length = 0;
    while (length < target) {
      // Squared draw skews toward a head of common words, so queries hit lexically.
      const word = words[Math.floor(rand() * rand() * words.length)];
      parts.push(word);
      length += word.length + 1;
    }
    return parts.join(' ');
  };
}

function hexId(rand: () => number, prefix: string): string {
  let hex = '';
  for (let i = 0; i < 24; i += 1) hex += Math.floor(rand() * 16).toString(16);
  return `${prefix}_${hex}`;
}

function isoAt(rand: () => number): string {
  return new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 300 * 86_400_000)).toISOString();
}

function writeJsonl(file: string, records: unknown[]): void {
  fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
}

function datasetPaths(dir: string) {
  return { storeDir: path.join(dir, 'store'), indexFile: path.join(dir, 'semantic-index', 'index.json'), marker: path.join(dir, `${DATASET_VERSION}.ready`) };
}

async function generateDataset(dir: string): Promise<void> {
  const { storeDir, indexFile, marker } = datasetPaths(dir);
  if (fs.existsSync(marker)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(storeDir, { recursive: true });
  const rand = mulberry32(20261127);
  const words = vocabulary(rand);
  const text = textGenerator(rand, words);

  const memories: CanonicalMemoryRecord[] = Array.from({ length: SCALE.memories }, (_, index) => ({
    schema_version: 1,
    memory_id: hexId(rand, 'mem'),
    subject_id: SUBJECT_ID,
    kind: MEMORY_KINDS[index % MEMORY_KINDS.length],
    summary: text(60, 200),
    participants: rand() < 0.5 ? ['user'] : ['user', 'assistant'],
    payload: { detail: text(300, 900), context: text(100, 400), tags: [text(4, 12), text(4, 12)] },
    status: 'active',
    observed_at: isoAt(rand),
    created_at: isoAt(rand),
    source_key: hexId(rand, 'src'),
    dedupe_key: hexId(rand, 'dedupe'),
  }));
  const evidence: EvidenceRecord[] = Array.from({ length: SCALE.evidence }, () => ({
    evidence_id: hexId(rand, 'ev'),
    memory_id: memories[Math.floor(rand() * rand() * memories.length)].memory_id,
    conversation_id: hexId(rand, 'conv'),
    message_id: hexId(rand, 'msg'),
    role: rand() < 0.6 ? 'user' : 'assistant',
    quote: text(300, 900),
    captured_at: isoAt(rand),
    event_kind: rand() < 0.6 ? 'user_text' : 'assistant_text',
  }));
  const reinforcements: ReinforcementRecord[] = Array.from({ length: SCALE.reinforcements }, () => ({
    schema_version: 1,
    reinforcement_id: hexId(rand, 'reinf'),
    memory_id: memories[Math.floor(rand() * memories.length)].memory_id,
    batch_id: hexId(rand, 'batch'),
    evidence_ids: Array.from({ length: 2 + Math.floor(rand() * 4) }, () => evidence[Math.floor(rand() * evidence.length)].evidence_id),
    latest_evidence_at: isoAt(rand),
    recorded_at: isoAt(rand),
  }));
  const intents: AssistantRememberIntentRecord[] = Array.from({ length: SCALE.intents }, () => ({
    schema_version: 1,
    intent_id: hexId(rand, 'intent'),
    subject_id: SUBJECT_ID,
    session_id: hexId(rand, 'session'),
    assistant_message_id: hexId(rand, 'msg'),
    tool_use_id: hexId(rand, 'tool'),
    tool_name: 'remember',
    memory: { text: text(40, 160) },
    feel: { text: text(20, 80) },
    captured_at: isoAt(rand),
  }));
  const intentOutcomes: AssistantIntentOutcome[] = intents.map((intent) => ({
    intent_id: intent.intent_id,
    batch_id: hexId(rand, 'batch'),
    outcome: 'accepted',
    memory_id: memories[Math.floor(rand() * memories.length)].memory_id,
    recorded_at: isoAt(rand),
  }));

  writeJsonl(path.join(storeDir, 'memories.jsonl'), memories);
  writeJsonl(path.join(storeDir, 'evidence.jsonl'), evidence);
  writeJsonl(path.join(storeDir, 'reinforcements.jsonl'), reinforcements);
  writeJsonl(path.join(storeDir, 'assistant-intents.jsonl'), intents);
  writeJsonl(path.join(storeDir, 'assistant-intent-outcomes.jsonl'), intentOutcomes);

  // Build the index through the real prepare path, so every content hash matches
  // the documents that recall will rank.
  const store = new RelationshipMemoryStore(storeDir, SUBJECT_ID);
  const retriever = new FileBackedSemanticRetriever(new FakeEmbeddingProvider(), indexFile);
  await new RelationshipMemoryRuntime(store, new Map(), undefined, new Map(), false, retriever).prepareCurrentMemorySemanticIndex();
  fs.writeFileSync(marker, `${JSON.stringify({ queries: Array.from({ length: 64 }, () => text(8, 30)) })}\n`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function timed(operation: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

async function runChild(scenario: Scenario, dir: string, runs: number): Promise<void> {
  const source = datasetPaths(dir);
  let storeDir = source.storeDir;
  let workDir: string | undefined;
  if (scenario === 'append') {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-memory-bench-append-'));
    fs.cpSync(source.storeDir, path.join(workDir, 'store'), { recursive: true });
    storeDir = path.join(workDir, 'store');
  }
  const queries = (JSON.parse(fs.readFileSync(source.marker, 'utf8')) as { queries: string[] }).queries;
  const retriever = new FileBackedSemanticRetriever(new FakeEmbeddingProvider(), source.indexFile);
  // Recall sessions build a fresh read-only store and runtime for every recall.
  const runtime = () => new RelationshipMemoryRuntime(new RelationshipMemoryStore(storeDir, SUBJECT_ID, undefined, false), new Map(), undefined, new Map(), false, retriever);
  const recall = (query: string) => runtime().memorySearchRecallHybridWithEvidence({ query, limit: 10 });
  const rand = mulberry32(7);
  const words = vocabulary(rand);
  const text = textGenerator(rand, words);

  const once = async (run: number): Promise<number> => {
    switch (scenario) {
      case 'index':
        return timed(() => retriever.rankExisting!([{ id: 'memory:none', text: 'unused' }], queries[run % queries.length]));
      case 'recall1':
        return timed(() => recall(queries[run % queries.length]));
      case 'recall4':
        return timed(() => Promise.all([0, 1, 2, 3].map((offset) => recall(queries[(run * 4 + offset) % queries.length]))));
      case 'append': {
        if (run > 0) {
          // Another process appends one new memory plus its evidence between recalls.
          const memoryId = hexId(rand, 'mem');
          const memory: CanonicalMemoryRecord = {
            schema_version: 1, memory_id: memoryId, subject_id: SUBJECT_ID, kind: 'shared_experience', summary: text(60, 200),
            participants: ['user'], payload: { detail: text(300, 900) }, status: 'active', observed_at: isoAt(rand), created_at: isoAt(rand),
            source_key: hexId(rand, 'src'), dedupe_key: hexId(rand, 'dedupe'),
          };
          fs.appendFileSync(path.join(storeDir, 'memories.jsonl'), `${JSON.stringify(memory)}\n`);
          const lines = Array.from({ length: 15 }, () => `${JSON.stringify({
            evidence_id: hexId(rand, 'ev'), memory_id: memoryId, conversation_id: hexId(rand, 'conv'), message_id: hexId(rand, 'msg'),
            role: 'user', quote: text(150, 450), captured_at: isoAt(rand), event_kind: 'user_text',
          })}\n`).join('');
          fs.appendFileSync(path.join(storeDir, 'evidence.jsonl'), lines);
        }
        return timed(() => recall(queries[run % queries.length]));
      }
    }
  };

  try {
    const cold = await once(0);
    const warm: number[] = [];
    for (let run = 1; run <= runs; run += 1) warm.push(await once(run));
    const memory = process.memoryUsage();
    process.stdout.write(`${JSON.stringify({
      scenario, cold_ms: cold, warm_p50_ms: median(warm), warm_p95_ms: percentile(warm, 0.95),
      rss_mb: memory.rss / 1048576, heap_used_mb: memory.heapUsed / 1048576,
    })}\n`);
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = path.resolve(argValue('--dir') ?? path.join(os.tmpdir(), `relationship-memory-recall-bench-${DATASET_VERSION}`));
  const runs = Math.max(1, Number.parseInt(argValue('--runs') ?? '15', 10) || 15);
  const child = argValue('--child') as Scenario | undefined;
  if (child) return runChild(child, dir, runs);

  await generateDataset(dir);
  const sizes = fs.readdirSync(datasetPaths(dir).storeDir).filter((name) => name.endsWith('.jsonl'))
    .reduce((sum, name) => sum + fs.statSync(path.join(datasetPaths(dir).storeDir, name)).size, 0);
  console.log(`dataset ${dir}: store ${(sizes / 1048576).toFixed(1)} MB, index ${(fs.statSync(datasetPaths(dir).indexFile).size / 1048576).toFixed(1)} MB`);
  console.log(`read cache: ${process.env.RELATIONSHIP_MEMORY_READ_CACHE ?? '(default)'}; runs per scenario: ${runs}`);
  console.log('scenario  cold_ms  warm_p50_ms  warm_p95_ms  rss_mb  heap_used_mb');
  const self = fileURLToPath(import.meta.url);
  for (const scenario of SCENARIOS) {
    const result = spawnSync(process.execPath, [...process.execArgv, self, '--child', scenario, '--dir', dir, '--runs', String(runs)], { encoding: 'utf8', env: process.env });
    if (result.status !== 0) throw new Error(`scenario ${scenario} failed: ${result.stderr}`);
    const row = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, number | string>;
    const fmt = (key: string) => (row[key] as number).toFixed(1).padStart(key.length);
    console.log(`${String(row.scenario).padEnd(8)}  ${fmt('cold_ms')}  ${fmt('warm_p50_ms')}  ${fmt('warm_p95_ms')}  ${fmt('rss_mb')}  ${fmt('heap_used_mb')}`);
  }
}

await main();
