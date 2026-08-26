#!/usr/bin/env npx tsx
/**
 * Synchronous foreground Subcon preflight.
 *
 * This is an additive lane: it creates an ephemeral Letta conversation for the
 * current foreground user turn, starts the native Subcon worker in mode=sync,
 * and returns as soon as a durable whisper checkpoint exists. The worker keeps
 * running to end_turn after that checkpoint. The normal Stop/async lane remains
 * unchanged and remains the sole owner of canonical relationship-memory writes.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { escapeXmlContent, getTempStateDir } from './conversation_utils.js';
import {
  cancelAndDeferSyncResources,
  cleanupCompletedSyncResources,
  createSyncConversation,
  createToolStrippedSyncAgent,
  cleanupOrDeferSyncAgentResources,
  reapDeferredSyncResources,
} from './sync_letta_resources.js';
import { removePendingSubconWhisper } from './subcon_whisper_queue.js';
import { retractUnreleasedForegroundRecallReceipt } from './foreground_recall_state.js';
import { contextualForegroundRecallQuery, readForegroundRecentTranscript, renderForegroundRecentTranscript } from './foreground_recent_context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TEMP_STATE_DIR = getTempStateDir();

interface SyncSubconInput {
  session_id: string;
  turn_id: string;
  cwd: string;
  prompt: string;
  context?: string;
  transcript_path?: string;
  timeout_ms?: number;
  sync_started_at_ms?: number;
}

type SyncStatus = 'whisper' | 'no_whisper' | 'failed' | 'timeout';

interface SyncCheckpoint {
  status: 'whisper' | 'no_whisper' | 'failed';
  whisper_id?: string;
  recorded_at?: string;
  bundle_ready_ms?: number;
  resolve_recall_ms?: number;
  telemetry?: {
    setup_ready_ms?: number;
    retrieval_ms?: number;
    candidate_count?: number;
    approval_round_count: number;
    expand_recall_count: number;
    entity_search_count: number;
    rounds: Array<{ round: number; stream_ms: number; requested_tools: string[]; stop_reason?: string }>;
    decision?: 'selected' | 'none';
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function cleanInput(raw: unknown): SyncSubconInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sync Subcon input must be an object');
  const value = raw as Record<string, unknown>;
  const sessionId = typeof value.session_id === 'string' ? value.session_id.trim() : '';
  const turnId = typeof value.turn_id === 'string' ? value.turn_id.trim() : '';
  const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  const context = typeof value.context === 'string' ? value.context.trim() : '';
  const transcriptPath = typeof value.transcript_path === 'string' ? value.transcript_path.trim() : '';
  const syncStartedAtMs = typeof value.sync_started_at_ms === 'number' && Number.isFinite(value.sync_started_at_ms) ? value.sync_started_at_ms : undefined;
  const timeout = typeof value.timeout_ms === 'number' && Number.isFinite(value.timeout_ms)
    ? Math.max(250, Math.min(30_000, Math.round(value.timeout_ms)))
    : 20_000;
  if (!sessionId || !turnId || !cwd || !prompt) throw new Error('session_id, turn_id, cwd, and prompt are required');
  return { session_id: sessionId, turn_id: turnId, cwd, prompt, ...(context ? { context } : {}), ...(transcriptPath ? { transcript_path: transcriptPath } : {}), timeout_ms: timeout, ...(syncStartedAtMs !== undefined ? { sync_started_at_ms: syncStartedAtMs } : {}) };
}

function syncBatchId(input: SyncSubconInput): string {
  const digest = crypto.createHash('sha256').update(`${input.session_id}\0${input.turn_id}`).digest('hex').slice(0, 24);
  return `sync_${digest}`;
}

function syncMessage(input: SyncSubconInput, recentTranscript = ''): string {
  const context = escapeXmlContent((input.context ?? '').slice(-8000));
  const prompt = escapeXmlContent(input.prompt);
  const recent = recentTranscript ? `\n${recentTranscript}` : '';
  return `<subcon_sync_foreground_turn>
<session_id>${escapeXmlContent(input.session_id)}</session_id>
<current_foreground_context>
${context}
</current_foreground_context>
<latest_user_message>
${prompt}
</latest_user_message>${recent}
<instructions>
This is the synchronous Subconscious mode immediately before foreground Kohaku receives <latest_user_message>.

- The runtime has already searched relationship memory for this turn and appends a trusted <foreground_recall_bundle> after this envelope. Review those candidates together with <latest_user_message>, the bounded current foreground context, and any <recent_foreground_transcript>. Candidate presence is only evidence availability, not relevance. Do not mechanically choose the top candidate.
- <recent_foreground_transcript> is source-faithful recent foreground transcript context used only to understand the current turn. It is NOT canonical relationship memory, does not imply that maintenance will remember/reinforce it, and can never itself be selected, quoted, or surfaced by resolve_recall. Only a surfaced canonical memory candidate may become a whisper.
- If the prefetched bundle is insufficient because a materially different historical concept is missing, you may call expand_recall once with one short atomic semantic query. Do not fan out or issue near-duplicate refinements. Normal sync turns should not need a search tool call.
- If a named referent is unresolved and its stable identity materially matters, you may call entity_search with purpose=foreground_grounding. Do not search identity merely because a name appears.
- Bundle candidates and expand_recall results include quote_snippets containing source-faithful historical excerpts. source_kind=transcript is a direct historical quote; source_kind=legacy_memory is only a fallback when no transcript evidence exists and is an older memory-record excerpt, not a direct quote.
- Finish recall by calling resolve_recall exactly once. Use decision=selected with one surfaced memory_id and 1-3 snippet_ids only when that past moment materially helps foreground Kohaku understand or answer the CURRENT user message. Otherwise use decision=none with no memory_id/snippet_ids.
- Prefer decision=none when overlap is incidental or the current message already explains the token in a non-memory role: code identifiers, filenames, quoted examples, test fixtures, prompt text, or another clearly present-tense technical object. Even an exact rare identifier match does not make a historical relationship memory relevant by itself.
- Retrieval itself supplies the association. Do not explain why this memory is relevant, what it means now, whether something was fulfilled or came full circle, how foreground Kohaku should feel, or what it proves about the relationship. Past Kohaku feelings/reactions may appear only as explicitly historical source evidence.
- decision=none is a first-class successful outcome, not a failure or missed opportunity.
- Never expose expand_recall, resolve_recall, IDs, snippet IDs, reinforce/remember/create/dedupe, archival status, or maintenance bookkeeping in foreground-visible prose.
- This sync mode does not own canonical relationship-memory mutation. The existing asynchronous Stop pass remains authoritative for long-term reinforcement/remember/entity maintenance. Continue this Letta turn normally until end_turn after resolve_recall; ordinary assistant prose is not foreground-visible.
</instructions>
</subcon_sync_foreground_turn>`;
}

function emit(status: SyncStatus, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ status, ...extra })}\n`);
}

function checkpoint(pathname: string): SyncCheckpoint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8')) as SyncCheckpoint;
    if (['whisper', 'no_whisper', 'failed'].includes(parsed?.status)) return parsed;
  } catch {}
  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ABORT_CANCEL_GRACE_MS = 750;

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true;
  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
  return Promise.race([exited, wait(timeoutMs).then(() => false)]);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (childExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 500)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 500);
}

async function main(): Promise<void> {
  const input = cleanInput(JSON.parse(await readStdin()));
  const timeoutMs = input.timeout_ms ?? 20_000;
  const syncStartedAtMs = input.sync_started_at_ms ?? Date.now();
  const apiKey = process.env.LETTA_API_KEY;
  const deadline = Date.now() + timeoutMs;
  if (!apiKey) throw new Error('LETTA_API_KEY is required for sync Subcon mode');
  fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });

  const batchId = syncBatchId(input);
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const payloadFile = path.join(TEMP_STATE_DIR, `sync-payload-${nonce}.json`);
  const checkpointFile = path.join(TEMP_STATE_DIR, `sync-checkpoint-${nonce}.json`);
  const workerScript = path.join(__dirname, 'send_worker_native.ts');
  const tsxCli = path.join(PLUGIN_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let syncAgentId: string | null = null;
  let syncBlockIds: string[] = [];
  let conversationId: string | null = null;
  let child: ChildProcess | null = null;
  let aborting = false;
  let setupSettledResolve!: () => void;
  const setupSettled = new Promise<void>((resolve) => { setupSettledResolve = resolve; });
  let setupMarkedSettled = false;
  const markSetupSettled = (): void => {
    if (setupMarkedSettled) return;
    setupMarkedSettled = true;
    setupSettledResolve();
  };

  const cleanupAbortedSync = async (): Promise<void> => {
    if (child && syncAgentId && conversationId) {
      // Once streaming started, the server-side Letta run can outlive the local
      // client stream. Cancel first and defer resource deletion; never delete a
      // conversation underneath a shielded run.
      await cancelAndDeferSyncResources(apiKey, conversationId, syncAgentId, syncBlockIds);
      if (!childExited(child) && !await waitForChildExit(child, ABORT_CANCEL_GRACE_MS)) await stopChild(child);
    } else if (conversationId && syncAgentId) {
      // Setup failed before the worker existed: no run can reference these
      // ephemeral resources, so immediate deletion is safe.
      await cleanupCompletedSyncResources(apiKey, conversationId, syncAgentId, syncBlockIds);
    } else if (syncAgentId) {
      await cleanupOrDeferSyncAgentResources(apiKey, syncAgentId, syncBlockIds);
    }
    removePendingSubconWhisper(input.cwd, input.session_id, batchId);
    // selected/none receipts are successful only after the release checkpoint.
    // If this wrapper aborts before that point, leave Stop free to fallback.
    retractUnreleasedForegroundRecallReceipt(input.cwd, input.session_id, input.turn_id);
    try { fs.unlinkSync(checkpointFile); } catch {}
    try { fs.unlinkSync(payloadFile); } catch {}
  };

  const abortOnSignal = (signal: NodeJS.Signals): void => {
    if (aborting) return;
    aborting = true;
    void (async () => {
      // Handlers are installed before any Letta create request. Creation calls
      // are bounded; give an in-flight setup request a chance to publish its ids
      // so cleanup can reclaim them instead of exiting in the ownership gap.
      await Promise.race([setupSettled, wait(6_500)]);
      await cleanupAbortedSync();
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    })();
  };
  process.once('SIGTERM', () => abortOnSignal('SIGTERM'));
  process.once('SIGINT', () => abortOnSignal('SIGINT'));

  try {
    if (!fs.existsSync(tsxCli)) throw new Error(`tsx runtime missing: ${tsxCli}`);
    await reapDeferredSyncResources(apiKey);
    const sibling = await createToolStrippedSyncAgent(apiKey, batchId);
    syncAgentId = sibling.syncAgentId;
    syncBlockIds = sibling.syncBlockIds;
    if (aborting) {
      markSetupSettled();
      return;
    }
    conversationId = await createSyncConversation(apiKey, syncAgentId);
    markSetupSettled();
    if (aborting) return;
    if (Date.now() >= deadline) {
      await cleanupAbortedSync();
      emit('timeout');
      return;
    }

    const recentForeground = readForegroundRecentTranscript(input.cwd, input.session_id, input.prompt, input.transcript_path);
    const recentForegroundXml = renderForegroundRecentTranscript(recentForeground);
    const foregroundRecallQuery = contextualForegroundRecallQuery(input.prompt, recentForeground, input.context ?? '');
    const syncSetupReadyMs = Date.now() - syncStartedAtMs;

    const payload = {
      mode: 'sync',
      agentId: syncAgentId,
      syncAgentId,
      syncBlockIds,
      conversationId,
      sessionId: input.session_id,
      message: syncMessage(input, recentForegroundXml),
      cwd: input.cwd,
      batchId,
      canonicalMessages: [],
      assistantIntents: [],
      latestUserMessage: input.prompt,
      foregroundRecallQuery,
      syncCheckpointFile: checkpointFile,
      syncTurnId: input.turn_id,
      cleanupSyncResourcesOnFinish: true,
      syncStartedAtMs,
      syncSetupReadyMs,
    };
    fs.writeFileSync(payloadFile, `${JSON.stringify(payload)}\n`, { mode: 0o600 });

    child = spawn(process.execPath, [tsxCli, workerScript, payloadFile], {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: 'ignore',
    });

    while (Date.now() < deadline) {
      const state = checkpoint(checkpointFile);
      if (state) {
        if (state.status === 'failed') {
          await cleanupAbortedSync();
        } else {
          try { fs.unlinkSync(checkpointFile); } catch {}
        }
        emit(state.status, {
          ...(state.whisper_id ? { whisper_id: state.whisper_id } : {}),
          ...(state.bundle_ready_ms !== undefined ? { bundle_ready_ms: state.bundle_ready_ms } : {}),
          ...(state.resolve_recall_ms !== undefined ? { resolve_recall_ms: state.resolve_recall_ms } : {}),
          ...(state.telemetry ? { telemetry: state.telemetry } : {}),
          foreground_release_ms: Date.now() - syncStartedAtMs,
        });
        // A successful whisper transfers cleanup ownership to the background
        // worker. It continues to end_turn and reclaims/defer-reaps its sibling
        // agent + conversation without blocking foreground Kohaku.
        process.exit(0);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const finalState = checkpoint(checkpointFile);
        if (finalState) {
          if (finalState.status === 'failed') await cleanupAbortedSync();
          else try { fs.unlinkSync(checkpointFile); } catch {}
          emit(finalState.status, {
            ...(finalState.whisper_id ? { whisper_id: finalState.whisper_id } : {}),
            ...(finalState.bundle_ready_ms !== undefined ? { bundle_ready_ms: finalState.bundle_ready_ms } : {}),
            ...(finalState.resolve_recall_ms !== undefined ? { resolve_recall_ms: finalState.resolve_recall_ms } : {}),
            ...(finalState.telemetry ? { telemetry: finalState.telemetry } : {}),
            foreground_release_ms: Date.now() - syncStartedAtMs,
          });
          process.exit(0);
        }
        await cleanupAbortedSync();
        emit('failed');
        process.exit(0);
      }
      await wait(20);
    }

    await cleanupAbortedSync();
    emit('timeout');
  } catch (error) {
    markSetupSettled();
    await cleanupAbortedSync();
    throw error;
  } finally {
    markSetupSettled();
  }
}

main().catch((error) => {
  emit('failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(0);
});
