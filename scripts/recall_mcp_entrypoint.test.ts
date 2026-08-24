import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RECALL_TOOL } from './recall_mcp.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('recall MCP executable entrypoint', () => {
  it('starts through a symlinked plugin overlay path', () => {
    const overlay = mkdtempSync(join(tmpdir(), 'recall-mcp-overlay-'));
    roots.push(overlay);
    const scripts = join(overlay, 'scripts');
    mkdirSync(scripts);
    const linkedEntrypoint = join(scripts, 'recall_mcp.ts');
    symlinkSync(join(process.cwd(), 'scripts', 'recall_mcp.ts'), linkedEntrypoint);

    const input = [
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'symlink-regression', version: '1' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n');

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'hooks', 'silent-npx.cjs'), 'tsx', linkedEntrypoint],
      { cwd: process.cwd(), input, encoding: 'utf8', timeout: 5_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual(expect.objectContaining({
      id: 1,
      result: expect.objectContaining({
        serverInfo: expect.objectContaining({ name: 'claude-subconscious-relationship-memory-recall' }),
      }),
    }));
    expect(responses[1].result.tools).toEqual([RECALL_TOOL]);
  });
});
