#!/usr/bin/env npx tsx
import * as readline from 'readline';
import type { RecallResult } from '../relationship-memory/src/recall/index.js';
import { recallFromEnvironment } from './recall_runtime.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export const RECALL_TOOL = {
  name: 'recall',
  description: 'Actively look through durable relationship memory and trusted Claude transcript history. Ask one natural-language question; the tool waits for a bounded read-only recall investigation and returns its synthesized answer in this Claude turn.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, description: 'Natural-language question about durable relationship memory or trusted Claude transcript history.' },
    },
  },
};

export type RecallInvoker = (query: string, signal?: AbortSignal) => Promise<RecallResult>;

function validQuery(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function toolResult(value: RecallResult): Record<string, unknown> {
  const text = value.status === 'ok'
    ? value.answer!
    : value.status === 'timeout'
      ? 'Recall timed out before a trusted answer was delivered.'
      : value.status === 'cancelled'
        ? 'Recall was cancelled before a trusted answer was delivered.'
        : `Recall failed: ${value.reason ?? 'unknown recall failure'}`;
  return {
    ...(value.status === 'failed' ? { isError: true } : {}),
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

export class RecallMcpServer {
  private readonly active = new Map<string | number, AbortController>();
  constructor(readonly invoke: RecallInvoker = recallFromEnvironment) {}

  async handle(request: JsonRpcRequest): Promise<unknown | undefined> {
    const id = request.id ?? null;
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-subconscious-relationship-memory-recall', version: '1.0.0' },
      } };
    }
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [RECALL_TOOL] } };
    if (request.method === 'notifications/cancelled') {
      const requestId = request.params?.requestId;
      if ((typeof requestId === 'string' || typeof requestId === 'number') && this.active.has(requestId)) {
        this.active.get(requestId)!.abort(new Error('MCP client cancelled recall'));
      }
      return undefined;
    }
    if (request.method === 'tools/call') {
      if (request.params?.name !== RECALL_TOOL.name) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(request.params?.name)}` } };
      }
      const args = request.params?.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => key !== 'query') || !validQuery(args.query)) {
        return { jsonrpc: '2.0', id, result: {
          isError: true,
          content: [{ type: 'text', text: 'recall requires exactly one non-empty natural-language query string.' }],
        } };
      }
      const controller = new AbortController();
      if (typeof id === 'string' || typeof id === 'number') this.active.set(id, controller);
      try {
        const recalled = await this.invoke(args.query.trim(), controller.signal);
        return { jsonrpc: '2.0', id, result: toolResult(recalled) };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: toolResult({
          status: 'failed',
          recall_id: 'recall_unstarted',
          reason: error instanceof Error ? error.message : String(error),
        }) };
      } finally {
        if (typeof id === 'string' || typeof id === 'number') this.active.delete(id);
      }
    }
    if (typeof request.id !== 'undefined') return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(request.method)}` } };
    return undefined;
  }
}

export function runRecallStdio(server = new RecallMcpServer()): void {
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    void (async () => {
      try {
        const response = await server.handle(JSON.parse(line));
        if (response !== undefined) send(response);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
    })();
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) runRecallStdio();
