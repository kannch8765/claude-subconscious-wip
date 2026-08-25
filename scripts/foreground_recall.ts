import * as crypto from 'crypto';
import { escapeXmlContent } from './conversation_utils.js';

export const DEFAULT_FOREGROUND_RECALL_LIMIT = 8;

export interface ForegroundRecallSnippet {
  snippet_id: string;
  source_kind: 'transcript' | 'legacy_memory';
  role?: 'user' | 'assistant';
  quote: string;
  captured_at: string;
}

export interface ForegroundRecallCandidate {
  memory_id: string;
  summary: string;
  kind?: string;
  observed_at?: string;
  quote_snippets: ForegroundRecallSnippet[];
}

export interface ForegroundRecallBundle {
  schema_version: 1;
  bundle_id: string;
  session_id: string;
  turn_id: string;
  query_sha256: string;
  created_at: string;
  candidates: ForegroundRecallCandidate[];
}

export interface ForegroundRecallSearchRuntime {
  memorySearchRecallHybridWithEvidence(args: { query: string; limit?: number }): Promise<unknown[]>;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asCandidate(value: unknown): ForegroundRecallCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const memoryId = typeof raw.memory_id === 'string' ? raw.memory_id.trim() : '';
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!memoryId || !summary) return null;
  const snippets: ForegroundRecallSnippet[] = [];
  if (Array.isArray(raw.quote_snippets)) {
    for (const item of raw.quote_snippets) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const snippet = item as Record<string, unknown>;
      const sourceKind = snippet.source_kind;
      const role = snippet.role;
      const validTranscript = sourceKind === 'transcript' && (role === 'user' || role === 'assistant');
      const validLegacy = sourceKind === 'legacy_memory';
      if (!validTranscript && !validLegacy) continue;
      if (typeof snippet.snippet_id !== 'string' || !snippet.snippet_id.trim()) continue;
      if (typeof snippet.quote !== 'string' || typeof snippet.captured_at !== 'string') continue;
      snippets.push({
        snippet_id: snippet.snippet_id.trim(),
        source_kind: sourceKind,
        ...(validTranscript ? { role } : {}),
        quote: snippet.quote,
        captured_at: snippet.captured_at,
      });
    }
  }
  return {
    memory_id: memoryId,
    summary,
    ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
    ...(typeof raw.observed_at === 'string' ? { observed_at: raw.observed_at } : {}),
    quote_snippets: snippets,
  };
}

export async function buildForegroundRecallBundle(
  runtime: ForegroundRecallSearchRuntime,
  query: string,
  options: { sessionId: string; turnId: string; limit?: number; now?: () => string },
): Promise<ForegroundRecallBundle> {
  const normalized = query.trim();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_FOREGROUND_RECALL_LIMIT, 12));
  const results = normalized ? await runtime.memorySearchRecallHybridWithEvidence({ query: normalized, limit }) : [];
  const candidates = results.map(asCandidate).filter((item): item is ForegroundRecallCandidate => Boolean(item));
  const querySha256 = sha256(normalized);
  const bundleId = `fg_bundle_${sha256(`${options.sessionId}\0${options.turnId}\0${querySha256}`).slice(0, 24)}`;
  return {
    schema_version: 1,
    bundle_id: bundleId,
    session_id: options.sessionId,
    turn_id: options.turnId,
    query_sha256: querySha256,
    created_at: (options.now ?? (() => new Date().toISOString()))(),
    candidates,
  };
}

export function renderForegroundRecallBundle(bundle: ForegroundRecallBundle): string {
  const rendered = bundle.candidates.map((memory, memoryIndex) => {
    const snippets = memory.quote_snippets.map((snippet) => {
      const speaker = snippet.source_kind === 'legacy_memory'
        ? '旧记忆记录'
        : snippet.role === 'assistant' ? '当时琥珀' : '猫';
      return `<snippet snippet_id="${escapeXmlContent(snippet.snippet_id)}" source_kind="${snippet.source_kind}" captured_at="${escapeXmlContent(snippet.captured_at)}">${escapeXmlContent(`${speaker}：${snippet.quote}`)}</snippet>`;
    }).join('\n');
    return `<candidate rank="${memoryIndex + 1}" memory_id="${escapeXmlContent(memory.memory_id)}">\n<summary>${escapeXmlContent(memory.summary)}</summary>\n${snippets}\n</candidate>`;
  }).join('\n');
  return `<foreground_recall_bundle schema_version="1" bundle_id="${escapeXmlContent(bundle.bundle_id)}">\n${rendered}\n</foreground_recall_bundle>`;
}

export function candidateRefs(bundle: ForegroundRecallBundle): Array<{ memory_id: string; snippet_ids: string[] }> {
  return bundle.candidates.map((candidate) => ({
    memory_id: candidate.memory_id,
    snippet_ids: candidate.quote_snippets.map((snippet) => snippet.snippet_id),
  }));
}
