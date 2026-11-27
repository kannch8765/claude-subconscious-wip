/**
 * OpenAI-compatible chat client for the own harness (docs/specs/OWN-HARNESS-DESIGN.md §5).
 *
 * The transport is pluggable: HTTP to OpenCode Go for the live harness, or a relay
 * process for offline replay. Retries 429 / 5xx / transport errors with backoff;
 * other 4xx are returned to the caller unchanged.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import type { EmbeddingProvider } from '../relationship-memory/src/retrieval/index.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

export interface TransportReply { status: number; body: any; ms: number; error?: string }

export interface ChatTransport {
  chat(body: ChatRequestBody, sessionId: string): Promise<TransportReply>;
  close?(): Promise<void>;
}

/**
 * Every model request is serialized here. A string cut inside a surrogate pair (half an emoji) would become a lone
 * `\uD83D` escape, which the upstream JSON parser rejects with a 400 for the whole request. Lone surrogates become
 * U+FFFD instead, whoever cut the string.
 */
export function requestJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'string' ? item.replace(LONE_SURROGATE, '\uFFFD') : item));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type ChatErrorClass = 'none' | 'rate_limited' | 'server' | 'client' | 'transport' | 'malformed';

export interface ChatResult {
  message?: ChatMessage;
  usage: ChatUsage;
  ms: number;
  attempts: number;
  status: number;
  errorClass: ChatErrorClass;
}

function classify(reply: TransportReply): ChatErrorClass {
  if (reply.status === 200) return reply.body?.choices?.[0]?.message ? 'none' : 'malformed';
  if (reply.status === 0) return 'transport';
  if (reply.status === 429) return 'rate_limited';
  if (reply.status >= 500) return 'server';
  return 'client';
}

export function readUsage(body: any): ChatUsage {
  const usage = body?.usage ?? {};
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

export async function chat(
  transport: ChatTransport,
  body: ChatRequestBody,
  sessionId: string,
  options: { maxAttempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ChatResult> {
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffMs = options.backoffMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let totalMs = 0;
  let last: TransportReply = { status: 0, body: undefined, ms: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await transport.chat(body, sessionId);
    totalMs += last.ms;
    const errorClass = classify(last);
    const retryable = errorClass === 'rate_limited' || errorClass === 'server' || errorClass === 'transport';
    if (!retryable || attempt === maxAttempts) {
      return {
        message: errorClass === 'none' ? last.body.choices[0].message as ChatMessage : undefined,
        usage: readUsage(last.body),
        ms: totalMs,
        attempts: attempt,
        status: last.status,
        errorClass,
      };
    }
    await sleep(backoffMs * 2 ** (attempt - 1));
  }
  throw new Error('unreachable');
}

/** Direct HTTP to an OpenAI-compatible endpoint (OpenCode Go needs a User-Agent and x-opencode-session). */
export class HttpChatTransport implements ChatTransport {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly userAgent = 'subcon-harness/0.1',
    private readonly timeoutMs = 180_000,
  ) {}

  async chat(body: ChatRequestBody, sessionId: string): Promise<TransportReply> {
    const started = Date.now();
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
          'x-opencode-session': sessionId,
        },
        body: requestJson(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 500) }; }
      return { status: response.status, body: parsed, ms: Date.now() - started };
    } catch (error) {
      return { status: 0, body: undefined, ms: Date.now() - started, error: error instanceof Error ? error.name : 'Error' };
    }
  }
}

/**
 * Line-delimited JSON relay over a child process (for example `ssh host python3 -u -c <relay>`),
 * so API keys stay on the remote host. One request per line, matched by id.
 */
export class RelayProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (reply: TransportReply) => void>();
  private next = 0;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let reply: any;
      try { reply = JSON.parse(line); } catch { return; }
      const resolve = this.pending.get(String(reply.id));
      if (!resolve) return;
      this.pending.delete(String(reply.id));
      resolve({ status: reply.status ?? 0, body: reply.body, ms: reply.ms ?? 0, error: reply.error });
    });
    this.child.on('exit', () => {
      for (const resolve of this.pending.values()) resolve({ status: 0, body: undefined, ms: 0, error: 'relay_exit' });
      this.pending.clear();
    });
  }

  request(payload: Record<string, unknown>): Promise<TransportReply> {
    const id = String(this.next++);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${requestJson({ id, ...payload })}\n`);
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((resolve) => this.child.once('exit', resolve));
  }
}

export class RelayChatTransport implements ChatTransport {
  constructor(private readonly relay: RelayProcess) {}

  chat(body: ChatRequestBody, sessionId: string): Promise<TransportReply> {
    return this.relay.request({ op: 'chat', session: sessionId, body });
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Query embeddings through the relay (keys stay remote). Documents are never embedded. */
export class RelayQueryEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'text-embedding-v4';
  readonly dimensions = 1024;
  readonly maxBatchSize = 10;
  constructor(readonly fingerprint: string, private readonly relay: RelayProcess) {}
  async embedDocuments(): Promise<number[][]> {
    throw new Error('the relay never embeds documents');
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
