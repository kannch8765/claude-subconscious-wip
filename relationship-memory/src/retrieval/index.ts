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
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface SemanticRetriever {
  rank(documents: SemanticDocument[], query: string): Promise<Map<string, number>>;
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
export const DEFAULT_QWEN_EMBEDDING_MODEL = 'qwen3.7-text-embedding';
export const DEFAULT_QWEN_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_SEMANTIC_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_SEMANTIC_LOCK_STALE_MS = 300_000;
const SEMANTIC_LOCK_POLL_MS = 25;

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

function providerError(status: number, payload: unknown): Error {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : 'unknown_error';
  const message = typeof record.message === 'string' ? record.message : 'Embedding provider request failed.';
  return new Error(`Embedding provider failed (${status}, ${code}): ${message}`.slice(0, 500));
}

export class DashScopeQwenEmbeddingProvider implements EmbeddingProvider {
  readonly fingerprint: string;
  readonly model: string;
  readonly dimensions: number;
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

  private async embed(texts: string[], textType: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > 20) throw new Error('DashScope qwen3.7-text-embedding accepts at most 20 texts per request.');
    const controller = new AbortController();
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
    }
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, 'document');
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text], 'query');
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
      const index = readIndex(this.indexFile, this.provider.fingerprint);
      const missing: SemanticDocument[] = [];
      for (const document of documents) {
        const contentHash = sha256(document.text);
        const cached = index.documents[document.id];
        if (!cached || cached.content_hash !== contentHash || cached.vector.length !== this.provider.dimensions || cached.vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))) missing.push(document);
      }
      for (let offset = 0; offset < missing.length; offset += 20) {
        const batch = missing.slice(offset, offset + 20);
        const vectors = await this.provider.embedDocuments(batch.map((document) => document.text));
        batch.forEach((document, indexInBatch) => {
          index.documents[document.id] = { content_hash: sha256(document.text), vector: vectors[indexInBatch] };
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

  async rank(documents: SemanticDocument[], query: string): Promise<Map<string, number>> {
    if (!query.trim() || documents.length === 0) return new Map();
    // Serialize derivative-cache refreshes across live MCP/Subcon processes. A waiter
    // re-reads the index after acquiring the lock, so already-built vectors are reused.
    const index = await this.ensureDocuments(documents);
    const queryVector = await this.provider.embedQuery(query);
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

export function lexicalTextScore(haystack: string, query: string | undefined): number {
  if (!query?.trim()) return 1;
  const normalized = haystack.toLowerCase();
  const exact = query.trim().toLowerCase();
  let score = normalized.includes(exact) ? 100 : 0;
  const queryTokens = [...new Set(exact.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((token) => token.length > 1);
  if (queryTokens.length === 0) return score;
  let matches = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) {
      matches += 1;
      score += token.length >= 5 ? 4 : 2;
    }
  }
  if (matches === 0) return score;
  return score + Math.round((matches / queryTokens.length) * 20);
}

export function hybridScore(lexicalScore: number, semanticScore: number | undefined): number {
  if (semanticScore === undefined || !Number.isFinite(semanticScore)) return lexicalScore;
  return lexicalScore + Math.max(-1, Math.min(1, semanticScore)) * 100;
}
