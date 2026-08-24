import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  createRuntime,
  relationshipMemoryRoot,
  semanticText,
  type MemoryRecallCandidate,
  type RelationshipMemoryRuntime,
  type RecallQuoteSnippet,
} from '../relationship-memory/src/index.js';
import { createRerankerFromEnvironment, type Reranker, type RerankResult } from '../relationship-memory/src/rerank/index.js';
import { extractLexicalAnchorAnalysis, readLexicalAnchorAliases } from '../relationship-memory/src/anchor/index.js';
import { escapeXmlContent } from './conversation_utils.js';

export const DEFAULT_SYNC_RECALL_TOP_K = 20;
export const DEFAULT_SYNC_RECALL_SNIPPET_LIMIT = 3;
export const MEMORY_RERANK_INSTRUCTION = 'Rank historical relationship memories by semantic relevance to the current user message. Prefer the same underlying shared experience, personal experience, relationship event, inside joke, preference, or identity over surface word overlap.';
export const SNIPPET_RERANK_INSTRUCTION = 'Rank historical source excerpts by how directly they support the recalled canonical memory named in the query. Use the current user message only as context or a tie-breaker; prefer evidence for the memory over surface similarity to the current message.';

export interface SyncRecallSelectedSnippet extends RecallQuoteSnippet {
  rerank_score: number;
  rerank_rank: number;
}

export interface SyncRecallSelection {
  memory: MemoryRecallCandidate;
  memory_rerank_score: number;
  memory_rerank_rank: number;
  snippets: SyncRecallSelectedSnippet[];
  body: string;
  envelope: string;
}

export interface SyncRecallDiagnosticCandidate {
  memory_id: string;
  summary: string;
  first_stage_rank: number;
  lexical_score: number;
  semantic_score?: number;
  hybrid_score: number;
  rerank_rank?: number;
  rerank_score?: number;
  quote_snippet_count: number;
}

export interface SyncRecallRunResult {
  status: 'ok' | 'empty_query' | 'reranker_disabled' | 'no_candidates' | 'no_grounded_candidate' | 'failed';
  query_sha256: string;
  elapsed_ms: number;
  reranker_model?: string;
  candidates: SyncRecallDiagnosticCandidate[];
  selected?: SyncRecallSelection;
  error?: string;
}

export interface SyncRecallDependencies {
  runtime?: RelationshipMemoryRuntime;
  reranker?: Reranker;
  now?: () => string;
}

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function hashQuery(query: string): string {
  return crypto.createHash('sha256').update(query).digest('hex');
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function memoryDocument(memory: MemoryRecallCandidate): string {
  return semanticText(memory.kind, memory.summary, memory.participants, memory.payload);
}

function snippetDocument(snippet: RecallQuoteSnippet): string {
  const speaker = snippet.source_kind === 'legacy_memory'
    ? '旧记忆记录'
    : snippet.role === 'assistant' ? '当时琥珀' : '猫';
  return `${speaker}: ${snippet.quote}`;
}

export function snippetRerankQuery(memory: Pick<MemoryRecallCandidate, 'summary'>, currentQuery: string): string {
  return [
    `Recalled canonical memory: ${memory.summary}`,
    `Current user message: ${currentQuery}`,
  ].join('\n');
}

export function renderHistoricalRecallQuotes(snippets: readonly RecallQuoteSnippet[]): string {
  const lines: string[] = [];
  let activeDate = '';
  for (const snippet of snippets) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(snippet.captured_at)?.[0] ?? '过去';
    if (date !== activeDate) {
      lines.push(`[${date}]`);
      activeDate = date;
    }
    const speaker = snippet.source_kind === 'legacy_memory'
      ? '旧记忆记录'
      : snippet.role === 'assistant' ? '当时琥珀' : '猫';
    lines.push(`${speaker}：「${snippet.quote}」`);
  }
  return lines.join('\n');
}

export function renderSyncRecallBody(memory: Pick<MemoryRecallCandidate, 'summary'>, snippets: readonly RecallQuoteSnippet[]): string {
  const historical = renderHistoricalRecallQuotes(snippets);
  return historical ? `记忆：${memory.summary}\n\n${historical}` : `记忆：${memory.summary}`;
}

export function renderSyncRecallEnvelope(body: string, timestamp: string): string {
  return `<subcon_whisper source="sync_recall" timestamp="${timestamp}">\n${escapeXmlContent(body)}\n</subcon_whisper>`;
}

function rerankMap(results: readonly RerankResult[]): Map<string, { rank: number; score: number }> {
  return new Map(results.map((item, index) => [item.id, { rank: index + 1, score: item.score }]));
}

export async function selectSyncRecall(
  query: string,
  candidates: readonly MemoryRecallCandidate[],
  reranker: Reranker,
  options: { snippetLimit?: number; now?: () => string } = {},
): Promise<{ selection?: SyncRecallSelection; diagnostics: SyncRecallDiagnosticCandidate[] }> {
  const snippetLimit = Math.max(1, Math.min(options.snippetLimit ?? DEFAULT_SYNC_RECALL_SNIPPET_LIMIT, 3));
  const now = options.now ?? (() => new Date().toISOString());
  if (candidates.length === 0) return { diagnostics: [] };

  const memoryDocs = candidates.map((memory) => ({ id: `memory:${memory.memory_id}`, text: memoryDocument(memory) }));
  const memoryRanking = await reranker.rank(memoryDocs, query, {
    topN: memoryDocs.length,
    instruction: MEMORY_RERANK_INSTRUCTION,
  });
  const memoryRanks = rerankMap(memoryRanking);
  const diagnostics: SyncRecallDiagnosticCandidate[] = candidates.map((memory) => {
    const reranked = memoryRanks.get(`memory:${memory.memory_id}`);
    return {
      memory_id: memory.memory_id,
      summary: memory.summary,
      first_stage_rank: memory.retrieval.first_stage_rank,
      lexical_score: memory.retrieval.lexical_score,
      ...(memory.retrieval.semantic_score === undefined ? {} : { semantic_score: memory.retrieval.semantic_score }),
      hybrid_score: memory.retrieval.hybrid_score,
      ...(reranked ? { rerank_rank: reranked.rank, rerank_score: reranked.score } : {}),
      quote_snippet_count: memory.quote_snippets.length,
    };
  });

  for (const rankedMemory of memoryRanking) {
    const memory = candidates[rankedMemory.index];
    if (!memory || memory.quote_snippets.length === 0) continue;
    const snippetDocs = memory.quote_snippets.map((snippet) => ({ id: snippet.snippet_id, text: snippetDocument(snippet) }));
    const snippetRanking = await reranker.rank(snippetDocs, snippetRerankQuery(memory, query), {
      topN: Math.min(snippetLimit, snippetDocs.length),
      instruction: SNIPPET_RERANK_INSTRUCTION,
    });
    if (snippetRanking.length === 0) continue;
    const selected = snippetRanking.map((item, index) => ({
      ...memory.quote_snippets[item.index],
      rerank_score: item.score,
      rerank_rank: index + 1,
    }));
    const sourceOrder = new Map(memory.quote_snippets.map((snippet, index) => [snippet.snippet_id, index]));
    selected.sort((a, b) => a.captured_at.localeCompare(b.captured_at)
      || (sourceOrder.get(a.snippet_id) ?? 0) - (sourceOrder.get(b.snippet_id) ?? 0));
    const body = renderSyncRecallBody(memory, selected);
    return {
      diagnostics,
      selection: {
        memory,
        memory_rerank_score: rankedMemory.score,
        memory_rerank_rank: memoryRanks.get(`memory:${memory.memory_id}`)?.rank ?? 1,
        snippets: selected,
        body,
        envelope: renderSyncRecallEnvelope(body, now()),
      },
    };
  }
  return { diagnostics };
}

export async function runDeterministicSyncRecall(
  query: string,
  dependencies: SyncRecallDependencies = {},
): Promise<SyncRecallRunResult> {
  const startedAt = Date.now();
  const normalizedQuery = query.trim();
  const querySha256 = hashQuery(normalizedQuery);
  if (!normalizedQuery) return { status: 'empty_query', query_sha256: querySha256, elapsed_ms: Date.now() - startedAt, candidates: [] };

  try {
    const reranker = dependencies.reranker ?? createRerankerFromEnvironment();
    if (!reranker) return { status: 'reranker_disabled', query_sha256: querySha256, elapsed_ms: Date.now() - startedAt, candidates: [] };
    const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
    const runtime = dependencies.runtime ?? createRuntime([], subjectId, relationshipMemoryRoot(), []);
    const topK = boundedInteger(process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_TOP_K, DEFAULT_SYNC_RECALL_TOP_K, 20);
    const snippetLimit = boundedInteger(process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SNIPPET_LIMIT, DEFAULT_SYNC_RECALL_SNIPPET_LIMIT, 3);
    const candidates = await runtime.memorySearchRecallCandidatesWithEvidence({ query: normalizedQuery, limit: topK });
    if (candidates.length === 0) {
      return { status: 'no_candidates', query_sha256: querySha256, elapsed_ms: Date.now() - startedAt, reranker_model: reranker.model, candidates: [] };
    }
    const selected = await selectSyncRecall(normalizedQuery, candidates, reranker, { snippetLimit, now: dependencies.now });
    return {
      status: selected.selection ? 'ok' : 'no_grounded_candidate',
      query_sha256: querySha256,
      elapsed_ms: Date.now() - startedAt,
      reranker_model: reranker.model,
      candidates: selected.diagnostics,
      ...(selected.selection ? { selected: selected.selection } : {}),
    };
  } catch (error) {
    return {
      status: 'failed',
      query_sha256: querySha256,
      elapsed_ms: Date.now() - startedAt,
      candidates: [],
      error: boundedError(error),
    };
  }
}


export interface SyncRecallAnchorShadowCandidate {
  memory_id: string;
  summary: string;
  anchor_rank: number;
  anchor_score: number;
  matched_anchor_count: number;
  anchor_count: number;
}

export interface SyncRecallAnchorShadowFusedCandidate {
  memory_id: string;
  summary: string;
  rrf_score: number;
  raw_first_stage_rank?: number;
  anchor_rank?: number;
}

export interface SyncRecallAnchorShadow {
  status: 'ok' | 'no_anchors' | 'no_candidates' | 'failed';
  anchor_set_sha256: string;
  anchor_count: number;
  context_signal_count: number;
  anchors?: string[];
  context_signals?: string[];
  candidates: SyncRecallAnchorShadowCandidate[];
  raw_selected_anchor_rank?: number;
  top_agrees_with_raw_selected?: boolean;
  fused_candidates: SyncRecallAnchorShadowFusedCandidate[];
  error?: string;
}

function reciprocalRank(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (60 + rank);
}

export function runDeterministicAnchorShadow(
  query: string,
  rawResult: SyncRecallRunResult,
  runtime: RelationshipMemoryRuntime,
): SyncRecallAnchorShadow {
  const aliases = readLexicalAnchorAliases(process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_ANCHOR_ALIASES_FILE);
  const analysis = extractLexicalAnchorAnalysis(query, aliases);
  const includeAnchors = process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SHADOW_INCLUDE_ANCHORS === '1';
  const base = {
    anchor_set_sha256: analysis.anchor_set_sha256,
    anchor_count: analysis.anchors.length,
    context_signal_count: analysis.context_signals.length,
    ...(includeAnchors ? { anchors: analysis.anchors, context_signals: analysis.context_signals } : {}),
  };
  if (analysis.anchors.length === 0) {
    return { status: 'no_anchors', ...base, candidates: [], fused_candidates: [] };
  }

  try {
    const topK = boundedInteger(process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_ANCHOR_TOP_K, DEFAULT_SYNC_RECALL_TOP_K, 20);
    const anchorCandidates = runtime.memorySearchRecallAnchorCandidates(analysis.anchors, topK);
    if (anchorCandidates.length === 0) {
      return { status: 'no_candidates', ...base, candidates: [], fused_candidates: [] };
    }
    const candidates: SyncRecallAnchorShadowCandidate[] = anchorCandidates.map((memory) => ({
      memory_id: memory.memory_id,
      summary: memory.summary,
      anchor_rank: memory.anchor_retrieval.first_stage_rank,
      anchor_score: memory.anchor_retrieval.anchor_score,
      matched_anchor_count: memory.anchor_retrieval.matched_anchor_count,
      anchor_count: memory.anchor_retrieval.anchor_count,
    }));

    const rawSelectedId = rawResult.selected?.memory.memory_id;
    const rawSelectedAnchorRank = rawSelectedId
      ? candidates.find((candidate) => candidate.memory_id === rawSelectedId)?.anchor_rank
      : undefined;

    const byId = new Map<string, SyncRecallAnchorShadowFusedCandidate>();
    for (const raw of rawResult.candidates) {
      byId.set(raw.memory_id, {
        memory_id: raw.memory_id,
        summary: raw.summary,
        raw_first_stage_rank: raw.first_stage_rank,
        rrf_score: reciprocalRank(raw.first_stage_rank),
      });
    }
    for (const anchor of candidates) {
      const existing = byId.get(anchor.memory_id);
      byId.set(anchor.memory_id, {
        memory_id: anchor.memory_id,
        summary: anchor.summary,
        ...(existing?.raw_first_stage_rank === undefined ? {} : { raw_first_stage_rank: existing.raw_first_stage_rank }),
        anchor_rank: anchor.anchor_rank,
        rrf_score: (existing?.rrf_score ?? 0) + reciprocalRank(anchor.anchor_rank),
      });
    }
    const fusedCandidates = [...byId.values()]
      .sort((a, b) => b.rrf_score - a.rrf_score || a.memory_id.localeCompare(b.memory_id))
      .slice(0, 5);

    return {
      status: 'ok',
      ...base,
      candidates,
      ...(rawSelectedId ? {
        ...(rawSelectedAnchorRank === undefined ? {} : { raw_selected_anchor_rank: rawSelectedAnchorRank }),
        top_agrees_with_raw_selected: candidates[0]?.memory_id === rawSelectedId,
      } : {}),
      fused_candidates: fusedCandidates,
    };
  } catch (error) {
    return {
      status: 'failed',
      ...base,
      candidates: [],
      fused_candidates: [],
      error: boundedError(error),
    };
  }
}


export interface SyncRecallShadowReceipt {
  schema_version: 1;
  recorded_at: string;
  session_id: string;
  cwd?: string;
  query_sha256: string;
  query_preview?: string;
  anchor_shadow?: SyncRecallAnchorShadow;
  result: Omit<SyncRecallRunResult, 'selected'> & {
    selected?: {
      memory_id: string;
      summary: string;
      memory_rerank_score: number;
      memory_rerank_rank: number;
      snippets: Array<{ snippet_id: string; source_kind: string; role?: string; quote: string; captured_at: string; rerank_score: number; rerank_rank: number }>;
      body: string;
    };
  };
}

export function shadowReceiptFile(): string {
  return process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SHADOW_LOG?.trim()
    || `${relationshipMemoryRoot()}-sync-recall-shadow/receipts.jsonl`;
}

export function makeShadowReceipt(
  sessionId: string,
  cwd: string | undefined,
  query: string,
  result: SyncRecallRunResult,
  recordedAt = new Date().toISOString(),
  anchorShadow?: SyncRecallAnchorShadow,
): SyncRecallShadowReceipt {
  const includeQuery = process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SHADOW_INCLUDE_QUERY === '1';
  return {
    schema_version: 1,
    recorded_at: recordedAt,
    session_id: sessionId,
    ...(cwd ? { cwd } : {}),
    query_sha256: result.query_sha256,
    ...(includeQuery ? { query_preview: [...query].slice(0, 800).join('') } : {}),
    ...(anchorShadow ? { anchor_shadow: anchorShadow } : {}),
    result: {
      status: result.status,
      query_sha256: result.query_sha256,
      elapsed_ms: result.elapsed_ms,
      ...(result.reranker_model ? { reranker_model: result.reranker_model } : {}),
      candidates: result.candidates,
      ...(result.error ? { error: result.error } : {}),
      ...(result.selected ? {
        selected: {
          memory_id: result.selected.memory.memory_id,
          summary: result.selected.memory.summary,
          memory_rerank_score: result.selected.memory_rerank_score,
          memory_rerank_rank: result.selected.memory_rerank_rank,
          snippets: result.selected.snippets.map((snippet) => ({
            snippet_id: snippet.snippet_id,
            source_kind: snippet.source_kind,
            ...(snippet.role ? { role: snippet.role } : {}),
            quote: snippet.quote,
            captured_at: snippet.captured_at,
            rerank_score: snippet.rerank_score,
            rerank_rank: snippet.rerank_rank,
          })),
          body: result.selected.body,
        },
      } : {}),
    },
  };
}

export function appendShadowReceipt(receipt: SyncRecallShadowReceipt, file = shadowReceiptFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { }
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { }
}
