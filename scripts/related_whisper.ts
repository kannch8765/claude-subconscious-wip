import type { EffectiveMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { lexicalTextScore } from '../relationship-memory/src/retrieval/index.js';

// This is a delivery budget, not a limit on stored relations or graph degree.
export const RELATED_WHISPER_BUDGET_CHARS = 420;

export function renderRelatedWhisperContext(
  mainMemoryId: string,
  currentMemories: readonly EffectiveMemoryRecord[],
  currentTopic: string,
  sessionKnownIds: ReadonlySet<string> = new Set(),
  budget = RELATED_WHISPER_BUDGET_CHARS,
): string {
  const currentById = new Map(currentMemories
    .filter((memory) => memory.status === 'active')
    .map((memory) => [memory.memory_id, memory]));
  const main = currentById.get(mainMemoryId);
  if (!main || !main.linked_memory_ids?.length || budget <= 0) return '';

  const seen = new Set([main.summary.normalize('NFKC').trim().toLowerCase()]);
  const candidates = [...new Set(main.linked_memory_ids)]
    .filter((id) => id !== mainMemoryId && !sessionKnownIds.has(id))
    .map((id) => currentById.get(id))
    .filter((memory): memory is EffectiveMemoryRecord => Boolean(memory)
      && !(memory.resolution_source_memory_ids ?? [memory.memory_id])
        .some((sourceId) => sessionKnownIds.has(sourceId)))
    .map((memory) => ({
      memory,
      relevance: lexicalTextScore(memory.summary, currentTopic),
    }))
    .sort((a, b) => b.relevance - a.relevance
      || b.memory.observed_at.localeCompare(a.memory.observed_at)
      || a.memory.memory_id.localeCompare(b.memory.memory_id));

  const heading = '\n\n关联记忆（背景，仅摘要）：';
  let remaining = budget - heading.length;
  const summaries: string[] = [];
  for (const { memory } of candidates) {
    const summary = memory.summary.trim();
    const key = summary.normalize('NFKC').toLowerCase();
    if (!summary || seen.has(key)) continue;
    seen.add(key);
    const line = `\n- ${summary}`;
    if (line.length > remaining) continue;
    summaries.push(line);
    remaining -= line.length;
  }
  return summaries.length ? heading + summaries.join('') : '';
}
