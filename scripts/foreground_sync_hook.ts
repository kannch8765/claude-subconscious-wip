import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { registerPendingForegroundRecallTurn, retractUnreleasedForegroundRecallReceipt } from './foreground_recall_state.js';
import { retractPendingSyncWhisperForTurn } from './subcon_whisper_queue.js';
import { readTranscriptUserTurnAnchor } from './transcript_utils.js';
import type { SyncDecisionTelemetry } from './send_worker_native.js';

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
  telemetry?: SyncDecisionTelemetry;
  error?: string;
}

export interface ForegroundSyncHookResult extends ForegroundSyncCliResult {
  turn_id: string;
  hook_elapsed_ms: number;
}

export type ForegroundSyncRunner = (input: ForegroundSyncCliInput) => Promise<ForegroundSyncCliResult>;

export interface SyncSubconCliLifecycleOptions {
  spawnChild?: typeof spawn;
  hardTimeoutMs?: number;
  killGraceMs?: number;
  finalGraceMs?: number;
}

export function foregroundSyncV2Enabled(): boolean {
  return process.env.SUBCON_FOREGROUND_SYNC_MODE?.trim().toLowerCase() === 'v2';
}

export function foregroundSyncV2Conflict(): string | undefined {
  if (!foregroundSyncV2Enabled()) return undefined;
  const legacyMode = process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_MODE?.trim().toLowerCase();
  const legacyReranker = process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER?.trim();
  if (legacyMode && legacyMode !== 'off') return `legacy sync-recall mode is still enabled (${legacyMode})`;
  if (legacyReranker) return `legacy rerank provider is still configured (${legacyReranker})`;
  return undefined;
}

function isUserPrompt(input: ForegroundSyncHookInput | null | undefined): boolean {
  return input?.hook_event_name === 'UserPromptSubmit' || typeof input?.prompt === 'string';
}

export function resolveForegroundSyncIdentity(
  input: ForegroundSyncHookInput,
  nowNonce = crypto.randomUUID(),
): { turn_id: string } {
  const sessionId = input.session_id?.trim() ?? '';
  const digest = crypto.createHash('sha256').update(`${sessionId}\0${nowNonce}`).digest('hex').slice(0, 24);
  // A foreground turn is intentionally independent from transcript identity.
  // Stop later binds this durable turn registration to the real transcript UUID
  // in session order, after Claude has durably written the user record.
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

export async function runSyncSubconCli(
  input: ForegroundSyncCliInput,
  lifecycle: SyncSubconCliLifecycleOptions = {},
): Promise<ForegroundSyncCliResult> {
  const tsxCli = path.join(PLUGIN_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(__dirname, 'sync_subcon.ts');
  if (!fs.existsSync(tsxCli)) return { status: 'failed', error: 'tsx runtime missing for foreground sync' };
  const hardTimeoutMs = lifecycle.hardTimeoutMs ?? Math.max(5_000, input.timeout_ms + 4_000);
  const killGraceMs = lifecycle.killGraceMs ?? 6_500;
  const finalGraceMs = lifecycle.finalGraceMs ?? 750;
  const spawnChild = lifecycle.spawnChild ?? spawn;

  return await new Promise<ForegroundSyncCliResult>((resolve) => {
    const child = spawnChild(process.execPath, [tsxCli, script], {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own a process group on Unix so the outer safety timeout can reap the
      // sync wrapper and any worker descendant if graceful cleanup itself hangs.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forcedTimeout = false;
    let killTimer: NodeJS.Timeout | undefined;
    let finalTimer: NodeJS.Timeout | undefined;
    const finish = (result: ForegroundSyncCliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 32 * 1024) stderr += chunk; });
    child.once('error', (error) => finish({ status: 'failed', error: error.message.slice(0, 300) }));
    child.once('exit', (code) => {
      if (forcedTimeout) return finish({ status: 'timeout', error: 'foreground sync hard timeout' });
      const parsed = parseLastJsonLine(stdout);
      if (parsed) return finish(parsed);
      const detail = stderr.trim().slice(-300);
      finish({ status: 'failed', error: detail || `sync_subcon exited ${code ?? 'unknown'}` });
    });
    const timer = setTimeout(() => {
      forcedTimeout = true;
      try { child.kill('SIGTERM'); } catch {}
      // sync_subcon owns cancellation/retraction on SIGTERM. Do not release the
      // hook while that cleanup is still running; escalate only inside the outer
      // hook budget, then fail open after the child is reaped or forcibly killed.
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
        finalTimer = setTimeout(() => finish({ status: 'timeout', error: 'foreground sync hard timeout' }), finalGraceMs);
      }, killGraceMs);
    }, hardTimeoutMs);
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function cleanupFailedForegroundSync(cwd: string, sessionId: string, turnId: string): void {
  try { retractPendingSyncWhisperForTurn(cwd, sessionId, turnId); } catch {}
  try { retractUnreleasedForegroundRecallReceipt(cwd, sessionId, turnId); } catch {}
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
  const conflict = foregroundSyncV2Conflict();
  if (conflict) {
    return { status: 'failed', turn_id: identity.turn_id, hook_elapsed_ms: Date.now() - startedAt, error: `foreground sync v2 refused: ${conflict}` };
  }
  try {
    // Publish ordering before model work. Stop binds these opaque foreground turn
    // IDs to authoritative transcript UUIDs only after the user record exists.
    const transcriptAnchor = hookInput.transcript_path
      ? readTranscriptUserTurnAnchor(hookInput.transcript_path)
      : { tail_role: 'none' as const };
    registerPendingForegroundRecallTurn(cwd, sessionId, identity.turn_id, transcriptAnchor);
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
    if (result.status === 'failed' || result.status === 'timeout') cleanupFailedForegroundSync(cwd, sessionId, identity.turn_id);
    return { ...result, turn_id: identity.turn_id, hook_elapsed_ms: Date.now() - startedAt };
  } catch (error) {
    cleanupFailedForegroundSync(cwd, sessionId, identity.turn_id);
    return {
      status: 'failed',
      turn_id: identity.turn_id,
      hook_elapsed_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}
