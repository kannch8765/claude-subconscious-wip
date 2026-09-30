import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_CONTEXT_CHARS = 12_000;
const HASH_RE = /^[0-9a-f]{64}$/;

interface ExternalPromptContextEnvelope {
  schema_version: 1;
  kind: 'sticker_candidates';
  source: 'telegram';
  session_id: string;
  prompt_sha256: string;
  context_sha256: string;
  context: string;
  created_at_unix: number;
  expires_at_unix: number;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function externalPromptContextSessionKey(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 24);
}

export function externalPromptContextFile(root: string, sessionId: string): string {
  return path.join(root, '.prompt-context', `session-${externalPromptContextSessionKey(sessionId)}.json`);
}

function validEnvelope(value: unknown): value is ExternalPromptContextEnvelope {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.schema_version === 1
    && item.kind === 'sticker_candidates'
    && item.source === 'telegram'
    && typeof item.session_id === 'string'
    && item.session_id.length > 0
    && typeof item.prompt_sha256 === 'string'
    && HASH_RE.test(item.prompt_sha256)
    && typeof item.context_sha256 === 'string'
    && HASH_RE.test(item.context_sha256)
    && typeof item.context === 'string'
    && item.context.length > 0
    && item.context.length <= MAX_CONTEXT_CHARS
    && typeof item.created_at_unix === 'number'
    && Number.isFinite(item.created_at_unix)
    && typeof item.expires_at_unix === 'number'
    && Number.isFinite(item.expires_at_unix)
  );
}

/**
 * Read one transport-authored prompt context without mutating its spool artifact.
 *
 * The Telegram bridge owns lifecycle/cleanup. This hook reader only accepts an
 * envelope that matches both the current Claude session and the exact triggering
 * prompt, so arming /sticker cannot leak into an unrelated PWA prompt.
 */
export function readExternalPromptContext(
  relationshipMemoryDir: string | undefined,
  sessionId: string | undefined,
  prompt: string | undefined,
  nowUnix: number = Date.now() / 1000,
): string {
  if (!relationshipMemoryDir || !sessionId || typeof prompt !== 'string' || !prompt) return '';
  const file = externalPromptContextFile(relationshipMemoryDir, sessionId);
  let raw: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ENVELOPE_BYTES) return '';
    raw = fs.readFileSync(file);
  } catch {
    return '';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return '';
  }
  if (!validEnvelope(parsed)) return '';
  if (parsed.session_id !== sessionId) return '';
  if (parsed.expires_at_unix <= nowUnix || parsed.created_at_unix > nowUnix + 60) return '';
  if (parsed.prompt_sha256 !== sha256(prompt)) return '';
  if (parsed.context_sha256 !== sha256(parsed.context)) return '';
  return parsed.context;
}
