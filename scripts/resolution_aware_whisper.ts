import type { EffectiveMemoryRecord, EvidenceRecord } from '../relationship-memory/src/schema/index.js';
import { renderRelatedWhisperContext } from './related_whisper.js';

const HISTORICAL_CONTEXT_BUDGET = 420;
const HISTORICAL_CONTEXT_MAX_RECORDS = 3;

export interface ResolutionAwareWhisperInput {
  memoryId: string;
  historicalWindow: string;
  currentMemories: readonly EffectiveMemoryRecord[];
  historicalMemories?: readonly EffectiveMemoryRecord[];
  historicalEvidence?: readonly EvidenceRecord[];
  topic: string;
  sessionKnownIds?: ReadonlySet<string>;
}

/**
 * Transport-only formatting. The Agent still chooses the memory and its
 * 1–3 source quote IDs; no relation-specific Agent instructions or tool calls.
 *
 * Returns null if the selected memory is no longer current/active, e.g. an
 * owner conflict resolution was applied after search but before delivery.
 */
export function renderResolutionAwareWhisper(input: ResolutionAwareWhisperInput): string | null {
  const current = input.currentMemories.find(
    (item) => item.memory_id === input.memoryId && item.status === 'active',
  );
  if (!current) return null;

  const qualifiers: string[] = [];
  const context = current.resolution_context?.trim();
  if (context) qualifiers.push(`适用条件（已审核）：${context}`);

  const historicalIds = current.resolution_historical_memory_ids ?? [];
  if (historicalIds.length) {
    const byId = new Map((input.historicalMemories ?? []).map((item) => [item.memory_id, item]));
    const old = historicalIds.flatMap((id) => {
      const memory = byId.get(id);
      if (!memory?.summary.trim()) return [];
      const date = /^\d{4}-\d{2}-\d{2}/.exec(memory.observed_at)?.[0] ?? '过去';
      return [{ memory, date }];
    }).sort((a, b) => b.memory.observed_at.localeCompare(a.memory.observed_at));
    const evidenceById = new Map<string, EvidenceRecord[]>();
    for (const evidence of input.historicalEvidence ?? []) {
      if (evidence.event_kind && evidence.event_kind !== 'user_text' && evidence.event_kind !== 'assistant_text') continue;
      const entries = evidenceById.get(evidence.memory_id) ?? [];
      entries.push(evidence);
      evidenceById.set(evidence.memory_id, entries);
    }
    let remaining = HISTORICAL_CONTEXT_BUDGET;
    const lines: string[] = [];
    let historicalRecordCount = 0;
    for (const { memory, date } of old) {
      if (historicalRecordCount >= HISTORICAL_CONTEXT_MAX_RECORDS) break;
      const line = `- [${date}] ${memory.summary.trim()}`;
      if (line.length > remaining) continue;
      remaining -= line.length;
      lines.push(line);
      historicalRecordCount += 1;
      // The old words are optional: never synthesize or truncate a quote.
      // Add at most one short exact transcript sentence per historical state.
      const evidence = [...(evidenceById.get(memory.memory_id) ?? [])]
        .sort((a, b) => b.captured_at.localeCompare(a.captured_at) || a.evidence_id.localeCompare(b.evidence_id))
        .find((item) => item.quote.trim());
      if (evidence) {
        const raw = evidence.quote.trim();
        const firstSentence = raw.match(/^[^。！？!?]+[。！？!?]/u)?.[0] ?? raw;
        const speaker = evidence.role === 'assistant' ? '当时琥珀' : '猫';
        const quoted = `  ${speaker}原话：「${firstSentence}」`;
        if (quoted.length <= remaining && quoted.length <= 220) {
          lines.push(quoted);
          remaining -= quoted.length;
        }
      }
    }
    if (lines.length) qualifiers.push(`历史阶段（不代表当前状态）：\n${lines.join('\n')}`);
  }

  // Keep the model-selected, source-faithful quotes exactly as they were:
  // insert audited qualifiers between the summary line and the quote section.
  const separator = input.historicalWindow.indexOf('\n\n');
  // The owner can edit a summary while Subcon is considering its search
  // result. Delivery must use the latest reviewed semantic text, not an old
  // snapshot header, without touching the Agent-selected exact quote body.
  const header = `记忆：${current.summary.trim()}`;
  const quotes = separator < 0 ? '' : input.historicalWindow.slice(separator);
  const qualified = qualifiers.length
    ? `${header}\n${qualifiers.join('\n')}${quotes}`
    : `${header}${quotes}`;

  const related = renderRelatedWhisperContext(
    current.memory_id, input.currentMemories, input.topic,
    input.sessionKnownIds ?? new Set(),
  );
  return qualified + related;
}
