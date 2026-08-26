import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir, withSyncStateLock } from './conversation_utils.js';
import { getSubconWhisperDeliveryState, type SubconWhisperDeliveryState } from './subcon_whisper_queue.js';
import type { ForegroundRecallBundle } from './foreground_recall.js';
import { extractAllContent, type TranscriptMessage, type TranscriptUserTurnAnchor } from './transcript_utils.js';

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

export interface ForegroundRecallBindingBatch {
  bindings: ForegroundRecallMessageBinding[];
  retired_unbound_turn_ids: string[];
  blocked_turn_id?: string;
}

interface RawTranscriptBindingRecord {
  role: 'user' | 'assistant';
  message_id?: string;
  parent_message_id?: string;
  user_text: boolean;
}

function rawTranscriptRecords(messages: readonly TranscriptMessage[]): RawTranscriptBindingRecord[] {
  return messages.flatMap((message) => message.type === 'user' || message.type === 'assistant'
    ? [{
        role: message.type,
        ...(message.uuid ? { message_id: message.uuid } : {}),
        ...(message.parentUuid ? { parent_message_id: message.parentUuid } : {}),
        user_text: message.type === 'user' && Boolean(extractAllContent(message).text?.trim()),
      }]
    : []);
}

function firstUserAfter(records: readonly RawTranscriptBindingRecord[], index: number): string | undefined {
  for (let i = index + 1; i < records.length; i++) {
    if (records[i].role === 'user' && records[i].user_text && records[i].message_id) return records[i].message_id;
  }
  return undefined;
}

function retirePendingTurn(cwd: string, sessionId: string, turn: PendingForegroundRecallTurn): void {
  try { fs.unlinkSync(pendingTurnPath(cwd, sessionId, turn.sequence, turn.turn_id)); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

/**
 * Bind pending foreground turns while the caller already owns the session sync-state lock.
 * Only raw transcript order plus the current unprocessed user suffix are authoritative.
 * Ambiguous turns are explicitly retired unbound so Stop can fallback; a turn whose
 * user record has not appeared yet blocks the pending prefix instead of allowing overtaking.
 */
export function bindPendingForegroundRecallTurnsToTranscriptUnlocked(
  cwd: string,
  sessionId: string,
  transcriptMessages: readonly TranscriptMessage[],
  bindableMessageIds: readonly string[],
  now: () => string = () => new Date().toISOString(),
): ForegroundRecallBindingBatch {
  const cleanSession = sessionId.trim();
  if (!cleanSession) return { bindings: [], retired_unbound_turn_ids: [] };
  const existingBindings = listForegroundRecallMessageBindings(cwd, cleanSession);
  const alreadyBoundTurns = new Set(existingBindings.map((item) => item.turn_id));
  const pending = listPendingForegroundRecallTurns(cwd, cleanSession).filter((turn) => {
    if (!alreadyBoundTurns.has(turn.turn_id)) return true;
    // Crash recovery: binding publication is authoritative. If the process died
    // before removing its pending registration, retire that duplicate now.
    retirePendingTurn(cwd, cleanSession, turn);
    return false;
  });
  if (pending.length === 0) return { bindings: [], retired_unbound_turn_ids: [] };

  const alreadyBoundMessages = new Set(existingBindings.map((item) => item.message_id));
  const bindable = new Set([...new Set(bindableMessageIds.map((value) => value.trim()).filter(Boolean))]
    .filter((messageId) => !alreadyBoundMessages.has(messageId)));
  const records = rawTranscriptRecords(transcriptMessages);
  const bindings: ForegroundRecallMessageBinding[] = [];
  const retired: string[] = [];

  for (const turn of pending) {
    const anchor = turn.transcript_anchor;
    let candidates: string[] = [];
    let targetNotYetPresent = false;

    if (anchor.tail_role === 'assistant') {
      let anchorIndex = -1;
      if (anchor.tail_message_id) anchorIndex = records.findIndex((item) => item.message_id === anchor.tail_message_id);
      if (anchorIndex < 0 && anchor.last_user_message_id) anchorIndex = records.findIndex((item) => item.role === 'user' && item.message_id === anchor.last_user_message_id);
      const nextUser = anchorIndex >= 0 ? firstUserAfter(records, anchorIndex) : undefined;
      if (!nextUser) targetNotYetPresent = true;
      else if (bindable.has(nextUser)) candidates = [nextUser];
    } else if (anchor.tail_role === 'user' && anchor.last_user_message_id) {
      const rawTailIsNonTextUser = Boolean(anchor.tail_message_id && anchor.tail_message_id !== anchor.last_user_message_id);
      const anchorIndex = rawTailIsNonTextUser && anchor.tail_message_id
        ? records.findIndex((item) => item.message_id === anchor.tail_message_id)
        : records.findIndex((item) => item.role === 'user' && item.user_text && item.message_id === anchor.last_user_message_id);
      const nextUser = anchorIndex >= 0 ? firstUserAfter(records, anchorIndex) : undefined;
      if (rawTailIsNonTextUser) {
        // A tool-result user wrapper cannot be the UserPromptSubmit message. It is
        // an exact structural predecessor just like an assistant tail.
        if (!nextUser) targetNotYetPresent = true;
        else if (bindable.has(nextUser)) candidates = [nextUser];
      } else {
        const semanticCandidates = [anchor.last_user_message_id, ...(nextUser ? [nextUser] : [])];
        const responded = semanticCandidates.filter((candidate) => records.some((item) =>
          item.role === 'assistant' && item.parent_message_id === candidate,
        ));
        const respondedBindable = [...new Set(responded.filter((candidate) => bindable.has(candidate)))];
        if (respondedBindable.length > 0) {
          // Raw parentUuid is an exact transcript graph edge: if exactly one of the
          // two structural interpretations actually owns the assistant response,
          // it identifies the foreground user without prompt/timestamp heuristics.
          candidates = respondedBindable;
        } else {
          const selfBindable = bindable.has(anchor.last_user_message_id);
          const nextBindable = Boolean(nextUser && bindable.has(nextUser));
          if (!selfBindable && nextBindable && nextUser) {
            // The tail user is outside the current maintenance suffix, so the first
            // user after it is the only possible current foreground UUID.
            candidates = [nextUser];
          } else if (selfBindable && nextBindable && nextUser) {
            candidates = [anchor.last_user_message_id, nextUser];
          } else if (!nextUser) {
            // Current may be the tail user or a not-yet-appended next user. Wait for
            // either a parent edge or a new user record; never guess the tail UUID.
            targetNotYetPresent = true;
          }
        }
      }
    } else if (anchor.tail_role === 'none') {
      const userIds = records.filter((item) => item.role === 'user' && item.user_text && item.message_id).map((item) => item.message_id!);
      const possible = userIds.filter((messageId) => bindable.has(messageId));
      if (possible.length === 0) targetNotYetPresent = true;
      else if (userIds.length === 1 && possible.length === 1) candidates = possible;
      else if (possible.length > 1) candidates = possible;
      // One bindable user among older transcript history is still ambiguous when
      // the hook had no structural anchor; retire unbound instead of guessing.
    }

    candidates = [...new Set(candidates)].filter((messageId) => bindable.has(messageId));
    if (candidates.length === 0 && targetNotYetPresent) {
      return { bindings, retired_unbound_turn_ids: retired, blocked_turn_id: turn.turn_id };
    }
    if (candidates.length !== 1) {
      // Structural ambiguity is terminal for receipt reuse on this turn. Retire it
      // in sequence order and let async Stop fallback rather than guessing a UUID.
      retirePendingTurn(cwd, cleanSession, turn);
      retired.push(turn.turn_id);
      continue;
    }

    const messageId = candidates[0];
    const binding: ForegroundRecallMessageBinding = {
      schema_version: 1,
      session_id: cleanSession,
      message_id: messageId,
      turn_id: turn.turn_id,
      bound_at: now(),
    };
    atomicWriteJson(messageBindingPath(cwd, cleanSession, messageId), binding);
    alreadyBoundMessages.add(messageId);
    bindable.delete(messageId);
    retirePendingTurn(cwd, cleanSession, turn);
    bindings.push(binding);
  }
  return { bindings, retired_unbound_turn_ids: retired };
}

export function bindPendingForegroundRecallTurnsToTranscript(
  cwd: string,
  sessionId: string,
  transcriptMessages: readonly TranscriptMessage[],
  bindableMessageIds: readonly string[],
  now: () => string = () => new Date().toISOString(),
): ForegroundRecallBindingBatch {
  const cleanSession = sessionId.trim();
  if (!cleanSession) return { bindings: [], retired_unbound_turn_ids: [] };
  return withSyncStateLock(cwd, cleanSession, () => bindPendingForegroundRecallTurnsToTranscriptUnlocked(
    cwd, cleanSession, transcriptMessages, bindableMessageIds, now,
  ));
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
