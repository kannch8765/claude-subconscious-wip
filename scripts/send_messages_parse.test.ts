import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

describe('Stop hook executable syntax', () => {
  it('transpiles and exits cleanly when live mode is disabled', () => {
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const script = path.join(process.cwd(), 'scripts', 'send_messages_to_letta.ts');
    const result = spawnSync(process.execPath, [tsxCli, script], {
      cwd: process.cwd(),
      env: { ...process.env, LETTA_MODE: 'off' },
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
