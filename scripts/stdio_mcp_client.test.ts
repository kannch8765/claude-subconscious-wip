import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { openStdioMcpTools, StdioMcpClient } from './stdio_mcp_client.js';
import { runNativeClientToolConversation, type NativeClientTool } from './native_letta_backfill.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

interface FakeServerOptions {
  protocolVersion?: string;
  toolsCapability?: boolean;
  paginate?: boolean;
  slowInitialize?: boolean;
  toolMode?: 'echo' | 'crash' | 'hang' | 'is-error' | 'env';
  cancelMarker?: string;
  closeMarker?: string;
  stderrSecret?: string;
}

function fakeServer(options: FakeServerOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'stdio-mcp-test-'));
  roots.push(root);
  const script = join(root, 'server.mjs');
  writeFileSync(script, `
import * as readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const options = ${JSON.stringify(options)};
let initialized = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
const tool = (name, description = name) => ({name, description, inputSchema:{type:'object',additionalProperties:true}});
rl.on('line', async (line) => {
  const r = JSON.parse(line);
  if (r.method === 'notifications/initialized' && r.id === undefined) { initialized = true; return; }
  if (r.method === 'notifications/cancelled' && r.id === undefined) {
    if (options.cancelMarker) writeFileSync(options.cancelMarker, JSON.stringify(r.params));
    return;
  }
  const id = r.id ?? null;
  if (options.slowInitialize && r.method === 'initialize') return;
  if (r.method === 'initialize') return send({jsonrpc:'2.0',id,result:{
    protocolVersion: options.protocolVersion ?? '2025-06-18',
    capabilities: options.toolsCapability === false ? {} : {tools:{}},
    serverInfo:{name:'fake',version:'1'}
  }});
  if (r.method === 'tools/list') {
    if (!initialized) return send({jsonrpc:'2.0',id,error:{code:-32002,message:'not initialized'}});
    if (options.paginate && !r.params?.cursor) return send({jsonrpc:'2.0',id,result:{tools:[tool('echo','Echo one value')],nextCursor:'page-2'}});
    if (options.paginate && r.params?.cursor === 'page-2') return send({jsonrpc:'2.0',id,result:{tools:[tool('second','Second tool')]}});
    return send({jsonrpc:'2.0',id,result:{tools:[tool('echo','Echo one value')]}});
  }
  if (r.method === 'tools/call') {
    const mode = options.toolMode ?? 'echo';
    if (mode === 'crash') { process.stderr.write(options.stderrSecret ?? 'child-crash'); return process.exit(23); }
    if (mode === 'hang') return;
    if (mode === 'is-error') return send({jsonrpc:'2.0',id,result:{
      structuredContent:{code:'REMOTE_FAIL',detail:'bad input'},
      content:[{type:'text',text:'remote tool rejected input'}],
      isError:true
    }});
    if (mode === 'env') return send({jsonrpc:'2.0',id,result:{structuredContent:{
      leakedLettaApiKey: process.env.LETTA_API_KEY ?? null,
      explicitValue: process.env.EXPLICIT_MCP_TEST ?? null,
      pathPresent: Boolean(process.env.PATH)
    }}});
    return send({jsonrpc:'2.0',id,result:{structuredContent:{echoed:r.params.arguments.value}}});
  }
});
rl.on('close', () => {
  if (options.closeMarker) writeFileSync(options.closeMarker, 'stdin-closed');
});
`);
  return script;
}

async function waitForFile(path: string, timeoutMs = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('stdio MCP native client-tool bridge', () => {
  it('composes optional MCP tools around the current identity-grounding relationship inventory', () => {
    const worker = readFileSync(join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(worker).toContain('openStdioMcpToolsFromEnvironment(log)');
    expect(worker).toContain('const liveTools = [...relationshipTools, ...mcpTools]');
    expect(worker).toContain('tools: liveTools');
    expect(worker).toContain('requiredClientToolNames: []');
    expect(worker).not.toContain("requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : []");
    expect(worker).toContain("enum: ['foreground_grounding', 'maintenance']");
    expect(worker).toContain('foregroundGroundingIdentityAnchors(entitySearchObservations)');
    expect(worker).toContain('renderHistoricalMemoryWhisper(surfacedMemory.summary, snippets)');
    expect(worker).toContain('composeGroundedWhisper(historicalWindow, foregroundGroundingIdentityAnchors(entitySearchObservations))');
    expect(worker).toContain('await stdioMcp.close()');
  });

  it('completes MCP initialization before paginated tool discovery', async () => {
    const session = await openStdioMcpTools([{ name: 'demo', command: process.execPath, args: [fakeServer({ paginate: true })] }]);
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual(['mcp__demo__echo', 'mcp__demo__second']);
      await expect(session.tools[0].execute('call-1', { value: '喵' })).resolves.toEqual({ echoed: '喵' });
    } finally { await session.close(); }
  });

  it('fails open when protocol negotiation or required tools capability is incompatible', async () => {
    const logs: string[] = [];
    const wrongVersion = await openStdioMcpTools([{
      name: 'old', command: process.execPath, args: [fakeServer({ protocolVersion: '2024-11-05' })],
    }], (line) => logs.push(line));
    expect(wrongVersion.tools).toEqual([]);
    await wrongVersion.close();

    const noTools = await openStdioMcpTools([{
      name: 'notools', command: process.execPath, args: [fakeServer({ toolsCapability: false })],
    }], (line) => logs.push(line));
    expect(noTools.tools).toEqual([]);
    await noTools.close();
    expect(logs.join('\n')).toContain('unsupported protocol version');
    expect(logs.join('\n')).toContain('required tools capability');
  });

  it('does not inherit live worker secrets unless the operator explicitly configures them', async () => {
    const previous = process.env.LETTA_API_KEY;
    process.env.LETTA_API_KEY = 'WORKER_SECRET_MUST_NOT_CROSS';
    const session = await openStdioMcpTools([{
      name: 'env', command: process.execPath, args: [fakeServer({ toolMode: 'env' })], env: { EXPLICIT_MCP_TEST: 'operator-value' },
    }]);
    try {
      const result = await session.tools[0].execute('env-1', {}) as any;
      expect(result).toEqual({ leakedLettaApiKey: null, explicitValue: 'operator-value', pathPresent: true });
    } finally {
      await session.close();
      if (previous === undefined) delete process.env.LETTA_API_KEY;
      else process.env.LETTA_API_KEY = previous;
    }
  });

  it('keeps raw child stderr out of the model-visible unavailable result', async () => {
    const secret = 'SUPER_SECRET_STDERR_VALUE';
    const logs: string[] = [];
    const session = await openStdioMcpTools([{
      name: 'fragile', command: process.execPath, args: [fakeServer({ toolMode: 'crash', stderrSecret: secret })], callTimeoutMs: 300,
    }], (line) => logs.push(line));
    try {
      const result = await session.tools[0].execute('call-2', { value: 'x' }) as any;
      expect(result).toEqual({ status: 'unavailable', server: 'fragile', tool: 'echo', reason: 'stdio MCP tool call unavailable' });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(logs.join('\n')).toContain(secret);
    } finally { await session.close(); }
  });

  it('sends notifications/cancelled when a tools/call times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stdio-mcp-cancel-'));
    roots.push(root);
    const marker = join(root, 'cancel.json');
    const session = await openStdioMcpTools([{
      name: 'slow', command: process.execPath, args: [fakeServer({ toolMode: 'hang', cancelMarker: marker })], callTimeoutMs: 50,
    }]);
    try {
      const result = await session.tools[0].execute('call-timeout', { value: 'x' }) as any;
      expect(result.status).toBe('unavailable');
      await waitForFile(marker);
      const cancellation = JSON.parse(readFileSync(marker, 'utf8'));
      expect(cancellation.requestId).toEqual(expect.any(Number));
      expect(cancellation.reason).toContain('tools/call timed out');
    } finally { await session.close(); }
  });

  it('preserves MCP isError with structuredContent as model-visible tool-error data', async () => {
    const session = await openStdioMcpTools([{
      name: 'demo', command: process.execPath, args: [fakeServer({ toolMode: 'is-error' })],
    }]);
    try {
      await expect(session.tools[0].execute('bad-call', {})).resolves.toEqual({
        isError: true,
        structuredContent: { code: 'REMOTE_FAIL', detail: 'bad input' },
        content: [{ type: 'text', text: 'remote tool rejected input' }],
      });
    } finally { await session.close(); }
  });

  it('keeps MCP isError visible through the native Letta approval loop without failing the optional batch', async () => {
    const session = await openStdioMcpTools([{
      name: 'demo', command: process.execPath, args: [fakeServer({ toolMode: 'is-error' })],
    }]);
    const memorySearch: NativeClientTool = {
      name: 'memory_search', description: 'native memory search', parameters: { type: 'object' },
      async execute() { return { results: ['native-ok'] }; },
    };
    let round = 0;
    const fakeClient: any = {
      conversations: { messages: { create: async (_conversationId: string, body: any) => {
        const current = round++;
        async function* stream() {
          if (current === 0) {
            yield { message_type: 'approval_request_message', tool_calls: [
              { id: 'native-1', function: { name: 'memory_search', arguments: JSON.stringify({ query: '晴 bug' }) } },
              { id: 'mcp-1', function: { name: 'mcp__demo__echo', arguments: '{}' } },
            ] };
            return;
          }
          const mcpReturn = body.messages[0].tool_returns.find((item: any) => item.tool_call_id === 'mcp-1');
          expect(mcpReturn.status).toBe('success');
          expect(JSON.parse(mcpReturn.tool_return)).toMatchObject({ isError: true, structuredContent: { code: 'REMOTE_FAIL' } });
          yield { message_type: 'assistant_message', content: 'corrected after MCP tool error' };
          yield { message_type: 'stop_reason', stop_reason: 'end_turn' };
        }
        return stream();
      } } },
    };
    try {
      const result = await runNativeClientToolConversation({
        client: fakeClient, agentId: 'agent', conversationId: 'conv', message: 'turn',
        tools: [memorySearch, ...session.tools], requiredClientToolNames: ['memory_search'],
      });
      expect(result.clientToolFailure).toBe(false);
    } finally { await session.close(); }
  });

  it('fails open when one MCP cannot initialize so native tools remain independently usable', async () => {
    const logs: string[] = [];
    const session = await openStdioMcpTools([{
      name: 'bad', command: process.execPath, args: [fakeServer({ slowInitialize: true })], startupTimeoutMs: 50,
    }], (line) => logs.push(line));
    expect(session.tools).toEqual([]);
    expect(logs.join('\n')).toContain('continuing without it');
    await session.close();
  });

  it('closes stdin first and lets a cooperative stdio server exit gracefully', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stdio-mcp-close-'));
    roots.push(root);
    const marker = join(root, 'closed.txt');
    const client = new StdioMcpClient({ name: 'graceful', command: process.execPath, args: [fakeServer({ closeMarker: marker })] });
    await client.start();
    const pid = client.pid!;
    await client.close();
    await waitForFile(marker);
    expect(readFileSync(marker, 'utf8')).toBe('stdin-closed');
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
