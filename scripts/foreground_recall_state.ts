import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir, withSyncStateLock } from './conversation_utils.js';
import { getSubconWhisperDeliveryState, type SubconWhisperDeliveryState } from './subcon_whisper_queue.js';
import type { ForegroundRecallBundle } from './foreground_recall.js';
import type { TranscriptUserTurnAnchor } from './transcript_utils.js';

export interface ForegroundRecallSearchReceipt {
  kind: 'prefetch' | 'expand';
  query_sha256: string;
  memory_ids: string[];
}

export interface PersistedForegroundRecallBundle {
  schema_version: 1;
  bundle_id: string;
  session_id: string;
  turn_id: string;
  query_sha256: string;
  recorded_at: string;
  candidate_refs: Array<{ memory_id: string; snippet_ids: string[] }>;
}

export interface ForegroundRecallReceipt {
  schema_version: 1;
  session_id: string;
  turn_id: string;
  bundle_id: string;
  recorded_at: string;
  decision: 'selected' | 'none' | 'failed';
  searches: ForegroundRecallSearchReceipt[];
  selected?: { memory_id: string; snippet_ids: string[] };
  whisper_id?: string;
  error?: string;
}

export interface ForegroundRecallTurnState {
  bundle?: PersistedForegroundRecallBundle;
  receipt?: ForegroundRecallReceipt;
  delivery_state: SubconWhisperDeliveryState | 'not_applicable';
}

export interface ForegroundRecallMessageBinding {
  schema_version: 1;
  session_id: string;
  message_id: string;
  turn_id: string;
  bound_at: string;
}

export interface PendingForegroundRecallTurn {
  schema_version: 1;
  session_id: string;
  turn_id: string;
  sequence: number;
  registered_at: string;
  transcript_anchor: TranscriptUserTurnAnchor;
}

export interface BoundForegroundRecallTurnState extends ForegroundRecallTurnState {
  binding: ForegroundRecallMessageBinding;
}

function sessionDir(cwd: string, sessionId: string): string {
  const key = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return path.join(getDurableStateDir(cwd), 'foreground-recall', key);
}

function turnKey(turnId: string): string {
  return crypto.createHash('sha256').update(turnId).digest('hex').slice(0, 24);
}

function messageKey(messageId: string): string {
  return crypto.createHash('sha256').update(messageId).digest('hex').slice(0, 24);
}

function messageBindingPath(cwd: string, sessionId: string, messageId: string): string {
  return path.join(sessionDir(cwd, sessionId), 'message-bindings', `${messageKey(messageId)}.json`);
}

function pendingTurnsDir(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd, sessionId), 'pending-turns');
}

function pendingSequencePath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd, sessionId), 'pending-sequence.json');
}

function pendingTurnPath(cwd: string, sessionId: string, sequence: number, turnId: string): string {
  return path.join(pendingTurnsDir(cwd, sessionId), `${String(sequence).padStart(12, '0')}-${turnKey(turnId)}.json`);
}

function pathsFor(cwd: string, sessionId: string, turnId: string): { bundle: string; receipt: string } {
  const dir = sessionDir(cwd, sessionId);
  const key = turnKey(turnId);
  return { bundle: path.join(dir, `${key}.bundle.json`), receipt: path.join(dir, `${key}.receipt.json`) };
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { return undefined; }
}

export function persistForegroundRecallBundle(cwd: string, bundle: ForegroundRecallBundle): PersistedForegroundRecallBundle {
  const persisted: PersistedForegroundRecallBundle = {
    schema_version: 1,
    bundle_id: bundle.bundle_id,
    session_id: bundle.session_id,
    turn_id: bundle.turn_id,
    query_sha256: bundle.query_sha256,
    recorded_at: bundle.created_at,
    candidate_refs: bundle.candidates.map((candidate) => ({
      memory_id: candidate.memory_id,
      snippet_ids: candidate.quote_snippets.map((snippet) => snippet.snippet_id),
    })),
  };
  atomicWriteJson(pathsFor(cwd, bundle.session_id, bundle.turn_id).bundle, persisted);
  return persisted;
}

export function writeForegroundRecallReceipt(cwd: string, receipt: ForegroundRecallReceipt): void {
  atomicWriteJson(pathsFor(cwd, receipt.session_id, receipt.turn_id).receipt, receipt);
}

export function readForegroundRecallTurnState(cwd: string, sessionId: string, turnId: string): ForegroundRecallTurnState {
  const files = pathsFor(cwd, sessionId, turnId);
  const bundle = readJson<PersistedForegroundRecallBundle>(files.bundle);
  const receipt = readJson<ForegroundRecallReceipt>(files.receipt);
  const deliveryState = receipt?.whisper_id
    ? getSubconWhisperDeliveryState(cwd, sessionId, receipt.whisper_id)
    : 'not_applicable';
  return {
    ...(bundle ? { bundle } : {}),
    ...(receipt ? { receipt } : {}),
    delivery_state: deliveryState,
  };
}


export function retractUnreleasedForegroundRecallReceipt(cwd: string, sessionId: string, turnId: string): boolean {
  const file = pathsFor(cwd, sessionId, turnId).receipt;
  const receipt = readJson<ForegroundRecallReceipt>(file);
  if (!receipt || receipt.decision === 'failed') return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}


export function registerPendingForegroundRecallTurn(
  cwd: string,
  sessionId: string,
  turnId: string,
  transcriptAnchor: TranscriptUserTurnAnchor = { tail_role: 'none' },
  now: () => string = () => new Date().toISOString(),
): PendingForegroundRecallTurn {
  const cleanSession = sessionId.trim();
  const cleanTurn = turnId.trim();
  if (!cleanSession || !cleanTurn) throw new Error('sessionId and turnId are required');
  return withSyncStateLock(cwd, cleanSession, () => {
    const counterFile = pendingSequencePath(cwd, cleanSession);
    const counter = readJson<{ next_sequence?: number }>(counterFile);
    const sequence = Number.isInteger(counter?.next_sequence) && (counter?.next_sequence ?? 0) > 0
      ? counter!.next_sequence!
      : 1;
    const pending: PendingForegroundRecallTurn = {
      schema_version: 1,
      session_id: cleanSession,
      turn_id: cleanTurn,
      sequence,
      registered_at: now(),
      transcript_anchor: transcriptAnchor,
    };
    // Advance the sequence before publishing the registration. A crash may leave
    // a harmless gap, but can never publish two different turns with one ordinal.
    atomicWriteJson(counterFile, { next_sequence: sequence + 1 });
    atomicWriteJson(pendingTurnPath(cwd, cleanSession, sequence, cleanTurn), pending);
    return pending;
  });
}

export function listPendingForegroundRecallTurns(cwd: string, sessionId: string): PendingForegroundRecallTurn[] {
  const dir = pendingTurnsDir(cwd, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const value = readJson<PendingForegroundRecallTurn>(path.join(dir, name));
      return value?.schema_version === 1 && value.session_id === sessionId && value.turn_id && Number.isInteger(value.sequence) && value.transcript_anchor
        ? [value]
        : [];
    })
    .sort((a, b) => a.sequence - b.sequence || a.turn_id.localeCompare(b.turn_id));
}

function listForegroundRecallMessageBindings(cwd: string, sessionId: string): ForegroundRecallMessageBinding[] {
  const dir = path.join(sessionDir(cwd, sessionId), 'message-bindings');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const value = readJson<ForegroundRecallMessageBinding>(path.join(dir, name));
      return value?.schema_version === 1 && value.session_id === sessionId && value.message_id && value.turn_id ? [value] : [];
    });
}

export function bindPendingForegroundRecallTurnsToMessages(
  cwd: string,
  sessionId: string,
  messageIds: readonly string[],
  now: () => string = () => new Date().toISOString(),
): ForegroundRecallMessageBinding[] {
  const cleanSession = sessionId.trim();
  if (!cleanSession) return [];
  return withSyncStateLock(cwd, cleanSession, () => {
    const existingBindings = listForegroundRecallMessageBindings(cwd, cleanSession);
    const alreadyBoundTurns = new Set(existingBindings.map((item) => item.turn_id));
    const pending = listPendingForegroundRecallTurns(cwd, cleanSession).filter((turn) => {
      if (!alreadyBoundTurns.has(turn.turn_id)) return true;
      // Crash recovery: binding publication is authoritative. If the process died
      // before removing its pending registration, retire that duplicate now.
      try { fs.unlinkSync(pendingTurnPath(cwd, cleanSession, turn.sequence, turn.turn_id)); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      return false;
    });
    if (pending.length === 0) return [];
    const alreadyBoundMessages = new Set(existingBindings.map((item) => item.message_id));
    const unboundMessages = [...new Set(messageIds.map((value) => value.trim()).filter(Boolean))]
      .filter((messageId) => !alreadyBoundMessages.has(messageId));
    if (unboundMessages.length === 0) return [];

    // Bind only from transcript structure + durable order; prompt text, hashes,
    // timestamps and latest-receipt heuristics are deliberately absent.
    const available = [...unboundMessages];
    const bindings: ForegroundRecallMessageBinding[] = [];
    for (const turn of pending) {
      const anchor = turn.transcript_anchor;
      let messageId: string | undefined;
      if (anchor.tail_role === 'user' && anchor.last_user_message_id) {
        const direct = available.indexOf(anchor.last_user_message_id);
        if (direct >= 0) {
          messageId = available[direct];
        } else if (alreadyBoundMessages.has(anchor.last_user_message_id)) {
          // The hook observed the previous user as the tail (e.g. an interrupted
          // turn with no assistant record); the current turn is the next UUID.
          messageId = available[0];
        }
      } else if (anchor.tail_role === 'assistant') {
        messageId = available.find((candidate) => candidate !== anchor.last_user_message_id);
      } else if (anchor.tail_role === 'none') {
        messageId = available[0];
      }
      if (!messageId) continue;
      const binding: ForegroundRecallMessageBinding = {
        schema_version: 1, session_id: cleanSession, message_id: messageId, turn_id: turn.turn_id, bound_at: now(),
      };
      atomicWriteJson(messageBindingPath(cwd, cleanSession, messageId), binding);
      alreadyBoundMessages.add(messageId);
      available.splice(available.indexOf(messageId), 1);
      try { fs.unlinkSync(pendingTurnPath(cwd, cleanSession, turn.sequence, turn.turn_id)); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      bindings.push(binding);
    }
    return bindings;
  });
}

export function bindForegroundRecallTurnToMessage(
  cwd: string,
  sessionId: string,
  turnId: string,
  messageId: string,
  now: () => string = () => new Date().toISOString(),
): ForegroundRecallMessageBinding {
  const cleanSession = sessionId.trim();
  const cleanTurn = turnId.trim();
  const cleanMessage = messageId.trim();
  if (!cleanSession || !cleanTurn || !cleanMessage) throw new Error('sessionId, turnId, and messageId are required');
  const file = messageBindingPath(cwd, cleanSession, cleanMessage);
  const existing = readJson<ForegroundRecallMessageBinding>(file);
  if (existing) {
    if (existing.session_id !== cleanSession || existing.message_id !== cleanMessage || existing.turn_id !== cleanTurn) {
      throw new Error(`foreground recall message binding conflict for ${cleanMessage}`);
    }
    return existing;
  }
  const binding: ForegroundRecallMessageBinding = {
    schema_version: 1,
    session_id: cleanSession,
    message_id: cleanMessage,
    turn_id: cleanTurn,
    bound_at: now(),
  };
  atomicWriteJson(file, binding);
  return binding;
}

export function readForegroundRecallTurnStateForMessage(
  cwd: string,
  sessionId: string,
  messageId: string,
): BoundForegroundRecallTurnState | undefined {
  const binding = readJson<ForegroundRecallMessageBinding>(messageBindingPath(cwd, sessionId, messageId));
  if (!binding || binding.session_id !== sessionId || binding.message_id !== messageId || !binding.turn_id) return undefined;
  return { binding, ...readForegroundRecallTurnState(cwd, sessionId, binding.turn_id) };
}
