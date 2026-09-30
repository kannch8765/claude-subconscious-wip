import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  externalPromptContextFile,
  readExternalPromptContext,
} from './external_prompt_context.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-prompt-context-'));
  roots.push(root);
  return root;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeEnvelope(
  root: string,
  sessionId: string,
  prompt: string,
  context: string,
  overrides: Record<string, unknown> = {},
): string {
  const file = externalPromptContextFile(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = 1_800_000_000;
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1,
    kind: 'sticker_candidates',
    source: 'telegram',
    session_id: sessionId,
    prompt_sha256: sha256(prompt),
    context_sha256: sha256(context),
    context,
    created_at_unix: now - 1,
    expires_at_unix: now + 300,
    ...overrides,
  }));
  return file;
}

describe('external UserPromptSubmit context spool', () => {
  it('injects only the exact session + prompt envelope', () => {
    const root = temp();
    writeEnvelope(root, 'session-a', '猫猫开工', 'STICKER CONTEXT');
    expect(readExternalPromptContext(root, 'session-a', '猫猫开工', 1_800_000_000)).toBe('STICKER CONTEXT');
    expect(readExternalPromptContext(root, 'session-a', '别的 prompt', 1_800_000_000)).toBe('');
    expect(readExternalPromptContext(root, 'session-b', '猫猫开工', 1_800_000_000)).toBe('');
  });

  it('fails open on expired, malformed, or digest-mismatched artifacts', () => {
    const root = temp();
    const file = writeEnvelope(root, 'session-a', 'hello', 'context', { expires_at_unix: 1_799_999_999 });
    expect(readExternalPromptContext(root, 'session-a', 'hello', 1_800_000_000)).toBe('');

    writeEnvelope(root, 'session-a', 'hello', 'context', { context_sha256: '0'.repeat(64) });
    expect(readExternalPromptContext(root, 'session-a', 'hello', 1_800_000_000)).toBe('');

    fs.writeFileSync(file, '{');
    expect(readExternalPromptContext(root, 'session-a', 'hello', 1_800_000_000)).toBe('');
  });

  it('is read-only so the bridge remains the lifecycle owner', () => {
    const root = temp();
    const file = writeEnvelope(root, 'session-a', 'hello', 'context');
    expect(readExternalPromptContext(root, 'session-a', 'hello', 1_800_000_000)).toBe('context');
    expect(fs.existsSync(file)).toBe(true);
    expect(readExternalPromptContext(root, 'session-a', 'hello', 1_800_000_000)).toBe('context');
  });
});
