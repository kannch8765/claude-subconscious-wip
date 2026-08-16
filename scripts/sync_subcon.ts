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
  timeout_ms?: number;
}

type SyncStatus = 'whisper' | 'no_whisper' | 'failed' | 'timeout';

interface SyncCheckpoint {
  status: 'whisper' | 'no_whisper' | 'failed';
  whisper_id?: string;
  recorded_at?: string;
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
  const timeout = typeof value.timeout_ms === 'number' && Number.isFinite(value.timeout_ms)
    ? Math.max(250, Math.min(30_000, Math.round(value.timeout_ms)))
    : 20_000;
  if (!sessionId || !turnId || !cwd || !prompt) throw new Error('session_id, turn_id, cwd, and prompt are required');
  return { session_id: sessionId, turn_id: turnId, cwd, prompt, ...(context ? { context } : {}), timeout_ms: timeout };
}

function syncBatchId(input: SyncSubconInput): string {
  const digest = crypto.createHash('sha256').update(`${input.session_id}\0${input.turn_id}`).digest('hex').slice(0, 24);
  return `sync_${digest}`;
}

function syncMessage(input: SyncSubconInput): string {
  const context = escapeXmlContent((input.context ?? '').slice(-8000));
  const prompt = escapeXmlContent(input.prompt);
  return `<subcon_sync_foreground_turn>
<session_id>${escapeXmlContent(input.session_id)}</session_id>
<current_foreground_context>
${context}
</current_foreground_context>
<latest_user_message>
${prompt}
</latest_user_message>
<instructions>
This is the synchronous Subconscious mode immediately before foreground Kohaku receives <latest_user_message>.

- Read <latest_user_message> together with the bounded current foreground context, then choose and call relationship memory_search yourself. Start with one short atomic semantic concept (usually 1-3 meaningful terms), omitting generic actor/relationship words unless they are essential. For example, for “咖啡><🐾” prefer “咖啡”, not “咖啡 猫 喝咖啡 习惯”. Never mechanically copy the whole user message, emoji, or punctuation.
- Every sync pass with a real <latest_user_message> must complete at least one relationship memory_search before ending.
- If a named referent is unresolved and its stable identity materially matters, you may call entity_search with purpose=foreground_grounding before episodic recall. Do not search identity merely because a name appears.
- You may issue independent search calls in parallel only when they answer genuinely different recall questions. Do not fan out near-duplicate searches. If the first search already surfaces useful context, deliver the whisper before optional refinement.
- If useful remembered context surfaced, call deliver_whisper once as soon as you have a grounded compact factual memory seed suitable for the CURRENT foreground turn. Concrete facts, time/place anchors, and a short source-faithful quote are preferred. Do not add present-day interpretation or relationship conclusions that are not in the remembered evidence.
- If nothing useful surfaced, do not call deliver_whisper; silence is correct.
- Never mention memory_search, IDs, evidence, reinforce/remember/create/dedupe, archival status, or maintenance bookkeeping in a whisper.
- This sync mode does not own canonical relationship-memory mutation. The existing asynchronous Stop pass remains authoritative for long-term reinforcement/remember/entity maintenance. Continue this Letta turn normally until end_turn after delivering a whisper; ordinary assistant prose is not foreground-visible.
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

    const payload = {
      mode: 'sync',
      agentId: syncAgentId,
      syncAgentId,
      syncBlockIds,
      conversationId,
      sessionId: input.session_id,
      message: syncMessage(input),
      cwd: input.cwd,
      batchId,
      canonicalMessages: [],
      assistantIntents: [],
      latestUserMessage: input.prompt,
      syncCheckpointFile: checkpointFile,
      syncTurnId: input.turn_id,
      cleanupSyncResourcesOnFinish: true,
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
        emit(state.status, state.whisper_id ? { whisper_id: state.whisper_id } : {});
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
          emit(finalState.status, finalState.whisper_id ? { whisper_id: finalState.whisper_id } : {});
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
