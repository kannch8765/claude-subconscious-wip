import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Letta execution dependency contract', () => {
  it('pins the native API client used by legacy backfill while leaving the unrelated realtime Code SDK lane intact', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string; dependencies?: Record<string, string>; engines?: Record<string, string> }>;
    };

    expect(packageJson.engines?.node).toBe('>=20.0.0');
    expect(packageJson.dependencies?.['@letta-ai/letta-client']).toBe('1.12.1');
    expect(lock.packages?.['']?.dependencies?.['@letta-ai/letta-client']).toBe('1.12.1');
    expect(lock.packages?.['node_modules/@letta-ai/letta-client']?.version).toBe('1.12.1');

    // Task 093AG migrates only the historical semantic backfill path. The realtime
    // relationship observer still uses Letta Code and is intentionally not modernized here.
    expect(packageJson.dependencies?.['@letta-ai/letta-code-sdk']).toBe('0.1.12');
    expect(lock.packages?.['node_modules/@letta-ai/letta-code-sdk']?.version).toBe('0.1.12');
  });

  it('keeps the legacy backfill execution path off the Letta Code subprocess SDK', () => {
    const runner = fs.readFileSync(path.resolve('scripts/legacy_semantic_observer_runner.ts'), 'utf8');
    const entrypoint = fs.readFileSync(path.resolve('scripts/legacy_semantic_backfill.ts'), 'utf8');
    const nativeAdapter = fs.readFileSync(path.resolve('scripts/native_letta_backfill.ts'), 'utf8');

    expect(runner).not.toContain('@letta-ai/letta-code-sdk');
    expect(runner).not.toContain('resumeSession');
    expect(runner).not.toContain('disableLettaCodeAutoUpdater');
    expect(entrypoint).not.toContain('--cwd');
    expect(nativeAdapter).toContain("from '@letta-ai/letta-client'");
    expect(nativeAdapter).toContain("type: 'required_before_exit'");
    expect(nativeAdapter).toContain("type: 'exit_loop'");
  });
});
