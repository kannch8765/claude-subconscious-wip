import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRerankerFromEnvironment, DashScopeQwenReranker } from '../src/rerank/index.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const name of [
    'RELATIONSHIP_MEMORY_RERANK_PROVIDER',
    'RELATIONSHIP_MEMORY_RERANK_API_KEY_FILE',
    'RELATIONSHIP_MEMORY_RERANK_ENDPOINT',
    'RELATIONSHIP_MEMORY_RERANK_MODEL',
    'RELATIONSHIP_MEMORY_RERANK_INSTRUCTION',
    'RELATIONSHIP_MEMORY_RERANK_TIMEOUT_MS',
    'RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE',
  ]) delete process.env[name];
});

describe('relationship-memory reranker', () => {
  it('calls qwen3-rerank compatible API and preserves source document ids', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        model: 'qwen3-rerank',
        query: '猫又去萨莉亚了',
        documents: ['萨莉亚的鸡翅', '京都的礼物'],
        top_n: 2,
        instruct: 'Retrieve semantically similar text.',
      });
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-key');
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.27 },
        ],
        usage: { total_tokens: 42 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const reranker = new DashScopeQwenReranker({
      apiKey: 'secret-key',
      endpoint: 'https://workspace.example/compatible-api/v1/reranks',
      fetchFn: fetchFn as typeof fetch,
    });

    const result = await reranker.rank([
      { id: 'm1', text: '萨莉亚的鸡翅' },
      { id: 'm2', text: '京都的礼物' },
    ], '猫又去萨莉亚了');

    expect(result).toEqual([
      { id: 'm2', index: 1, score: 0.91 },
      { id: 'm1', index: 0, score: 0.27 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reuses the embedding key file when no dedicated rerank key file is configured', () => {
    const dir = temp('rm-rerank-env-');
    const keyFile = path.join(dir, 'dashscope.key');
    fs.writeFileSync(keyFile, 'shared-secret\n', { mode: 0o600 });
    process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER = 'dashscope-qwen';
    process.env.RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE = keyFile;
    process.env.RELATIONSHIP_MEMORY_RERANK_ENDPOINT = 'https://workspace.example/compatible-api/v1/reranks';

    const reranker = createRerankerFromEnvironment();

    expect(reranker).toBeInstanceOf(DashScopeQwenReranker);
    expect(reranker?.model).toBe('qwen3-rerank');
  });

  it('requires an explicit workspace/region endpoint instead of guessing one', () => {
    const dir = temp('rm-rerank-endpoint-');
    const keyFile = path.join(dir, 'dashscope.key');
    fs.writeFileSync(keyFile, 'shared-secret\n');
    process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER = 'dashscope-qwen';
    process.env.RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE = keyFile;

    expect(() => createRerankerFromEnvironment()).toThrow('RELATIONSHIP_MEMORY_RERANK_ENDPOINT is required');
  });
});
