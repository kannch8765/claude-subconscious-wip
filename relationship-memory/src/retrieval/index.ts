import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
}

export interface SemanticRetriever {
  rank(documents: SemanticDocument[], query: string): Promise<Map<string, number>>;
  /**
   * Rank only vectors already present in the derivative index. This path never
   * refreshes or embeds documents and is intended for foreground read-only recall.
   */
  rankExisting?(documents: SemanticDocument[], query: string, signal?: AbortSignal): Promise<Map<string, number>>;
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
      const ordered = embeddings
        .map((entry: any, index: number) => ({ index: Number.isInteger(entry?.text_index) ? entry.text_index : index, vector: entry?.embedding }))
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((entry: { vector: unknown }) => entry.vector);
      if (ordered.length !== texts.length || ordered.some((vector: unknown) => !Array.isArray(vector) || vector.length !== this.dimensions || vector.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) {
        throw new Error('Embedding provider returned an invalid vector payload.');
      }
      return ordered as number[][];
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

function readIndex(file: string, fingerprint: string): SemanticIndexFileV1 {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SemanticIndexFileV1;
    if (raw?.schema_version === 1 && raw.provider_fingerprint === fingerprint && raw.documents && typeof raw.documents === 'object') return raw;
  } catch { /* derivative cache is rebuilt on any parse/version mismatch */ }
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

function writeProviderCooldown(indexFile: string, fingerprint: string, failure: { reason: EmbeddingProviderCooldownFileV1['reason']; code: string; durationMs: number }): void {
  const file = providerCooldownFile(indexFile, fingerprint);
  const now = Date.now();
  const value: EmbeddingProviderCooldownFileV1 = {
    schema_version: 1,
    provider_fingerprint: fingerprint,
    reason: failure.reason,
    code: failure.code,
    created_at: new Date(now).toISOString(),
    retry_after: new Date(now + failure.durationMs).toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch { }
}

function providerCooldownError(value: EmbeddingProviderCooldownFileV1): Error {
  const error = new Error(`Embedding provider is cooling down after ${value.reason} failure (${value.code}) until ${value.retry_after}.`);
  error.name = 'EmbeddingProviderCooldownError';
  return error;
}

function lockFile(indexFile: string): string {
  return `${indexFile}.lock`;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function readLockOwner(file: string): SemanticIndexLockOwner | undefined {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as SemanticIndexLockOwner;
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner.hostname !== 'string' || typeof owner.token !== 'string' || typeof owner.acquired_at !== 'string') return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

function lockLooksStale(file: string, staleMs: number): boolean {
  try {
    const owner = readLockOwner(file);
    const stat = fs.statSync(file);
    const oldEnough = Date.now() - stat.mtimeMs >= staleMs;
    if (!oldEnough) return false;
    if (!owner) return true;
    return owner.hostname === os.hostname() && !processExists(owner.pid);
  } catch {
    return false;
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireIndexLock(indexFile: string): Promise<() => void> {
  const file = lockFile(indexFile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const timeoutMs = positiveEnvMs('RELATIONSHIP_MEMORY_SEMANTIC_LOCK_TIMEOUT_MS', DEFAULT_SEMANTIC_LOCK_TIMEOUT_MS);
  const staleMs = positiveEnvMs('RELATIONSHIP_MEMORY_SEMANTIC_LOCK_STALE_MS', DEFAULT_SEMANTIC_LOCK_STALE_MS);
  const started = Date.now();
  const token = crypto.randomUUID();
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), token, acquired_at: new Date().toISOString() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if (readLockOwner(file)?.token === token) fs.rmSync(file, { force: true });
        } catch { }
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockLooksStale(file, staleMs)) {
        try { fs.rmSync(file, { force: true }); } catch { }
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for semantic index lock: ${file}`);
      await wait(SEMANTIC_LOCK_POLL_MS);
    }
  }
}

function documentHash(document: SemanticDocument): string {
  return sha256(document.text);
}

export class FileBackedSemanticRetriever implements SemanticRetriever {
  constructor(private readonly provider: EmbeddingProvider, private readonly indexFile: string) {}

  async rank(documents: SemanticDocument[], query: string): Promise<Map<string, number>> {
    if (documents.length === 0) return new Map();
    const cooldown = readProviderCooldown(this.indexFile, this.provider.fingerprint);
    if (cooldown) throw providerCooldownError(cooldown);
    const release = await acquireIndexLock(this.indexFile);
    try {
      let index = readIndex(this.indexFile, this.provider.fingerprint);
      const pending = documents.filter((document) => {
        const existing = index.documents[document.id];
        return !existing || existing.content_hash !== documentHash(document);
      });
      for (let start = 0; start < pending.length; start += this.provider.maxBatchSize) {
        const batch = pending.slice(start, start + this.provider.maxBatchSize);
        try {
          const vectors = await this.provider.embedDocuments(batch.map((item) => item.text));
          for (let i = 0; i < batch.length; i += 1) {
            index.documents[batch[i].id] = { content_hash: documentHash(batch[i]), vector: vectors[i] };
          }
          writeIndex(this.indexFile, index);
        } catch (error) {
          writeProviderCooldown(this.indexFile, this.provider.fingerprint, cooldownForProviderError(error));
          throw error;
        }
      }
    } finally {
      release();
    }
    const queryVector = await this.provider.embedQuery(query);
    const current = readIndex(this.indexFile, this.provider.fingerprint);
    const scores = new Map<string, number>();
    for (const document of documents) {
      const entry = current.documents[document.id];
      if (entry && entry.content_hash === documentHash(document)) scores.set(document.id, cosine(queryVector, entry.vector));
    }
    return scores;
  }

  async rankExisting(documents: SemanticDocument[], query: string, signal?: AbortSignal): Promise<Map<string, number>> {
    if (documents.length === 0) return new Map();
    const current = readIndex(this.indexFile, this.provider.fingerprint);
    const existing = documents.filter((document) => {
      const entry = current.documents[document.id];
      return entry && entry.content_hash === documentHash(document);
    });
    if (existing.length === 0) return new Map();
    const cooldown = readProviderCooldown(this.indexFile, this.provider.fingerprint);
    if (cooldown) throw providerCooldownError(cooldown);
    const queryVector = await this.provider.embedQuery(query, signal);
    const scores = new Map<string, number>();
    for (const document of existing) {
      const entry = current.documents[document.id];
      if (entry && entry.content_hash === documentHash(document)) scores.set(document.id, cosine(queryVector, entry.vector));
    }
    return scores;
  }
}

export function createSemanticRetrieverFromEnvironment(rootDir: string): SemanticRetriever | undefined {
  const provider = (process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return undefined;
  if (provider !== 'dashscope-qwen') throw new Error(`Unsupported relationship-memory embedding provider: ${provider}`);
  const keyFile = process.env.RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE?.trim();
  if (!keyFile) throw new Error('RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE is required for dashscope-qwen embeddings.');
  const embeddingProvider = new DashScopeQwenEmbeddingProvider({
    apiKey: readSecretFile(keyFile),
    endpoint: process.env.RELATIONSHIP_MEMORY_EMBEDDING_ENDPOINT?.trim() || DEFAULT_QWEN_EMBEDDING_ENDPOINT,
    model: process.env.RELATIONSHIP_MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_QWEN_EMBEDDING_MODEL,
    dimensions: boundedDimensions(process.env.RELATIONSHIP_MEMORY_EMBEDDING_DIMENSIONS),
    queryInstruction: process.env.RELATIONSHIP_MEMORY_EMBEDDING_QUERY_INSTRUCTION?.trim() || DEFAULT_QWEN_QUERY_INSTRUCTION,
  });
  const indexDir = process.env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR?.trim() || `${rootDir}-semantic-index`;
  return new FileBackedSemanticRetriever(embeddingProvider, path.join(indexDir, 'index.json'));
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

interface LexicalToken {
  value: string;
  weight: number;
}

const CJK_CHARACTER = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const MISSING_SEMANTIC_SCORE = -1;

function lexicalTokens(value: string): LexicalToken[] {
  const tokens: LexicalToken[] = [];
  let segment = '';
  let segmentKind: 'cjk' | 'word' | undefined;

  const flush = (): void => {
    if (!segmentKind || !segment) return;
    if (segmentKind === 'cjk') {
      const chars = Array.from(segment);
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.push({ value: `${chars[index]}${chars[index + 1]}`, weight: 2 });
      }
    } else if (segment.length > 1) {
      tokens.push({ value: segment, weight: segment.length >= 5 ? 4 : 2 });
    }
    segment = '';
    segmentKind = undefined;
  };

  for (const char of value.toLowerCase()) {
    const kind = CJK_CHARACTER.test(char) ? 'cjk' : LETTER_OR_NUMBER.test(char) ? 'word' : undefined;
    if (!kind) {
      flush();
      continue;
    }
    if (segmentKind && segmentKind !== kind) flush();
    segmentKind = kind;
    segment += char;
  }
  flush();

  const seen = new Set<string>();
  return tokens.filter((token) => {
    if (seen.has(token.value)) return false;
    seen.add(token.value);
    return true;
  });
}

export function lexicalTextScore(haystack: string, query: string | undefined): number {
  if (!query?.trim()) return 1;
  const normalized = haystack.toLowerCase();
  const exact = query.trim().toLowerCase();
  let score = normalized.includes(exact) ? 100 : 0;
  const queryTokens = lexicalTokens(exact);
  if (queryTokens.length === 0) return score;
  let matches = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token.value)) {
      matches += 1;
      score += token.weight;
    }
  }
  if (matches === 0) return score;
  return score + Math.round((matches / queryTokens.length) * 20);
}

export function hybridScore(lexicalScore: number, semanticScore: number | undefined): number {
  const resolvedSemanticScore = semanticScore === undefined || !Number.isFinite(semanticScore)
    ? MISSING_SEMANTIC_SCORE
    : semanticScore;
  return lexicalScore + Math.max(-1, Math.min(1, resolvedSemanticScore)) * 100;
}
