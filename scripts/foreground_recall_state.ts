import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir } from './conversation_utils.js';
import { getSubconWhisperDeliveryState, type SubconWhisperDeliveryState } from './subcon_whisper_queue.js';
import type { ForegroundRecallBundle } from './foreground_recall.js';

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
