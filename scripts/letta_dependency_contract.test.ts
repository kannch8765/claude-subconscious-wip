import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Letta execution dependency contract', () => {
  it('pins the native API client used by backfill and realtime relationship observer lanes', () => {
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

    // The deprecated Code SDK package is still pinned for compatibility while this
    // task migrates the production observer execution path itself. No realtime or
    // legacy semantic runner may import it after this reconciliation.
    expect(packageJson.dependencies?.['@letta-ai/letta-code-sdk']).toBe('0.1.12');
    expect(lock.packages?.['node_modules/@letta-ai/letta-code-sdk']?.version).toBe('0.1.12');
  });

  it('keeps both semantic observer execution paths off the Letta Code subprocess SDK', () => {
    const legacyRunner = fs.readFileSync(path.resolve('scripts/legacy_semantic_observer_runner.ts'), 'utf8');
    const realtimeRunner = fs.readFileSync(path.resolve('scripts/relationship_observer_runner.ts'), 'utf8');
    const entrypoint = fs.readFileSync(path.resolve('scripts/legacy_semantic_backfill.ts'), 'utf8');
    const nativeAdapter = fs.readFileSync(path.resolve('scripts/native_letta_backfill.ts'), 'utf8');

    for (const source of [legacyRunner, realtimeRunner]) {
      expect(source).not.toContain('@letta-ai/letta-code-sdk');
      expect(source).not.toContain('resumeSession');
      expect(source).not.toContain('disableLettaCodeAutoUpdater');
    }
    expect(realtimeRunner).toContain('runNativeClientToolConversation');
    expect(realtimeRunner).toContain('unexpected server tools attached');
    expect(entrypoint).not.toContain('--cwd');
    expect(nativeAdapter).toContain("from '@letta-ai/letta-client'");
    expect(nativeAdapter).toContain("type: 'required_before_exit'");
    expect(nativeAdapter).toContain("type: 'exit_loop'");
  });
});
