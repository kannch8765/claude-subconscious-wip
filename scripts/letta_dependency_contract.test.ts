import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Letta Code SDK dependency contract', () => {
  it('pins the self-hosted-compatible SDK and CLI pair', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    expect(packageJson.dependencies?.['@letta-ai/letta-code-sdk']).toBe('0.1.12');
    expect(lock.packages?.['']?.dependencies?.['@letta-ai/letta-code-sdk']).toBe('0.1.12');
    expect(lock.packages?.['node_modules/@letta-ai/letta-code-sdk']?.version).toBe('0.1.12');
    expect(lock.packages?.['node_modules/@letta-ai/letta-code-sdk']?.dependencies?.['@letta-ai/letta-code']).toBe('0.18.3');
    expect(lock.packages?.['node_modules/@letta-ai/letta-code']?.version).toBe('0.18.3');
  });
});
