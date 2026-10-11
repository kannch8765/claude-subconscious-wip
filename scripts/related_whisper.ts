import type { EffectiveMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { lexicalTokenSet } from '../relationship-memory/src/retrieval/index.js';

export const RELATED_WHISPER_TOP_K = 2;
// Delivery budget only: the persisted relation graph has no degree/length cap.
export const RELATED_WHISPER_BUDGET_CHARS = 420;
const MMR_RELEVANCE_WEIGHT = 0.75;

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a.size <= b.size ? a : b) {
    if ((a.size <= b.size ? b : a).has(token)) shared += 1;
  }
  return shared;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const common = overlap(a, b);
  return common === 0 ? 0 : common / (a.size + b.size - common);
}

function queryCoverage(query: ReadonlySet<string>, candidate: ReadonlySet<string>): number {
  return query.size === 0 ? 0 : overlap(query, candidate) / query.size;
}

/**
 * Select at most two directly linked, non-redundant summaries. This is a small
 * lexical MMR reranker: no graph traversal, model action, or embedding API call.
 * topic is the compact query from the foreground search that found the primary.
 */
export function renderRelatedWhisperContext(
  mainMemoryId: string,
  currentMemories: readonly EffectiveMemoryRecord[],
  topic: string,
  sessionKnownIds: ReadonlySet<string> = new Set(),
  budget = RELATED_WHISPER_BUDGET_CHARS,
): string {
  const currentById = new Map(currentMemories
    .filter((memory) => memory.status === 'active')
    .map((memory) => [memory.memory_id, memory]));
  const main = currentById.get(mainMemoryId);
  if (!main || !main.linked_memory_ids?.length || budget <= 0) return '';

  const heading = '\n\n关联记忆（背景，仅摘要）：';
  let remaining = budget - heading.length;
  if (remaining <= 0) return '';

  const mainTokens = lexicalTokenSet(main.summary);
  const topicTokens = lexicalTokenSet(topic);
  const seen = new Set([main.summary.normalize('NFKC').trim().toLowerCase()]);
  const candidates = [...new Set(main.linked_memory_ids)]
    .filter((id) => id !== mainMemoryId && !sessionKnownIds.has(id))
    .map((id) => currentById.get(id))
    .filter((memory): memory is EffectiveMemoryRecord => Boolean(memory)
      && !(memory.resolution_source_memory_ids ?? [memory.memory_id])
        .some((sourceId) => sessionKnownIds.has(sourceId)))
    .flatMap((memory) => {
      const summary = memory.summary.trim();
      const key = summary.normalize('NFKC').toLowerCase();
      if (!summary || seen.has(key)) return [];
      seen.add(key);
      const line = `\n- ${summary}`;
      if (line.length > remaining) return [];
      const tokens = lexicalTokenSet(summary);
      const closenessToMain = jaccard(tokens, mainTokens);
      const relevance = topicTokens.size
        ? 0.7 * queryCoverage(topicTokens, tokens) + 0.3 * closenessToMain
        : closenessToMain;
      return [{ memory, line, tokens, relevance, closenessToMain }];
    });

  // When one or more neighbors have lexical support in this topic, do not
  // fill spare slots with unrelated zero-signal neighbors. If the entire
  // neighborhood has zero overlap (e.g. paraphrases across languages), keep
  // the owner-confirmed edges as a useful fallback rather than hiding all.
  const supported = candidates.some((candidate) => candidate.relevance > 0);
  const pool = supported ? candidates.filter((candidate) => candidate.relevance > 0) : candidates;
  const selected: typeof candidates = [];
  while (selected.length < RELATED_WHISPER_TOP_K) {
    let best: (typeof candidates)[number] | undefined;
    let bestScore = -Infinity;
    for (const candidate of pool) {
      if (selected.includes(candidate) || candidate.line.length > remaining) continue;
      const redundancy = Math.max(candidate.closenessToMain,
        ...selected.map((item) => jaccard(candidate.tokens, item.tokens)));
      const score = MMR_RELEVANCE_WEIGHT * candidate.relevance
        - (1 - MMR_RELEVANCE_WEIGHT) * redundancy;
      if (score > bestScore || (score === bestScore && best
        && (candidate.memory.observed_at > best.memory.observed_at
          || (candidate.memory.observed_at === best.memory.observed_at
            && candidate.memory.memory_id < best.memory.memory_id)))) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    selected.push(best);
    remaining -= best.line.length;
  }
  return selected.length ? heading + selected.map((item) => item.line).join('') : '';
}
