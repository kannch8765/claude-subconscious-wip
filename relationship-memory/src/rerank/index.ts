import * as fs from 'fs';

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  index: number;
  score: number;
}

export interface Reranker {
  readonly model: string;
  rank(
    documents: readonly RerankDocument[],
    query: string,
    options?: { topN?: number; instruction?: string },
  ): Promise<RerankResult[]>;
}

export const DEFAULT_QWEN_RERANK_MODEL = 'qwen3-rerank';
export const DEFAULT_QWEN_RERANK_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
export const DEFAULT_QWEN_RERANK_INSTRUCTION = 'Retrieve semantically similar text.';
const DEFAULT_RERANK_TIMEOUT_MS = 8_000;

function cleanPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0) return fallback;
  return Math.min(value as number, max);
}

function readSecretFile(file: string): string {
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`Rerank API key file is empty: ${file}`);
  return value;
}

class RerankProviderRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Rerank provider failed (${status}, ${code}): ${message}`.slice(0, 500));
    this.name = 'RerankProviderRequestError';
  }
}

function providerError(status: number, payload: unknown): Error {
  const outer = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const nested = outer.error && typeof outer.error === 'object' && !Array.isArray(outer.error) ? outer.error as Record<string, unknown> : {};
  const code = typeof outer.code === 'string' ? outer.code : typeof nested.code === 'string' ? nested.code : 'unknown_error';
  const message = typeof outer.message === 'string' ? outer.message : typeof nested.message === 'string' ? nested.message : 'Rerank provider request failed.';
  return new RerankProviderRequestError(status, code, message);
}

export class DashScopeQwenReranker implements Reranker {
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly instruction: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    apiKey: string;
    endpoint: string;
    model?: string;
    instruction?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!options.endpoint.trim()) throw new Error('DashScope qwen rerank endpoint must be non-empty.');
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint.trim();
    this.model = options.model?.trim() || DEFAULT_QWEN_RERANK_MODEL;
    this.instruction = options.instruction?.trim() || DEFAULT_QWEN_RERANK_INSTRUCTION;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = cleanPositiveInteger(options.timeoutMs, DEFAULT_RERANK_TIMEOUT_MS, 30_000);
  }

  async rank(
    documents: readonly RerankDocument[],
    query: string,
    options: { topN?: number; instruction?: string } = {},
  ): Promise<RerankResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || documents.length === 0) return [];
    if (documents.length > 500) throw new Error('qwen3-rerank accepts at most 500 documents per request.');
    const topN = cleanPositiveInteger(options.topN, documents.length, documents.length);
    const instruction = options.instruction?.trim() || this.instruction;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('rerank request timeout')), this.timeoutMs);
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: normalizedQuery,
          documents: documents.map((document) => document.text),
          top_n: topN,
          ...(instruction ? { instruct: instruction } : {}),
        }),
        signal: controller.signal,
      });
      let payload: any;
      try { payload = await response.json(); } catch { payload = {}; }
      if (!response.ok) throw providerError(response.status, payload);
      const rawResults = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.output?.results) ? payload.output.results : [];
      const seen = new Set<number>();
      const results: RerankResult[] = [];
      for (const item of rawResults) {
        const index = item?.index;
        const score = item?.relevance_score;
        if (!Number.isInteger(index) || index < 0 || index >= documents.length || seen.has(index)) continue;
        if (typeof score !== 'number' || !Number.isFinite(score)) continue;
        seen.add(index);
        results.push({ id: documents[index].id, index, score });
      }
      if (results.length === 0) throw new Error('Rerank provider returned no valid results.');
      return results.sort((a, b) => b.score - a.score || a.index - b.index);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createRerankerFromEnvironment(): Reranker | undefined {
  const providerName = process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER?.trim();
  if (!providerName) return undefined;
  if (providerName !== 'dashscope-qwen') throw new Error(`Unsupported relationship-memory rerank provider: ${providerName}`);
  const keyFile = process.env.RELATIONSHIP_MEMORY_RERANK_API_KEY_FILE?.trim()
    || process.env.RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE?.trim();
  if (!keyFile) {
    throw new Error('RELATIONSHIP_MEMORY_RERANK_API_KEY_FILE or RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE is required when reranking is enabled.');
  }
  const endpoint = process.env.RELATIONSHIP_MEMORY_RERANK_ENDPOINT?.trim() || DEFAULT_QWEN_RERANK_ENDPOINT;
  return new DashScopeQwenReranker({
    apiKey: readSecretFile(keyFile),
    endpoint,
    model: process.env.RELATIONSHIP_MEMORY_RERANK_MODEL?.trim() || DEFAULT_QWEN_RERANK_MODEL,
    instruction: process.env.RELATIONSHIP_MEMORY_RERANK_INSTRUCTION?.trim() || DEFAULT_QWEN_RERANK_INSTRUCTION,
    timeoutMs: Number.parseInt(process.env.RELATIONSHIP_MEMORY_RERANK_TIMEOUT_MS ?? '', 10) || DEFAULT_RERANK_TIMEOUT_MS,
  });
}
