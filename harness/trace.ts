/**
 * Production traces of the own harness (docs/specs/OWN-HARNESS-DESIGN.md §6.1): metadata only.
 *
 * PassResult and SyncResult are research records for the offline replays and hold content by design (search
 * phrases, model arguments, error messages). A trace is a separate projection, built field by field from an
 * allowlist:
 *   - numbers, only when they are finite numbers (provider usage, status and latency arrive as untyped JSON);
 *   - fixed enums and codes, anything outside the list becomes 'other' (tool names: 'unknown');
 *   - the hook's own batch and session ids and its timestamp;
 *   - memory, evidence and intent ids only when a trusted source resolves them (the store after the pass, the
 *     batch's evidence catalog, the batch's intent catalog). Any other id is counted in `unresolved_ids`.
 * Errors keep a fixed code and, for exceptions, an allowlisted class name; never the message.
 */
import { MEMORY_KINDS, type CanonicalMemoryRecord } from '../relationship-memory/src/schema/index.js';
import type { ChatErrorClass } from './llm.js';
import { TOOL_ERROR_CODES, type PassInput, type PassResult } from './pass.js';
import type { SyncInput, SyncResult } from './sync_pass.js';

export const TRACE_SCHEMA_VERSION = 1;

/** The harness tools (pass.ts harnessTools); any other name is 'unknown'. */
export const TRACE_TOOL_NAMES = [
  'memory_search', 'deliver_whisper', 'skip_whisper', 'memory_reinforce', 'memory_remember', 'suggest_memory_relation', 'entity_search', 'entity_remember',
] as const;
const CHAT_ERROR_CLASSES = ['none', 'rate_limited', 'server', 'client', 'transport', 'malformed'] as const satisfies readonly ChatErrorClass[];
const COMPLETIONS = ['completed', 'retryable_failure'] as const;
const OUTCOMES = ['accepted', 'duplicate', 'permanently_rejected', 'retryable_failed'] as const;
const RELATION_OUTCOMES = ['accepted', 'duplicate', 'rejected'] as const;
/** Rejection codes of the runtime (reinforce, remember) and of proposal validation. */
export const REJECTION_CODES = [
  'intent_already_linked', 'unknown_assistant_intent', 'invalid_reinforcement', 'unknown_memory', 'unknown_linked_memory', 'ambiguous_evidence', 'unresolvable_evidence',
  'invalid_schema', 'invalid_schema_version', 'invalid_kind', 'invalid_summary', 'invalid_participants', 'invalid_payload', 'invalid_payload_field', 'invalid_optional_null',
  'invalid_linked_memory_ids', 'invalid_evidence_ids', 'ambiguous_evidence_ids', 'unknown_field', 'unknown_payload_field', 'authority_field_forbidden', 'non_chinese_semantic_prose',
] as const;
/** Exception classes a trace may name: the built-in errors and the ones this code base throws during a pass. */
export const EXCEPTION_NAMES = [
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'DOMException', 'CanonicalMutationLockError', 'EmbeddingProviderRequestError',
] as const;
const PHRASE_STATUSES = ['ok', 'none', 'timeout', 'error'] as const;
const GATE_STATUSES = ['ok', 'timeout', 'error'] as const;
const SKIP_REASONS = ['model_none', 'no_candidate', 'weak_support', 'gate_none', 'gate_failed'] as const;

type Other<T extends readonly string[]> = T[number] | 'other';
export type TraceToolName = (typeof TRACE_TOOL_NAMES)[number] | 'unknown';
export type ExceptionName = Other<typeof EXCEPTION_NAMES>;

/** What the hook knows without the model: its own ids, its clock, and the sources an id must resolve through. */
export interface SyncTrust {
  batchId: string;
  sessionId: string;
  /** When the hook started the pass. */
  at?: string;
  /** Wall time the hook measured around the pass. */
  wallMs?: number;
  /** Memory ids in the store after the pass. */
  memoryIds: ReadonlySet<string>;
}

export interface AsyncTrust extends SyncTrust {
  /** The batch's evidence catalog (evidence_id, or message_id when there is none). */
  evidenceIds: ReadonlySet<string>;
  /** The batch's remember-intent catalog. */
  intentIds: ReadonlySet<string>;
}

export interface TraceContext { at?: string; wallMs?: number }
type MemoryList = { listMemories(): Array<Pick<CanonicalMemoryRecord, 'memory_id'>> };

/** Build it after the pass, so the memories the pass created resolve. */
export function syncTrust(store: MemoryList, input: Pick<SyncInput, 'batchId' | 'sessionId'>, context: TraceContext = {}): SyncTrust {
  return { batchId: input.batchId, sessionId: input.sessionId, ...context, memoryIds: new Set(store.listMemories().map((m) => m.memory_id)) };
}

/** Build it after the pass, so the memories the pass created resolve. */
export function asyncTrust(store: MemoryList, input: PassInput, context: TraceContext = {}): AsyncTrust {
  return {
    ...syncTrust(store, input, context),
    evidenceIds: new Set(input.canonicalMessages.map((m) => m.evidence_id ?? m.message_id)),
    intentIds: new Set(input.assistantIntents.map((intent) => intent.intent_id)),
  };
}

interface TraceHead {
  schema_version: typeof TRACE_SCHEMA_VERSION;
  lane: 'async' | 'sync';
  batch_id: string;
  session_id: string;
  at?: string;
  wall_ms?: number;
  crashed: boolean;
}

export interface TokenUsage { prompt_tokens?: number; cached_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }

export interface AsyncStepTrace extends TokenUsage {
  step: number;
  ms?: number;
  attempts?: number;
  status?: number;
  error_class: Other<typeof CHAT_ERROR_CLASSES>;
  prompt_chars?: number;
  tool_calls: TraceToolName[];
}

export interface ReinforceTrace {
  outcome: Other<typeof OUTCOMES>;
  rejection_code?: Other<typeof REJECTION_CODES>;
  memory_id?: string;
  evidence_ids: string[];
  assistant_intent_id?: string;
  /** Ids in this call that no trusted source resolved. */
  unresolved_ids: number;
}

export interface RememberTrace {
  kind: Other<typeof MEMORY_KINDS>;
  outcome: Other<typeof OUTCOMES>;
  rejection_code?: Other<typeof REJECTION_CODES>;
  memory_id?: string;
  assistant_intent_id?: string;
  unresolved_ids: number;
}

export interface AsyncPassTrace extends TraceHead {
  lane: 'async';
  crashed: false;
  completion: Other<typeof COMPLETIONS>;
  succeeded: boolean;
  steps: AsyncStepTrace[];
  whisper: 'delivered' | 'skipped' | 'none';
  whisper_memory_id?: string;
  whisper_quotes?: number;
  reinforce: ReinforceTrace[];
  remember: RememberTrace[];
  relations: Array<{ outcome: Other<typeof RELATION_OUTCOMES> }>;
  /** Catalog intents, and those an accepted or duplicate reinforce/remember carried. */
  intents: { catalog: number; resolved: number };
  entities: number;
  searches: number;
  search_queries: number;
  surfaced: number;
  tool_errors: Array<{ tool: TraceToolName; code: Other<typeof TOOL_ERROR_CODES>; exception?: ExceptionName }>;
  /** All ids of the pass that no trusted source resolved. */
  unresolved_ids: number;
}

export interface SyncPassTrace extends TraceHead {
  lane: 'sync';
  crashed: false;
  phrase_status: Other<typeof PHRASE_STATUSES>;
  phrases: number;
  phrase_ms?: number;
  search_ms?: number;
  gate_ms?: number;
  total_ms?: number;
  gate_status?: Other<typeof GATE_STATUSES>;
  usage: TokenUsage;
  candidates: number;
  whispered: boolean;
  whisper_memory_id?: string;
  whisper_quotes?: number;
  skip_reason?: Other<typeof SKIP_REASONS>;
  provider_error?: Other<typeof CHAT_ERROR_CLASSES>;
  unresolved_ids: number;
}

/** A pass that threw instead of returning a result. */
export interface CrashTrace extends TraceHead {
  crashed: true;
  error_class: 'exception';
  exception: ExceptionName;
}

export type HarnessTrace = AsyncPassTrace | SyncPassTrace | CrashTrace;

// ---- allowlist helpers

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function oneOf<T extends readonly string[]>(allowed: T, value: unknown): Other<T> {
  return (allowed as readonly unknown[]).includes(value) ? value as T[number] : 'other';
}

function optionalOneOf<T extends readonly string[]>(allowed: T, value: unknown): Other<T> | undefined {
  return value === undefined || value === null ? undefined : oneOf(allowed, value);
}

function toolName(value: unknown): TraceToolName {
  return (TRACE_TOOL_NAMES as readonly unknown[]).includes(value) ? value as TraceToolName : 'unknown';
}

/** Arrays of the result, read defensively: their values may still be whatever the model or provider sent. */
function list<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

/** Drops undefined fields, so optional ones are absent rather than null-ish. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function usage(value: unknown): TokenUsage {
  const u = (value ?? {}) as Record<string, unknown>;
  return compact({ prompt_tokens: num(u.prompt_tokens), cached_tokens: num(u.cached_tokens), completion_tokens: num(u.completion_tokens), reasoning_tokens: num(u.reasoning_tokens) });
}

function head(trust: SyncTrust): Pick<TraceHead, 'schema_version' | 'batch_id' | 'session_id' | 'at' | 'wall_ms'> {
  const at = typeof trust.at === 'string' && Number.isFinite(Date.parse(trust.at)) ? new Date(trust.at).toISOString() : undefined;
  return compact({ schema_version: TRACE_SCHEMA_VERSION, batch_id: trust.batchId, session_id: trust.sessionId, at, wall_ms: num(trust.wallMs) });
}

/** Resolves ids against trusted sets; whatever does not resolve is only counted. */
class Resolver {
  unresolved = 0;
  one(set: ReadonlySet<string>, value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && set.has(value)) return value;
    this.unresolved++;
    return undefined;
  }
  many(set: ReadonlySet<string>, value: unknown): string[] {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return [...new Set(items.map((item) => this.one(set, item)).filter((id): id is string => id !== undefined))];
  }
}

function exceptionName(error: unknown): ExceptionName {
  return error instanceof Error ? oneOf(EXCEPTION_NAMES, error.constructor?.name) : 'other';
}

// ---- projections

export function toAsyncTrace(result: PassResult, trust: AsyncTrust): AsyncPassTrace {
  const { decisions } = result;
  const total = new Resolver();

  const steps = list(result.steps).map((s: PassResult['steps'][number], index): AsyncStepTrace => compact({
    step: num(s.step) ?? index + 1,
    ms: num(s.ms),
    attempts: num(s.attempts),
    status: num(s.status),
    error_class: oneOf(CHAT_ERROR_CLASSES, s.error_class),
    ...usage(s),
    prompt_chars: num(s.prompt_chars),
    tool_calls: list(s.tool_calls).map(toolName),
  }));

  const whisperMemoryId = decisions.whisper ? total.one(trust.memoryIds, decisions.whisper.memory_id) : undefined;

  const reinforce = list(decisions.reinforce).map((r: PassResult['decisions']['reinforce'][number]): ReinforceTrace => {
    const ids = new Resolver();
    const memoryId = ids.one(trust.memoryIds, r.memory_id);
    const evidenceIds = ids.many(trust.evidenceIds, r.evidence_ids);
    const intentId = ids.one(trust.intentIds, r.assistant_intent_id);
    total.unresolved += ids.unresolved;
    return compact({
      outcome: oneOf(OUTCOMES, r.outcome),
      rejection_code: optionalOneOf(REJECTION_CODES, r.rejection_code),
      memory_id: memoryId,
      evidence_ids: evidenceIds,
      assistant_intent_id: intentId,
      unresolved_ids: ids.unresolved,
    });
  });

  const remember = list(decisions.remember).map((r: PassResult['decisions']['remember'][number]): RememberTrace => {
    const ids = new Resolver();
    const memoryId = ids.one(trust.memoryIds, r.memory_id);
    const intentId = ids.one(trust.intentIds, r.assistant_intent_id);
    total.unresolved += ids.unresolved;
    return compact({
      kind: oneOf(MEMORY_KINDS, r.kind),
      outcome: oneOf(OUTCOMES, r.outcome),
      rejection_code: optionalOneOf(REJECTION_CODES, r.rejection_code),
      memory_id: memoryId,
      assistant_intent_id: intentId,
      unresolved_ids: ids.unresolved,
    });
  });

  const resolvedIntents = new Set([...reinforce, ...remember]
    .filter((entry) => entry.assistant_intent_id && (entry.outcome === 'accepted' || entry.outcome === 'duplicate'))
    .map((entry) => entry.assistant_intent_id!));

  return compact({
    ...head(trust),
    lane: 'async' as const,
    crashed: false as const,
    completion: oneOf(COMPLETIONS, result.completion),
    succeeded: result.succeeded === true,
    steps,
    whisper: decisions.whisper ? 'delivered' as const : decisions.whisper_skipped === true ? 'skipped' as const : 'none' as const,
    whisper_memory_id: whisperMemoryId,
    whisper_quotes: decisions.whisper ? list(decisions.whisper.snippet_ids).length : undefined,
    reinforce,
    remember,
    relations: list(decisions.relations).map((r: PassResult['decisions']['relations'][number]) => ({ outcome: oneOf(RELATION_OUTCOMES, r.outcome) })),
    intents: { catalog: trust.intentIds.size, resolved: resolvedIntents.size },
    entities: num(decisions.entities) ?? 0,
    searches: num(decisions.searches) ?? 0,
    search_queries: num(decisions.search_queries) ?? 0,
    surfaced: list(result.surfaced_memory_ids).length,
    tool_errors: list(result.tool_errors).map((e: PassResult['tool_errors'][number]) => compact({
      tool: toolName(e.name),
      code: oneOf(TOOL_ERROR_CODES, e.code),
      exception: e.code === 'exception' ? oneOf(EXCEPTION_NAMES, e.exception) : undefined,
    })),
    unresolved_ids: total.unresolved,
  });
}

export function toSyncTrace(result: SyncResult, trust: SyncTrust): SyncPassTrace {
  const ids = new Resolver();
  const whisperMemoryId = result.whisper ? ids.one(trust.memoryIds, result.whisper.memory_id) : undefined;
  return compact({
    ...head(trust),
    lane: 'sync' as const,
    crashed: false as const,
    phrase_status: oneOf(PHRASE_STATUSES, result.phrase_status),
    phrases: list(result.phrases).length,
    phrase_ms: num(result.phrase_ms),
    search_ms: num(result.search_ms),
    gate_ms: num(result.gate_ms),
    total_ms: num(result.total_ms),
    gate_status: optionalOneOf(GATE_STATUSES, result.gate_status),
    usage: usage(result.usage),
    candidates: list(result.candidates).length,
    whispered: Boolean(result.whisper),
    whisper_memory_id: whisperMemoryId,
    whisper_quotes: result.whisper ? list(result.whisper.snippet_ids).length : undefined,
    skip_reason: optionalOneOf(SKIP_REASONS, result.skip_reason),
    provider_error: optionalOneOf(CHAT_ERROR_CLASSES, result.provider_error),
    unresolved_ids: ids.unresolved,
  });
}

/** For a pass that threw: the class name, if allowlisted, and nothing of the message. */
export function toCrashTrace(lane: 'async' | 'sync', error: unknown, trust: SyncTrust): CrashTrace {
  return { ...head(trust), lane, crashed: true, error_class: 'exception', exception: exceptionName(error) };
}

