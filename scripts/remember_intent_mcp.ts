#!/usr/bin/env npx tsx
import * as readline from 'readline';
import { validateRememberIntentInput } from '../relationship-memory/src/intent/index.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const TOOL = {
  name: 'remember',
  description: 'Use when you, the primary Claude Code assistant, decide in the moment that a relationship memory should be retained. Provide exactly what you want remembered and exactly how you feel now. This records only a transcript-visible intent; trusted backend processing performs canonicalization and deduplication later.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['memory', 'feel'],
    properties: {
      memory: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, description: 'Exact text of what you want to remember.' } },
      },
      feel: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, description: 'Exact contemporaneous feeling you want preserved with this remember intent.' } },
      },
    },
  },
};

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcRequest['id'], value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(request: JsonRpcRequest): void {
  const id = request.id ?? null;
  if (request.method === 'initialize') {
    result(id, {
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'claude-subconscious-remember-intent', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'ping') {
    result(id, {});
    return;
  }
  if (request.method === 'tools/list') {
    result(id, { tools: [TOOL] });
    return;
  }
  if (request.method === 'tools/call') {
    if (request.params?.name !== TOOL.name) {
      error(id, -32602, `Unknown tool: ${String(request.params?.name)}`);
      return;
    }
    const validation = validateRememberIntentInput(request.params?.arguments);
    if (!validation.ok) {
      result(id, {
        isError: true,
        content: [{ type: 'text', text: validation.reason ?? 'Invalid remember intent.' }],
      });
      return;
    }
    // Deliberately no durable write here. The real tool_use in Claude Code's
    // transcript is the source of truth and the Stop hook extracts it.
    result(id, {
      content: [{ type: 'text', text: 'Remember intent captured in the Claude Code transcript for trusted relationship-memory processing.' }],
    });
    return;
  }
  if (typeof request.id !== 'undefined') error(id, -32601, `Method not found: ${String(request.method)}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); }
  catch { error(null, -32700, 'Parse error'); }
});
