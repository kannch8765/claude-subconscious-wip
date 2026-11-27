/**
 * Model view of memory_search results (docs/specs/OWN-HARNESS-DESIGN.md §4.3.1).
 *
 * Content stays untouched (summary, payload, every quote); only fields the model
 * never needs are dropped. Quotes are numbered 1..k per memory and the runtime
 * maps the numbers back, so deliver_whisper still references real snippet_ids.
 */
import type { MemoryRecallResult, RecallQuoteSnippet } from '../relationship-memory/src/tools/index.js';

export interface SlimQuote { n: number; r: 'u' | 'a' | 'legacy'; d: string; q: string }

export interface SlimMemory {
  memory_id: string;
  kind: string;
  summary: string;
  participants: string[];
  observed: string;
  payload: unknown;
  linked_memory_ids?: string[];
  reinforcements?: number;
  owner_corrected?: true;
  quotes: SlimQuote[];
}

/** Quotes surfaced in one pass, numbered 1..k per memory in the order the model saw them. */
export class SnippetHandles {
  private readonly byMemory = new Map<string, string[]>();

  numberFor(memoryId: string, snippetId: string): number {
    const list = this.byMemory.get(memoryId) ?? [];
    let index = list.indexOf(snippetId);
    if (index < 0) { list.push(snippetId); index = list.length - 1; }
    this.byMemory.set(memoryId, list);
    return index + 1;
  }

  count(memoryId: string): number {
    return this.byMemory.get(memoryId)?.length ?? 0;
  }

  resolve(memoryId: string, quoteNumber: number): string | undefined {
    return this.byMemory.get(memoryId)?.[quoteNumber - 1];
  }
}

/**
 * Text as the model sees it. Live-location tags carry coordinates, accuracy and
 * heading the model cannot use, and in a short message they are most of the
 * text, so searches drift to other memories that also hold such a tag. Keep only
 * the reverse-geocoded place; drop the tag when there is none. The store keeps the original.
 */
export function modelText(text: string): string {
  return text
    .replace(/<telegram_live_location\b[^>]*?\bplace="([^"]*)"[^>]*\/?>/g, (_m, place: string) => `［位置：${place}］`)
    .replace(/<telegram_live_location\b[^>]*\/?>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function day(value: string | undefined): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function slimQuote(memoryId: string, snippet: RecallQuoteSnippet, handles: SnippetHandles): SlimQuote {
  const role = snippet.source_kind === 'legacy_memory' ? 'legacy' : snippet.role === 'user' ? 'u' : 'a';
  return { n: handles.numberFor(memoryId, snippet.snippet_id), r: role, d: day(snippet.captured_at), q: modelText(snippet.quote) };
}

export function isKnown(memory: MemoryRecallResult, known: ReadonlySet<string>): boolean {
  const m = memory as MemoryRecallResult & Record<string, any>;
  return (m.resolution_source_memory_ids ?? [m.memory_id]).some((id: string) => known.has(id));
}

export function slimMemory(memory: MemoryRecallResult, handles: SnippetHandles): SlimMemory {
  const m = memory as MemoryRecallResult & Record<string, any>;
  return {
    memory_id: m.memory_id,
    kind: m.kind,
    summary: m.summary,
    participants: m.participants,
    observed: day(m.observed_at),
    payload: m.payload,
    ...(m.linked_memory_ids?.length ? { linked_memory_ids: m.linked_memory_ids } : {}),
    ...(m.reinforcement_count ? { reinforcements: m.reinforcement_count } : {}),
    ...(m.owner_corrected === true ? { owner_corrected: true as const } : {}),
    quotes: (m.quote_snippets ?? []).map((snippet: RecallQuoteSnippet) => slimQuote(m.memory_id, snippet, handles)),
  };
}
