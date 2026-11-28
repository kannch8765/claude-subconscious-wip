import type { EffectiveMemoryRecord, WorldRevisionRecord } from '../relationship-memory/src/schema/index.js';

function day(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? value;
}

/**
 * Whisper text for one world_update (knowledge patch): the anchor's timeline in recorded_at order, oldest first. `as_of`
 * is shown but never reorders; only the head (the last line) carries 最新 and last_confirmed. Pure: no I/O.
 *
 * Takes the effective view with its revision chain (`RelationshipMemoryRuntime.currentWorldUpdate`). Returns null for
 * anything that is not a world_update with a view.
 */
export function renderWorldUpdateTimeline(memory: Pick<EffectiveMemoryRecord, 'kind' | 'payload' | 'world_update'>): string | null {
  const view = memory.world_update;
  if (memory.kind !== 'world_update' || !view) return null;
  const chain: Array<Pick<WorldRevisionRecord, 'fact' | 'as_of'>> = view.revisions?.length
    ? [...view.revisions].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.revision_id.localeCompare(b.revision_id))
    : [view.head];
  const lines = chain.map((step, index) => {
    const line = `· ${day(step.as_of)} 起：${step.fact}`;
    return index === chain.length - 1 ? `${line}　← 最新（截至 ${day(view.last_confirmed)}）` : line;
  });
  return [`（知识补丁）${String(memory.payload.topic ?? '')}`, ...lines].join('\n');
}
