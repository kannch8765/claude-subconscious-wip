/**
 * Sync pass (docs/specs/OWN-HARNESS-DESIGN.md §4.2): runs when the user sends a message, before
 * Kohaku replies. Read-only: it proposes at most one whisper and never writes the store.
 *
 *   1. A small model writes 0-3 search phrases from the previous turn and the new message
 *      (variant D of the sync-lane exam). An empty list means "nothing worth recalling".
 *   2. Every phrase and the message itself go to the hybrid recall in parallel.
 *   3. The ranked lists are fused by reciprocal rank (RRF); session-known memories are masked.
 *   4. Gate. 'rank': whisper the top memory when at least `minLists` lists back it (too loose: rank
 *      fusion always finds something). 'model' (default): the small model sees the top candidates'
 *      summaries and picks one or none, with the same criteria as the async whisper.
 *   5. Quotes: the memory's quotes sharing most character bigrams with the phrases and message.
 */
import type { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import type { MemoryRecallResult } from '../relationship-memory/src/tools/index.js';
import { chat, type ChatResult, type ChatTransport, type ChatUsage } from './llm.js';
import { modelText } from './turn_input.js';
import { isKnown } from './view.js';
import { bigrams, overlap } from './quote_sampler.js';

export interface SyncInput {
  batchId: string;
  sessionId: string;
  latestUserMessage: string;
  previousUserMessage: string;
  previousKohakuReply: string;
  sessionKnownMemoryIds: string[];
}

export interface SyncConfig {
  model: string;
  reasoningEffort?: string;
  /** Give up on the phrase model after this long and search with the message only. */
  phraseTimeoutMs?: number;
  perListLimit?: number;
  /** A whisper needs its memory in at least this many of the fused lists ('rank' gate). */
  minLists?: number;
  gate?: 'rank' | 'model';
  /** Candidates shown to the model gate. */
  gateCandidates?: number;
  maxQuotes?: number;
}

export interface SyncCandidate { memory_id: string; rrf: number; lists: number; best_rank: number }

export interface SyncResult {
  phrases: string[];
  phrase_status: 'ok' | 'none' | 'timeout' | 'error';
  phrase_ms: number;
  gate_ms?: number;
  gate_status?: 'ok' | 'timeout' | 'error';
  search_ms: number;
  total_ms: number;
  usage: ChatUsage;
  candidates: SyncCandidate[];
  whisper?: { memory_id: string; snippet_ids: string[] };
  skip_reason?: 'model_none' | 'no_candidate' | 'weak_support' | 'gate_none' | 'gate_failed';
  /** A model call failed at the provider (rate limit, server, transport). Timeouts are normal outcomes, not this. */
  provider_error?: string;
}

export const SYNC_SYSTEM_PROMPT = [
  "You help an AI companion named Kohaku (琥珀) recall shared memories with the user (ゆう) at the moment the user sends a message.",
  "Kohaku's memory store holds relationship memories: shared experiences, inside jokes, preferences, relationship events, people and things they talked about.",
  'Given the conversation, write the search phrases that would find the memories most worth recalling right now.',
  'Rules: 1-3 short phrases (2-12 words each); use concrete names, topics, places, objects and events from the conversation, not generic words;',
  'write in the language the conversation mainly uses (usually Chinese); if nothing is worth recalling, return an empty list.',
  'Reply with JSON only: {"queries": ["..."]}',
].join(' ');

export const SYNC_GATE_PROMPT = [
  "You decide whether one old memory should quietly resurface for Kohaku (琥珀), an AI companion, before she replies to ゆう's new message.",
  'Surface a memory only when it adds something Kohaku would not bring up on her own: a shared moment, a running joke, a promise, a person or place with history, a past feeling about the same thing.',
  'Pick none for routine work, logistics, code or tool talk, and for memories that merely restate what is being said right now. Picking none is normal.',
  'Reply with JSON only: {"memory_id": "<one id from the list>"} or {"memory_id": null}',
].join(' ');

export function syncGatePrompt(input: SyncInput, candidates: Array<{ memory_id: string; kind: string; summary: string; observed?: string }>): string {
  const list = candidates.map((c) => `- ${c.memory_id} [${c.kind}${c.observed ? `, ${c.observed}` : ''}] ${[...modelText(c.summary ?? '')].slice(0, 240).join('')}`).join('\n');
  return `${syncUserPrompt(input)}\n\nCandidate memories:\n${list}`;
}

export function syncUserPrompt(input: SyncInput): string {
  const cut = (text: string, n: number, tail = false): string => {
    const chars = [...modelText(text ?? '')];
    return chars.length <= n ? chars.join('') : (tail ? chars.slice(-n) : chars.slice(0, n)).join('');
  };
  return `Kohaku's previous reply:\n${cut(input.previousKohakuReply, 1500, true)}\n\n`
    + `ゆう's previous message:\n${cut(input.previousUserMessage, 600)}\n\n`
    + `ゆう's NEW message (Kohaku has not replied yet):\n${cut(input.latestUserMessage, 1500)}`;
}

export function parsePhrases(text: string): string[] | undefined {
  const match = /\{[\s\S]*\}/.exec(text ?? '');
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.queries)) return undefined;
    return parsed.queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0).map((q: string) => q.trim()).slice(0, 3);
  } catch {
    return undefined;
  }
}

/** Reciprocal rank fusion over ranked lists of memory IDs. */
export function fuse(lists: string[][], k = 60): SyncCandidate[] {
  const byId = new Map<string, SyncCandidate>();
  for (const list of lists) {
    list.forEach((memoryId, index) => {
      const entry = byId.get(memoryId) ?? { memory_id: memoryId, rrf: 0, lists: 0, best_rank: Infinity };
      entry.rrf += 1 / (k + index + 1);
      entry.lists += 1;
      entry.best_rank = Math.min(entry.best_rank, index + 1);
      byId.set(memoryId, entry);
    });
  }
  return [...byId.values()].sort((a, b) => b.rrf - a.rrf || a.best_rank - b.best_rank || a.memory_id.localeCompare(b.memory_id));
}

export function pickQuotes(memory: MemoryRecallResult, queryTexts: string[], maxQuotes: number): string[] {
  const query = bigrams(queryTexts.join(' '));
  const snippets = memory.quote_snippets ?? [];
  const scored = snippets.map((snippet, index) => ({ id: snippet.snippet_id, index, score: overlap(query, snippet.quote) }));
  const best = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, maxQuotes);
  const chosen = best.length ? best : scored.slice(0, maxQuotes);
  return chosen.sort((a, b) => a.index - b.index).map((x) => x.id);
}

/** A call that loses the race keeps running; it goes to `late` so a caller can wait for it and see its status. */
async function withTimeout<T>(promise: Promise<T>, ms: number, late: Promise<T>[]): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  try {
    const result = await Promise.race([promise, timeout]);
    if (result === 'timeout') late.push(promise);
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

export async function runSyncPass(runtime: RelationshipMemoryRuntime, transport: ChatTransport, input: SyncInput, config: SyncConfig): Promise<SyncResult> {
  return syncPass(runtime, transport, input, config, []);
}

/**
 * The same pass, plus `settled()`: it waits for model calls that timed out and returns the first provider error
 * among them (rate limit, server, transport). The hook path does not wait; a replay must, before it commits a turn.
 */
export async function runSyncPassSettled(runtime: RelationshipMemoryRuntime, transport: ChatTransport, input: SyncInput, config: SyncConfig): Promise<{ result: SyncResult; settled: () => Promise<string | undefined> }> {
  const late: Promise<ChatResult>[] = [];
  const result = await syncPass(runtime, transport, input, config, late);
  return {
    result,
    settled: async () => {
      const replies = await Promise.allSettled(late);
      for (const reply of replies) {
        if (reply.status === 'rejected') return 'transport';
        if (reply.value.errorClass !== 'none' && reply.value.errorClass !== 'malformed' && reply.value.errorClass !== 'client') return reply.value.errorClass;
      }
      return undefined;
    },
  };
}

async function syncPass(runtime: RelationshipMemoryRuntime, transport: ChatTransport, input: SyncInput, config: SyncConfig, late: Promise<ChatResult>[]): Promise<SyncResult> {
  const started = Date.now();
  const message = modelText(input.latestUserMessage);
  let phrases: string[] = [];
  let phraseStatus: SyncResult['phrase_status'] = 'ok';
  let usage: ChatUsage = {};
  let providerError: string | undefined;
  const phraseStarted = Date.now();
  const reply = await withTimeout(chat(transport, {
    model: config.model,
    messages: [{ role: 'system', content: SYNC_SYSTEM_PROMPT }, { role: 'user', content: syncUserPrompt(input) }],
    temperature: 0,
    max_tokens: 400,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
  }, `${input.sessionId}:sync`, { maxAttempts: 2, backoffMs: 300 }), config.phraseTimeoutMs ?? 4_000, late);
  const phraseMs = Date.now() - phraseStarted;
  if (reply === 'timeout') phraseStatus = 'timeout';
  else {
    usage = reply.usage;
    if (reply.errorClass !== 'none') providerError = reply.errorClass;
    const parsed = reply.errorClass === 'none' ? parsePhrases(String(reply.message?.content ?? '')) : undefined;
    if (parsed === undefined) phraseStatus = 'error';
    else if (!parsed.length) phraseStatus = 'none';
    else phrases = parsed;
  }

  const base = { phrases, phrase_status: phraseStatus, phrase_ms: phraseMs, usage, ...(providerError ? { provider_error: providerError } : {}) };
  // The model looked and found nothing worth recalling: stay quiet. On timeout or error, fall back to the message.
  if (phraseStatus === 'none') {
    return { ...base, search_ms: 0, total_ms: Date.now() - started, candidates: [], skip_reason: 'model_none' };
  }
  const searchStarted = Date.now();
  const queries = [...phrases, message].filter((q) => q.trim().length > 0);
  const results = await Promise.all(queries.map((query) => runtime.memorySearchRecallHybridWithEvidence({ query, limit: config.perListLimit ?? 10 } as any)));
  const searchMs = Date.now() - searchStarted;

  const known = new Set(input.sessionKnownMemoryIds);
  const byId = new Map<string, MemoryRecallResult>();
  const lists = results.map((list) => list.filter((memory) => {
    if (isKnown(memory, known)) return false;
    if (!byId.has(memory.memory_id)) byId.set(memory.memory_id, memory);
    return true;
  }).map((memory) => memory.memory_id));
  const candidates = fuse(lists);
  const top = candidates[0];
  const done = { ...base, search_ms: searchMs, total_ms: Date.now() - started, candidates: candidates.slice(0, 5) };
  if (!top) return { ...done, skip_reason: 'no_candidate' };
  const whisperOf = (memoryId: string) => ({ memory_id: memoryId, snippet_ids: pickQuotes(byId.get(memoryId)!, queries, config.maxQuotes ?? 2) });
  if ((config.gate ?? 'model') === 'rank') {
    if (top.lists < Math.min(config.minLists ?? 2, lists.length)) return { ...done, skip_reason: 'weak_support' };
    return { ...done, whisper: whisperOf(top.memory_id) };
  }
  const shown = candidates.slice(0, config.gateCandidates ?? 5).map((c) => {
    const m = byId.get(c.memory_id)! as MemoryRecallResult & Record<string, any>;
    return { memory_id: c.memory_id, kind: m.kind, summary: m.summary, observed: typeof m.observed_at === 'string' ? m.observed_at.slice(0, 10) : undefined };
  });
  const gateStarted = Date.now();
  const gate = await withTimeout(chat(transport, {
    model: config.model,
    messages: [{ role: 'system', content: SYNC_GATE_PROMPT }, { role: 'user', content: syncGatePrompt(input, shown) }],
    temperature: 0,
    max_tokens: 200,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
  }, `${input.sessionId}:sync`, { maxAttempts: 2, backoffMs: 300 }), config.phraseTimeoutMs ?? 4_000, late);
  const gateMs = Date.now() - gateStarted;
  const after = { ...done, total_ms: Date.now() - started, gate_ms: gateMs };
  if (gate === 'timeout') return { ...after, gate_status: 'timeout', skip_reason: 'gate_failed' };
  usage = { prompt_tokens: (usage.prompt_tokens ?? 0) + (gate.usage.prompt_tokens ?? 0), completion_tokens: (usage.completion_tokens ?? 0) + (gate.usage.completion_tokens ?? 0) };
  const text = String(gate.message?.content ?? '');
  const match = /\{[\s\S]*\}/.exec(text);
  let picked: string | null | undefined;
  try { picked = match ? JSON.parse(match[0]).memory_id : undefined; } catch { picked = undefined; }
  if (gate.errorClass !== 'none') return { ...after, usage, gate_status: 'error', skip_reason: 'gate_failed', provider_error: gate.errorClass };
  if (picked === undefined) return { ...after, usage, gate_status: 'error', skip_reason: 'gate_failed' };
  if (picked === null || !shown.some((c) => c.memory_id === picked)) return { ...after, usage, gate_status: 'ok', skip_reason: 'gate_none' };
  return { ...after, usage, gate_status: 'ok', whisper: whisperOf(String(picked)) };
}
