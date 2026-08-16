import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStdioMcpTools, StdioMcpClient } from './stdio_mcp_client.js';
import { runNativeClientToolConversation, type NativeClientTool } from './native_letta_backfill.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fakeServer(mode: 'ok' | 'crash-call' | 'slow-start' = 'ok'): string {
  const root = mkdtempSync(join(tmpdir(), 'stdio-mcp-test-'));
  roots.push(root);
  const script = join(root, 'server.mjs');
  writeFileSync(script, `
import * as readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
rl.on('line', async (line) => {
  const r = JSON.parse(line); const id = r.id ?? null;
  if (mode === 'slow-start' && r.method === 'initialize') return;
  if (r.method === 'initialize') return send({jsonrpc:'2.0',id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}});
  if (r.method === 'tools/list') return send({jsonrpc:'2.0',id,result:{tools:[{name:'echo',description:'Echo one value',inputSchema:{type:'object',required:['value'],properties:{value:{type:'string'}}}}]}});
  if (r.method === 'tools/call') {
    if (mode === 'crash-call') return process.exit(23);
    return send({jsonrpc:'2.0',id,result:{structuredContent:{echoed:r.params.arguments.value}}});
  }
});
`);
  return script;
}

describe('stdio MCP native client-tool bridge', () => {
  it('composes optional MCP tools beside the existing native relationship inventory', () => {
    const worker = readFileSync(join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(worker).toContain('openStdioMcpToolsFromEnvironment(log)');
    expect(worker).toContain('const liveTools = [...relationshipTools, ...mcpTools]');
    expect(worker).toContain('tools: liveTools');
    expect(worker).toContain("requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : []");
    expect(worker).toContain('await stdioMcp.close()');
  });

  it('discovers namespaced tools and executes a real stdio tools/call', async () => {
    const session = await openStdioMcpTools([{ name: 'demo', command: process.execPath, args: [fakeServer()] }]);
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual(['mcp__demo__echo']);
      expect(session.tools[0].description).toBe('Echo one value');
      await expect(session.tools[0].execute('call-1', { value: '喵' })).resolves.toEqual({ echoed: '喵' });
    } finally { await session.close(); }
  });

  it('contains a tool-call process crash as an unavailable result instead of throwing into the live batch', async () => {
    const session = await openStdioMcpTools([{ name: 'fragile', command: process.execPath, args: [fakeServer('crash-call')], callTimeoutMs: 300 }]);
    try {
      const result = await session.tools[0].execute('call-2', { value: 'x' }) as any;
      expect(result.status).toBe('unavailable');
      expect(result.server).toBe('fragile');
      expect(result.tool).toBe('echo');
    } finally { await session.close(); }
  });

  it('fails open when one MCP cannot initialize so native tools can remain independently usable', async () => {
    const logs: string[] = [];
    const session = await openStdioMcpTools([{ name: 'bad', command: process.execPath, args: [fakeServer('slow-start')], startupTimeoutMs: 50 }], (line) => logs.push(line));
    expect(session.tools).toEqual([]);
    expect(logs.join('\n')).toContain('continuing without it');
    await session.close();
  });

  it('coexists with native client tools in the real Letta approval loop', async () => {
    const session = await openStdioMcpTools([{ name: 'demo', command: process.execPath, args: [fakeServer()] }]);
    const nativeCalls: unknown[] = [];
    const memorySearch: NativeClientTool = {
      name: 'memory_search', description: 'native memory search', parameters: { type: 'object' },
      async execute(_id, args) { nativeCalls.push(args); return { results: ['native-ok'] }; },
    };
    let round = 0;
    const fakeClient: any = {
      conversations: { messages: { create: async (_conversationId: string, body: any) => {
        const current = round++;
        async function* stream() {
          if (current === 0) {
            const names = body.client_tools.map((tool: any) => tool.name);
            expect(names).toContain('memory_search');
            expect(names).toContain('mcp__demo__echo');
            yield { message_type: 'approval_request_message', tool_calls: [
              { id: 'native-1', function: { name: 'memory_search', arguments: JSON.stringify({ query: '晴 bug' }) } },
              { id: 'mcp-1', function: { name: 'mcp__demo__echo', arguments: JSON.stringify({ value: 'bridge-ok' }) } },
            ] };
            return;
          }
          expect(body.messages[0].tool_returns).toEqual(expect.arrayContaining([
            expect.objectContaining({ tool_call_id: 'native-1', status: 'success' }),
            expect.objectContaining({ tool_call_id: 'mcp-1', status: 'success', tool_return: JSON.stringify({ echoed: 'bridge-ok' }) }),
          ]));
          yield { message_type: 'assistant_message', content: 'done' };
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
      expect(nativeCalls).toEqual([{ query: '晴 bug' }]);
    } finally { await session.close(); }
  });

  it('terminates the child with the worker-scoped session and can start cleanly again', async () => {
    const script = fakeServer();
    const first = new StdioMcpClient({ name: 'restartable', command: process.execPath, args: [script] });
    await first.start();
    const firstPid = first.pid!;
    await first.close();
    expect(() => process.kill(firstPid, 0)).toThrow();

    const second = new StdioMcpClient({ name: 'restartable', command: process.execPath, args: [script] });
    await second.start();
    expect(second.pid).not.toBe(firstPid);
    await expect(second.call('echo', { value: 'again' })).resolves.toEqual({ echoed: 'again' });
    await second.close();
  });
});
