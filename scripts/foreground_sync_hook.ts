import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { findLatestUserMessageUuidForPrompt } from './transcript_utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

export interface ForegroundSyncHookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  context?: string;
  transcript_path?: string;
  hook_event_name?: string;
}

export interface ForegroundSyncCliInput {
  session_id: string;
  turn_id: string;
  cwd: string;
  prompt: string;
  context?: string;
  transcript_path?: string;
  timeout_ms: number;
  sync_started_at_ms: number;
}

export interface ForegroundSyncCliResult {
  status: 'whisper' | 'no_whisper' | 'failed' | 'timeout';
  whisper_id?: string;
  bundle_ready_ms?: number;
  resolve_recall_ms?: number;
  foreground_release_ms?: number;
  error?: string;
}

export interface ForegroundSyncHookResult extends ForegroundSyncCliResult {
  turn_id: string;
  message_id?: string;
  hook_elapsed_ms: number;
}

export type ForegroundSyncRunner = (input: ForegroundSyncCliInput) => Promise<ForegroundSyncCliResult>;

export function foregroundSyncV2Enabled(): boolean {
  const mode = process.env.SUBCON_FOREGROUND_SYNC_MODE?.trim().toLowerCase();
  return mode === 'v2' || mode === 'on' || mode === '1';
}

function isUserPrompt(input: ForegroundSyncHookInput | null | undefined): boolean {
  return input?.hook_event_name === 'UserPromptSubmit' || typeof input?.prompt === 'string';
}

export function resolveForegroundSyncIdentity(
  input: ForegroundSyncHookInput,
  nowNonce = crypto.randomUUID(),
): { turn_id: string; message_id?: string } {
  const sessionId = input.session_id?.trim() ?? '';
  const prompt = input.prompt?.trim() ?? '';
  const transcriptPath = input.transcript_path?.trim() ?? '';
  if (sessionId && prompt && transcriptPath) {
    try {
      const messageId = findLatestUserMessageUuidForPrompt(transcriptPath, prompt);
      if (messageId) return { turn_id: messageId, message_id: messageId };
    } catch {
      // Foreground recall is enrichment only. Exact transcript identity failure
      // falls back to an unbound turn rather than guessing a message association.
    }
  }
  const digest = crypto.createHash('sha256').update(`${sessionId}\0${prompt}\0${nowNonce}`).digest('hex').slice(0, 24);
  return { turn_id: `fg_turn_${digest}` };
}

function parseLastJsonLine(stdout: string): ForegroundSyncCliResult | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index]) as ForegroundSyncCliResult;
      if (['whisper', 'no_whisper', 'failed', 'timeout'].includes(parsed?.status)) return parsed;
    } catch {}
  }
  return null;
}

export async function runSyncSubconCli(input: ForegroundSyncCliInput): Promise<ForegroundSyncCliResult> {
  const tsxCli = path.join(PLUGIN_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(__dirname, 'sync_subcon.ts');
  if (!fs.existsSync(tsxCli)) return { status: 'failed', error: 'tsx runtime missing for foreground sync' };
  const hardTimeoutMs = Math.max(5_000, input.timeout_ms + 6_000);

  return await new Promise<ForegroundSyncCliResult>((resolve) => {
    const child = spawn(process.execPath, [tsxCli, script], {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ForegroundSyncCliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 32 * 1024) stderr += chunk; });
    child.once('error', (error) => finish({ status: 'failed', error: error.message.slice(0, 300) }));
    child.once('exit', (code) => {
      const parsed = parseLastJsonLine(stdout);
      if (parsed) return finish(parsed);
      const detail = stderr.trim().slice(-300);
      finish({ status: 'failed', error: detail || `sync_subcon exited ${code ?? 'unknown'}` });
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish({ status: 'timeout', error: 'foreground sync hard timeout' });
    }, hardTimeoutMs);
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export async function runForegroundSyncForHook(
  hookInput: ForegroundSyncHookInput | null,
  cwd: string,
  runner: ForegroundSyncRunner = runSyncSubconCli,
  timeoutMs = 30_000,
): Promise<ForegroundSyncHookResult | null> {
  if (!foregroundSyncV2Enabled() || !hookInput || !isUserPrompt(hookInput)) return null;
  const sessionId = hookInput.session_id?.trim() ?? '';
  const prompt = hookInput.prompt?.trim() ?? '';
  if (!sessionId || !prompt || !cwd.trim()) return null;
  const identity = resolveForegroundSyncIdentity(hookInput);
  const startedAt = Date.now();
  try {
    const result = await runner({
      session_id: sessionId,
      turn_id: identity.turn_id,
      cwd,
      prompt,
      ...(hookInput.context?.trim() ? { context: hookInput.context.trim() } : {}),
      ...(hookInput.transcript_path?.trim() ? { transcript_path: hookInput.transcript_path.trim() } : {}),
      timeout_ms: Math.max(250, Math.min(30_000, Math.round(timeoutMs))),
      sync_started_at_ms: startedAt,
    });
    return { ...result, turn_id: identity.turn_id, ...(identity.message_id ? { message_id: identity.message_id } : {}), hook_elapsed_ms: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'failed',
      turn_id: identity.turn_id,
      ...(identity.message_id ? { message_id: identity.message_id } : {}),
      hook_elapsed_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}
