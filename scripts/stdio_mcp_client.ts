import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { NativeClientTool } from './native_letta_backfill.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

export interface StdioMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface StdioMcpToolSession {
  tools: NativeClientTool[];
  close(): Promise<void>;
}

function positiveTimeout(value: unknown, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function toolName(serverName: string, remoteName: string): string {
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${sanitize(serverName)}__${sanitize(remoteName)}`;
}

function unwrapToolResult(value: any): unknown {
  if (!value || typeof value !== 'object') return value;
  if (value.structuredContent !== undefined) return value.structuredContent;
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
      .map((item: any) => item.text)
      .join('\n');
    if (text) return { ...(value.isError ? { isError: true } : {}), text };
  }
  return value;
}

export class StdioMcpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrTail: string[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private nextId = 1;
  private closed = false;

  constructor(readonly config: StdioMcpServerConfig) {}

  get pid(): number | undefined { return this.child?.pid; }

  private describeFailure(message: string): Error {
    const stderr = this.stderrTail.join('').trim();
    return new Error(stderr ? `${message}; stderr=${stderr.slice(-1000)}` : message);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  async start(): Promise<McpToolDescription[]> {
    if (this.child) throw new Error(`stdio MCP ${this.config.name} is already started`);
    this.closed = false;
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 32) this.stderrTail.shift();
    });
    child.once('error', (error) => this.rejectPending(this.describeFailure(`stdio MCP ${this.config.name} process error: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (this.closed) return;
      this.rejectPending(this.describeFailure(`stdio MCP ${this.config.name} exited unexpectedly (code=${String(code)}, signal=${String(signal)})`));
    });

    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      if (!line.trim()) return;
      let response: JsonRpcResponse;
      try { response = JSON.parse(line); }
      catch { return; }
      if (typeof response.id !== 'number') return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(this.describeFailure(`stdio MCP ${this.config.name} JSON-RPC error ${response.error.code ?? ''}: ${response.error.message ?? 'unknown error'}`));
      else pending.resolve(response.result);
    });

    const startupTimeout = positiveTimeout(this.config.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    try {
      await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-subconscious-native-client-tool-bridge', version: '1.0.0' },
      }, startupTimeout);
      const listed = await this.request('tools/list', {}, startupTimeout);
      if (!Array.isArray(listed?.tools)) throw new Error(`stdio MCP ${this.config.name} tools/list returned no tools array`);
      return listed.tools.filter((tool: any) => tool && typeof tool.name === 'string');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async call(remoteToolName: string, args: unknown): Promise<unknown> {
    const timeout = positiveTimeout(this.config.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    const result = await this.request('tools/call', { name: remoteToolName, arguments: args ?? {} }, timeout);
    return unwrapToolResult(result);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (!this.child || !this.child.stdin.writable || this.closed) {
      return Promise.reject(new Error(`stdio MCP ${this.config.name} is not available`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.describeFailure(`stdio MCP ${this.config.name} ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(this.describeFailure(`stdio MCP ${this.config.name} write failed: ${error.message}`));
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    this.rejectPending(new Error(`stdio MCP ${this.config.name} closed`));
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_CLOSE_TIMEOUT_MS));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function parseServerConfigs(raw: string): StdioMcpServerConfig[] {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SUBCON_STDIO_MCP_SERVERS_JSON must be a JSON object keyed by server name');
  return Object.entries(parsed).map(([name, value]) => {
    const config = value as any;
    if (!config || typeof config !== 'object' || typeof config.command !== 'string' || !config.command.trim()) {
      throw new Error(`stdio MCP config ${name} requires a non-empty command`);
    }
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((item: unknown) => typeof item !== 'string'))) {
      throw new Error(`stdio MCP config ${name}.args must be an array of strings`);
    }
    return { name, ...config } as StdioMcpServerConfig;
  });
}

export async function openStdioMcpTools(
  configs: readonly StdioMcpServerConfig[],
  log: (message: string) => void = () => {},
): Promise<StdioMcpToolSession> {
  const clients: StdioMcpClient[] = [];
  const tools: NativeClientTool[] = [];
  const names = new Set<string>();

  for (const config of configs) {
    const client = new StdioMcpClient(config);
    try {
      const listed = await client.start();
      const mapped: NativeClientTool[] = listed.map((remote) => {
        const name = toolName(config.name, remote.name);
        if (names.has(name)) throw new Error(`duplicate stdio MCP client tool name: ${name}`);
        names.add(name);
        return {
          name,
          description: remote.description?.trim() || `stdio MCP tool ${config.name}/${remote.name}`,
          parameters: remote.inputSchema && typeof remote.inputSchema === 'object'
            ? remote.inputSchema
            : { type: 'object', additionalProperties: true },
          async execute(_toolCallId: string, args: unknown) {
            try {
              return await client.call(remote.name, args);
            } catch (error) {
              return {
                status: 'unavailable',
                server: config.name,
                tool: remote.name,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
          },
        };
      });
      clients.push(client);
      tools.push(...mapped);
      log(`stdio MCP ${config.name} connected with tools: ${mapped.map((tool) => tool.name).join(', ') || '(none)'}`);
    } catch (error) {
      await client.close();
      log(`stdio MCP ${config.name} unavailable; continuing without it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    tools,
    async close() { await Promise.allSettled(clients.map((client) => client.close())); },
  };
}

export async function openStdioMcpToolsFromEnvironment(
  log: (message: string) => void = () => {},
): Promise<StdioMcpToolSession> {
  const raw = process.env.SUBCON_STDIO_MCP_SERVERS_JSON?.trim();
  if (!raw) return { tools: [], async close() {} };
  try {
    return await openStdioMcpTools(parseServerConfigs(raw), log);
  } catch (error) {
    log(`Invalid SUBCON_STDIO_MCP_SERVERS_JSON; continuing without stdio MCP tools: ${error instanceof Error ? error.message : String(error)}`);
    return { tools: [], async close() {} };
  }
}
