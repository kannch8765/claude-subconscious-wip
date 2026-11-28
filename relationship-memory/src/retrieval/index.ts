import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emitRecallTimingSegment, monotonicNow } from '../recall/instrumentation.js';
import { readCacheEnabled, readJsonFileCached, registerReadCache } from '../store/read_cache.js';

export interface SemanticDocument {
  id: string;
  text: string;
}

export interface EmbeddingProvider {
  readonly fingerprint: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
  /** Several queries, one request per maxBatchSize chunk; vectors come back in input order. */
  embedQueries?(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface SemanticRankRequest {
  documents: SemanticDocument[];
  query: string;
}

export interface SemanticRetriever {
  rank(documents: SemanticDocument[], query: string): Promise<Map<string, number>>;
  /** Prepare/refresh derivative document vectors without embedding a query. */
  prepare?(documents: SemanticDocument[]): Promise<void>;
  /**
   * Rank only vectors already present in the derivative index. This path never
   * refreshes or embeds documents and is intended for foreground read-only recall.
   */
  rankExisting?(documents: SemanticDocument[], query: string, signal?: AbortSignal): Promise<Map<string, number>>;
  /**
   * rankExisting for several requests with one query embedding call. Each map equals
   * rankExisting(request.documents, request.query). A failed shared request rejects the whole call;
   * with per-query requests, a query whose request failed gets an empty map.
   */
  rankExistingMany?(requests: readonly SemanticRankRequest[], signal?: AbortSignal): Promise<Map<string, number>[]>;
}

interface SemanticIndexEntry {
  content_hash: string;
  vector: number[];
}

interface SemanticIndexFileV1 {
  schema_version: 1;
  provider_fingerprint: string;
  documents: Record<string, SemanticIndexEntry>;
}

export const DEFAULT_QWEN_QUERY_INSTRUCTION = 'Retrieve canonical relationship memories or identity records that describe the same underlying preference, shared experience, relationship event, inside joke, or identity as the query. Prefer semantic equivalence over surface word overlap.';
export const DEFAULT_QWEN_EMBEDDING_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
export const DEFAULT_QWEN_EMBEDDING_MODEL = 'text-embedding-v4';
export const DEFAULT_QWEN_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_SEMANTIC_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_SEMANTIC_LOCK_STALE_MS = 300_000;
const DEFAULT_EMBEDDING_QUOTA_COOLDOWN_MS = 86_400_000;
const DEFAULT_EMBEDDING_THROTTLE_COOLDOWN_MS = 60_000;
const DEFAULT_EMBEDDING_PROVIDER_COOLDOWN_MS = 30_000;
const SEMANTIC_LOCK_POLL_MS = 25;

interface EmbeddingProviderCooldownFileV1 {
  schema_version: 1;
  provider_fingerprint: string;
  reason: 'quota' | 'throttle' | 'provider';
  code: string;
  created_at: string;
  retry_after: string;
}

interface SemanticIndexLockOwner {
  pid: number;
  hostname: string;
  token: string;
  acquired_at: string;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

let contentHashGeneration = new Map<string, string>();
registerReadCache(() => { contentHashGeneration = new Map(); });

/**
 * A sha256 function for one pass over a document set. Recall re-hashes the same
 * texts on every query, so hashes from the previous pass are reused, and only the
 * texts hashed in this pass are kept for the next one. Memory therefore stays
 * bounded by the documents that actually have an index entry to compare against.
 */
function contentHasher(): (text: string) => string {
  if (!readCacheEnabled()) return sha256;
  const previous = contentHashGeneration;
  const next = new Map<string, string>();
  contentHashGeneration = next;
  return (text) => {
    const hash = next.get(text) ?? previous.get(text) ?? sha256(text);
    next.set(text, hash);
    return hash;
  };
}

// Only vectors parsed from index.json reach this check, and the cached index never
// mutates them, so a vector checked once stays valid for as long as it is alive.
const finiteVectors = new WeakSet<object>();

function usableVector(vector: number[], dimensions: number): boolean {
  if (vector.length !== dimensions) return false;
  const cache = readCacheEnabled();
  if (cache && finiteVectors.has(vector)) return true;
  if (vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return false;
  if (cache) finiteVectors.add(vector);
  return true;
}

function boundedDimensions(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_QWEN_EMBEDDING_DIMENSIONS;
}

function readSecretFile(file: string): string {
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`Embedding API key file is empty: ${file}`);
  return value;
}

class EmbeddingProviderRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Embedding provider failed (${status}, ${code}): ${message}`.slice(0, 500));
    this.name = 'EmbeddingProviderRequestError';
  }
}

function providerError(status: number, payload: unknown): Error {
  const outer = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const nested = outer.error && typeof outer.error === 'object' && !Array.isArray(outer.error) ? outer.error as Record<string, unknown> : {};
  const code = typeof outer.code === 'string' ? outer.code : typeof nested.code === 'string' ? nested.code : 'unknown_error';
  const message = typeof outer.message === 'string' ? outer.message : typeof nested.message === 'string' ? nested.message : 'Embedding provider request failed.';
  return new EmbeddingProviderRequestError(status, code, message);
}

function dashScopeBatchSize(model: string): number {
  if (model === 'text-embedding-v4' || model === 'text-embedding-v3') return 10;
  if (model === 'qwen3.7-text-embedding') return 20;
  return 10;
}

export class DashScopeQwenEmbeddingProvider implements EmbeddingProvider {
  readonly fingerprint: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly queryInstruction: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: {
    apiKey: string;
    endpoint?: string;
    model?: string;
    dimensions?: number;
    queryInstruction?: string;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_QWEN_EMBEDDING_ENDPOINT;
    this.model = options.model ?? DEFAULT_QWEN_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_QWEN_EMBEDDING_DIMENSIONS;
    this.maxBatchSize = dashScopeBatchSize(this.model);
    this.queryInstruction = options.queryInstruction ?? DEFAULT_QWEN_QUERY_INSTRUCTION;
    this.fetchFn = options.fetchFn ?? fetch;
    this.fingerprint = sha256(JSON.stringify({
      provider: 'dashscope-qwen',
      endpoint: this.endpoint,
      model: this.model,
      dimensions: this.dimensions,
      query_instruction: this.queryInstruction,
      document_format_version: 1,
    }));
  }

  private async embed(texts: string[], textType: 'document' | 'query', signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > this.maxBatchSize) throw new Error(`DashScope ${this.model} accepts at most ${this.maxBatchSize} texts per request.`);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('embedding request timeout')), 30_000);
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: { texts },
          parameters: {
            dimension: this.dimensions,
            output_type: 'dense',
            text_type: textType,
            ...(textType === 'query' ? { instruct: this.queryInstruction } : {}),
          },
        }),
        signal: controller.signal,
      });
      let payload: any;
      try { payload = await response.json(); } catch { payload = {}; }
      if (!response.ok) throw providerError(response.status, payload);
      const embeddings = Array.isArray(payload?.output?.embeddings) ? payload.output.embeddings : [];
      // One slot per input, filled by text_index, or by row position only when the field is absent. A text_index that
      // is present but not an integer, or a duplicate, out-of-range or missing slot, would hand one text another
      // text's vector, so it fails the whole payload.
      const slots: unknown[] = new Array(texts.length);
      const filled = new Set<number>();
      let positionsValid = embeddings.length === texts.length;
      embeddings.forEach((entry: any, position: number) => {
        const index: unknown = entry?.text_index === undefined ? position : entry.text_index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= texts.length || filled.has(index)) { positionsValid = false; return; }
        filled.add(index);
        slots[index] = entry?.embedding;
      });
      if (!positionsValid || filled.size !== texts.length || slots.some((vector) => !Array.isArray(vector) || vector.length !== this.dimensions || vector.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) {
        throw new Error('Embedding provider returned an invalid vector payload.');
      }
      return slots as number[][];
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, 'document');
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.embed([text], 'query', signal);
    return vector;
  }

  /** Chunks go out one after another, so a long list never bursts the rate limit; any failed chunk rejects the call. */
  async embedQueries(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
      vectors.push(...await this.embed(texts.slice(offset, offset + this.maxBatchSize), 'query', signal));
    }
    return vectors;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return -1;
  return dot / Math.sqrt(aa * bb);
}

function readIndexUncached(file: string, fingerprint: string): SemanticIndexFileV1 {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SemanticIndexFileV1;
    if (raw?.schema_version === 1 && raw.provider_fingerprint === fingerprint && raw.documents && typeof raw.documents === 'object') return raw;
  } catch { /* derivative cache is rebuilt on any parse/version mismatch */ }
  return { schema_version: 1, provider_fingerprint: fingerprint, documents: {} };
}

/** With the read cache on, the result may be the shared cached object: never mutate it. */
function readIndex(file: string, fingerprint: string): SemanticIndexFileV1 {
  if (!readCacheEnabled()) return readIndexUncached(file, fingerprint);
  const result = readJsonFileCached(file);
  const raw = result.ok ? result.value as SemanticIndexFileV1 : undefined;
  if (raw?.schema_version === 1 && raw.provider_fingerprint === fingerprint && raw.documents && typeof raw.documents === 'object') return raw;
  return { schema_version: 1, provider_fingerprint: fingerprint, documents: {} };
}

function writeIndex(file: string, value: SemanticIndexFileV1): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { }
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch { }
}

function positiveEnvMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function providerCooldownFile(indexFile: string, fingerprint: string): string {
  return `${indexFile}.provider-cooldown.${fingerprint}.json`;
}

function readProviderCooldown(indexFile: string, fingerprint: string): EmbeddingProviderCooldownFileV1 | undefined {
  const file = providerCooldownFile(indexFile, fingerprint);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as EmbeddingProviderCooldownFileV1;
    if (value?.schema_version !== 1 || value.provider_fingerprint !== fingerprint || !Number.isFinite(Date.parse(value.retry_after))) return undefined;
    if (Date.parse(value.retry_after) <= Date.now()) {
      try { fs.rmSync(file, { force: true }); } catch { }
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function cooldownForProviderError(error: unknown): { reason: EmbeddingProviderCooldownFileV1['reason']; code: string; durationMs: number } {
  if (error instanceof EmbeddingProviderRequestError) {
    if (error.status === 403 && error.code === 'AllocationQuota.FreeTierOnly') {
      return { reason: 'quota', code: error.code, durationMs: positiveEnvMs('RELATIONSHIP_MEMORY_EMBEDDING_QUOTA_COOLDOWN_MS', DEFAULT_EMBEDDING_QUOTA_COOLDOWN_MS) };
    }
    if (error.status === 429 || error.code.startsWith('Throttling')) {
      return { reason: 'throttle', code: error.code, durationMs: positiveEnvMs('RELATIONSHIP_MEMORY_EMBEDDING_THROTTLE_COOLDOWN_MS', DEFAULT_EMBEDDING_THROTTLE_COOLDOWN_MS) };
    }
    return { reason: 'provider', code: error.code, durationMs: positiveEnvMs('RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS', DEFAULT_EMBEDDING_PROVIDER_COOLDOWN_MS) };
  }
  const code = error instanceof Error ? error.name || 'provider_error' : 'provider_error';
  return { reason: 'provider', code, durationMs: positiveEnvMs('RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS', DEFAULT_EMBEDDING_PROVIDER_COOLDOWN_MS) };
}

function writeProviderCooldown(indexFile: string, fingerprint: string, error: unknown): EmbeddingProviderCooldownFileV1 {
  const policy = cooldownForProviderError(error);
  const now = Date.now();
  const value: EmbeddingProviderCooldownFileV1 = {
    schema_version: 1,
    provider_fingerprint: fingerprint,
    reason: policy.reason,
    code: policy.code,
    created_at: new Date(now).toISOString(),
    retry_after: new Date(now + policy.durationMs).toISOString(),
  };
  const file = providerCooldownFile(indexFile, fingerprint);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const current = readProviderCooldown(indexFile, fingerprint);
  if (current && Date.parse(current.retry_after) >= Date.parse(value.retry_after)) return current;
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch { }
  return value;
}

function assertProviderNotCoolingDown(indexFile: string, fingerprint: string): void {
  const cooldown = readProviderCooldown(indexFile, fingerprint);
  if (!cooldown) return;
  throw new Error(`Embedding provider cooldown active (${cooldown.reason}, ${cooldown.code}) until ${cooldown.retry_after}.`);
}

function semanticLockDir(indexFile: string): string {
  return `${indexFile}.lock`;
}

function semanticLockOwnerFile(indexFile: string): string {
  return path.join(semanticLockDir(indexFile), 'owner.json');
}

function semanticLockOwnerIsAlive(owner: SemanticIndexLockOwner): boolean {
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function recoverStaleSemanticLock(indexFile: string, staleMs: number): boolean {
  const lockDir = semanticLockDir(indexFile);
  let stat: fs.Stats;
  try { stat = fs.statSync(lockDir); } catch { return true; }

  let owner: SemanticIndexLockOwner | undefined;
  try { owner = JSON.parse(fs.readFileSync(semanticLockOwnerFile(indexFile), 'utf8')) as SemanticIndexLockOwner; }
  catch { owner = undefined; }

  const oldEnough = Date.now() - stat.mtimeMs >= staleMs;
  const deadOwner = owner
    ? Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string' && !semanticLockOwnerIsAlive(owner)
    : oldEnough;
  if (!deadOwner) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireSemanticLock(indexFile: string): Promise<string> {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true, mode: 0o700 });
  const timeoutMs = positiveEnvMs('RELATIONSHIP_MEMORY_SEMANTIC_LOCK_TIMEOUT_MS', DEFAULT_SEMANTIC_LOCK_TIMEOUT_MS);
  const staleMs = positiveEnvMs('RELATIONSHIP_MEMORY_SEMANTIC_LOCK_STALE_MS', DEFAULT_SEMANTIC_LOCK_STALE_MS);
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  while (true) {
    try {
      fs.mkdirSync(semanticLockDir(indexFile));
      const owner: SemanticIndexLockOwner = { pid: process.pid, hostname: os.hostname(), token, acquired_at: new Date().toISOString() };
      fs.writeFileSync(semanticLockOwnerFile(indexFile), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        try { fs.rmSync(semanticLockDir(indexFile), { recursive: true, force: true }); } catch { }
        throw new Error(`semantic index lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      recoverStaleSemanticLock(indexFile, staleMs);
      if (Date.now() >= deadline) throw new Error(`semantic index lock contention timed out after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(SEMANTIC_LOCK_POLL_MS, Math.max(1, deadline - Date.now()))));
    }
  }
}

function releaseSemanticLock(indexFile: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(semanticLockOwnerFile(indexFile), 'utf8')) as SemanticIndexLockOwner;
    if (owner.token !== token) throw new Error('semantic index lock ownership changed before release');
    fs.rmSync(semanticLockDir(indexFile), { recursive: true, force: false });
  } catch (error) {
    throw new Error(`semantic index lock release failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class FileBackedSemanticRetriever implements SemanticRetriever {
  constructor(readonly provider: EmbeddingProvider, readonly indexFile: string) {}

  private async ensureDocuments(documents: SemanticDocument[]): Promise<SemanticIndexFileV1> {
    const token = await acquireSemanticLock(this.indexFile);
    try {
      const current = readIndex(this.indexFile, this.provider.fingerprint);
      const hashOf = contentHasher();
      const missing: Array<{ document: SemanticDocument; contentHash: string }> = [];
      for (const document of documents) {
        const contentHash = hashOf(document.text);
        const cached = current.documents[document.id];
        if (!cached || cached.content_hash !== contentHash || !usableVector(cached.vector, this.provider.dimensions)) missing.push({ document, contentHash });
      }
      // Add entries to a private copy: the shared cached index must only ever hold
      // what is on disk, even if a later embedding batch or write fails.
      const index = missing.length > 0 && readCacheEnabled() ? { ...current, documents: { ...current.documents } } : current;
      for (let offset = 0; offset < missing.length; offset += this.provider.maxBatchSize) {
        assertProviderNotCoolingDown(this.indexFile, this.provider.fingerprint);
        const batch = missing.slice(offset, offset + this.provider.maxBatchSize);
        let vectors: number[][];
        try {
          vectors = await this.provider.embedDocuments(batch.map((item) => item.document.text));
        } catch (error) {
          writeProviderCooldown(this.indexFile, this.provider.fingerprint, error);
          throw error;
        }
        batch.forEach((item, indexInBatch) => {
          index.documents[item.document.id] = { content_hash: item.contentHash, vector: vectors[indexInBatch] };
        });
        // Checkpoint every successful provider batch. If a later batch fails, the next
        // search resumes from this durable boundary instead of re-billing prior texts.
        writeIndex(this.indexFile, index);
      }
      return index;
    } finally {
      releaseSemanticLock(this.indexFile, token);
    }
  }

  async prepare(documents: SemanticDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.ensureDocuments(documents);
  }

  /**
   * The documents whose index vector matches their current text. Missing vectors and content-hash
   * mismatches are lexical fallback signals, never permission for foreground recall to refresh embeddings.
   */
  private usableVectors(index: SemanticIndexFileV1, documents: readonly SemanticDocument[], hashOf: (text: string) => string): Array<readonly [string, number[]]> {
    return documents.flatMap((document) => {
      const cached = index.documents[document.id];
      if (!cached
        || cached.content_hash !== hashOf(document.text)
        || !usableVector(cached.vector, this.provider.dimensions)) return [];
      return [[document.id, cached.vector] as const];
    });
  }

  async rankExisting(documents: SemanticDocument[], query: string, signal?: AbortSignal): Promise<Map<string, number>> {
    if (!query.trim() || documents.length === 0) return new Map();
    assertProviderNotCoolingDown(this.indexFile, this.provider.fingerprint);
    const index = readIndex(this.indexFile, this.provider.fingerprint);
    const usable = this.usableVectors(index, documents, contentHasher());
    if (usable.length === 0) return new Map();
    let queryVector: number[];
    try {
      const embedStartedAt = monotonicNow();
      queryVector = await this.provider.embedQuery(query, signal);
      emitRecallTimingSegment('semantic_query_embedding_external', embedStartedAt, { usable_document_count: usable.length });
    } catch (error) {
      if (!signal?.aborted) writeProviderCooldown(this.indexFile, this.provider.fingerprint, error);
      throw error;
    }
    const localCompareStartedAt = monotonicNow();
    const ranked = new Map(usable.map(([id, vector]) => [id, cosine(queryVector, vector)]));
    emitRecallTimingSegment('semantic_local_vector_comparison', localCompareStartedAt, { usable_document_count: usable.length });
    return ranked;
  }

  async rankExistingMany(requests: readonly SemanticRankRequest[], signal?: AbortSignal): Promise<Map<string, number>[]> {
    // Same early outs as rankExisting, per request: a blank query or no documents never embeds.
    const active = requests.map(({ documents, query }) => Boolean(query.trim()) && documents.length > 0);
    if (!active.some(Boolean)) return requests.map(() => new Map());
    assertProviderNotCoolingDown(this.indexFile, this.provider.fingerprint);
    const index = readIndex(this.indexFile, this.provider.fingerprint);
    // One hashing pass for every request: the requests usually share most of their documents.
    const passHash = contentHasher();
    const hashes = new Map<string, string>();
    const hashOf = (text: string) => {
      let hash = hashes.get(text);
      if (hash === undefined) hashes.set(text, hash = passHash(text));
      return hash;
    };
    const usable = requests.map((request, position) => active[position] ? this.usableVectors(index, request.documents, hashOf) : []);
    const texts = [...new Set(requests.filter((_, position) => usable[position].length > 0).map((request) => request.query))];
    if (texts.length === 0) return requests.map(() => new Map());
    const embedStartedAt = monotonicNow();
    let vectors: Array<number[] | undefined>;
    if (this.provider.embedQueries) {
      // One shared request: if it fails, every query falls back.
      try {
        vectors = await this.provider.embedQueries(texts, signal);
        if (vectors.length !== texts.length) throw new Error('Embedding provider returned the wrong number of query vectors.');
      } catch (error) {
        if (!signal?.aborted) writeProviderCooldown(this.indexFile, this.provider.fingerprint, error);
        throw error;
      }
    } else {
      // Separate requests fail one query at a time, as parallel rankExisting calls do. Each query runs in its own
      // async boundary, so a synchronous throw, a rejection or a failed cooldown write gives only that query an empty
      // map (lexical fallback), and the queries that succeeded keep their vectors.
      vectors = await Promise.all(texts.map(async (text) => {
        try {
          return await this.provider.embedQuery(text, signal);
        } catch (error) {
          try {
            if (!signal?.aborted) writeProviderCooldown(this.indexFile, this.provider.fingerprint, error);
          } catch { /* the single call would fail this query too; it still falls back */ }
          return undefined;
        }
      }));
    }
    emitRecallTimingSegment('semantic_query_embedding_external_batch', embedStartedAt, {
      query_count: texts.length,
      request_count: this.provider.embedQueries ? Math.ceil(texts.length / this.provider.maxBatchSize) : texts.length,
      failed_query_count: vectors.filter((vector) => vector === undefined).length,
      // Distinct usable documents across all requests; the per-query comparison segments keep their own counts.
      usable_document_union_count: new Set(usable.flatMap((items) => items.map(([id]) => id))).size,
    });
    const queryVectors = new Map(texts.map((text, position) => [text, vectors[position]]));
    return requests.map((request, position) => {
      const queryVector = queryVectors.get(request.query);
      if (usable[position].length === 0 || !queryVector) return new Map();
      const localCompareStartedAt = monotonicNow();
      const ranked = new Map(usable[position].map(([id, vector]) => [id, cosine(queryVector, vector)]));
      emitRecallTimingSegment('semantic_local_vector_comparison', localCompareStartedAt, { usable_document_count: usable[position].length });
      return ranked;
    });
  }

  async rank(documents: SemanticDocument[], query: string): Promise<Map<string, number>> {
    if (!query.trim() || documents.length === 0) return new Map();
    assertProviderNotCoolingDown(this.indexFile, this.provider.fingerprint);
    // Serialize derivative-cache refreshes across live MCP/Subcon processes. A waiter
    // re-reads the index after acquiring the lock, so already-built vectors are reused.
    const index = await this.ensureDocuments(documents);
    assertProviderNotCoolingDown(this.indexFile, this.provider.fingerprint);
    let queryVector: number[];
    try {
      queryVector = await this.provider.embedQuery(query);
    } catch (error) {
      writeProviderCooldown(this.indexFile, this.provider.fingerprint, error);
      throw error;
    }
    return new Map(documents.map((document) => [document.id, cosine(queryVector, index.documents[document.id].vector)]));
  }
}

export function createSemanticRetrieverFromEnvironment(rootDir: string): SemanticRetriever | undefined {
  const providerName = process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER?.trim();
  if (!providerName) return undefined;
  if (providerName !== 'dashscope-qwen') throw new Error(`Unsupported relationship-memory embedding provider: ${providerName}`);
  const keyFile = process.env.RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE?.trim();
  if (!keyFile) throw new Error('RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE is required when semantic retrieval is enabled.');
  const provider = new DashScopeQwenEmbeddingProvider({
    apiKey: readSecretFile(keyFile),
    endpoint: process.env.RELATIONSHIP_MEMORY_EMBEDDING_ENDPOINT?.trim() || DEFAULT_QWEN_EMBEDDING_ENDPOINT,
    model: process.env.RELATIONSHIP_MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_QWEN_EMBEDDING_MODEL,
    dimensions: boundedDimensions(process.env.RELATIONSHIP_MEMORY_EMBEDDING_DIMENSIONS),
    queryInstruction: process.env.RELATIONSHIP_MEMORY_EMBEDDING_QUERY_INSTRUCTION?.trim() || DEFAULT_QWEN_QUERY_INSTRUCTION,
  });
  const indexDir = process.env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR?.trim() || `${rootDir}-semantic-index`;
  return new FileBackedSemanticRetriever(provider, path.join(indexDir, 'index.json'));
}

export function semanticText(...values: unknown[]): string {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) parts.push(normalized);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
  };
  values.forEach(collect);
  return parts.join('\n');
}

type LexicalTerm = { text: string; kind: 'latin' | 'cjk_bigram' };

function lexicalTerms(value: string): LexicalTerm[] {
  const normalized = value.toLowerCase();
  const terms: LexicalTerm[] = [];
  const seen = new Set<string>();
  const latin = normalized.match(/[\p{Script=Latin}\p{N}]+/gu) ?? [];
  for (const token of latin) {
    if (token.length <= 1 || seen.has(`latin:${token}`)) continue;
    seen.add(`latin:${token}`);
    terms.push({ text: token, kind: 'latin' });
  }
  const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーｰ]+/gu) ?? [];
  for (const run of cjkRuns) {
    const chars = Array.from(run);
    for (let index = 0; index < chars.length - 1; index += 1) {
      const bigram = `${chars[index]}${chars[index + 1]}`;
      if (seen.has(`cjk:${bigram}`)) continue;
      seen.add(`cjk:${bigram}`);
      terms.push({ text: bigram, kind: 'cjk_bigram' });
    }
  }
  return terms;
}

/**
 * Reuse the search tokenizer for local, API-free related-memory reranking.
 * Deduplicated token sets work for Latin terms and CJK character bigrams.
 */
export function lexicalTokenSet(value: string): ReadonlySet<string> {
  return new Set(lexicalTerms(value.normalize('NFKC')).map((term) => term.text));
}

export function lexicalTextScore(haystack: string, query: string | undefined): number {
  if (!query?.trim()) return 1;
  const normalized = haystack.toLowerCase();
  const exact = query.trim().toLowerCase();
  let score = normalized.includes(exact) ? 100 : 0;
  const queryTerms = lexicalTerms(exact);
  if (queryTerms.length === 0) return score;
  let matches = 0;
  for (const term of queryTerms) {
    if (normalized.includes(term.text)) {
      matches += 1;
      score += term.kind === 'latin' && term.text.length >= 5 ? 4 : 2;
    }
  }
  if (matches === 0) return score;
  return score + Math.round((matches / queryTerms.length) * 20);
}

export function hybridScore(lexicalScore: number, semanticScore: number | undefined): number {
  // Treat missing/invalid vectors as the most conservative semantic fallback so
  // a document with no semantic signal cannot outrank one with known similarity.
  const semantic = semanticScore === undefined || !Number.isFinite(semanticScore) ? -1 : semanticScore;
  return lexicalScore + Math.max(-1, Math.min(1, semantic)) * 100;
}
