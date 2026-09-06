import * as fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';

export type RecallTimingPhase = 'initial' | 'expand_recall' | 'unscoped' | 'total';

export interface RecallTimingContext {
  recall_id: string;
  phase: Extract<RecallTimingPhase, 'initial' | 'expand_recall'>;
}

export interface RecallTimingEvent {
  schema_version: 1;
  event: 'relationship_memory_recall_timing';
  recall_id: string;
  phase: RecallTimingPhase;
  segment: string;
  duration_ms: number;
  [key: string]: string | number | boolean;
}

export function recallTimingEnabled(): boolean {
  const value = process.env.RELATIONSHIP_MEMORY_RECALL_TIMING?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function monotonicNow(): number {
  return performance.now();
}

const recallTimingContextStore = new AsyncLocalStorage<RecallTimingContext>();
let unscopedEventIndex = 0;

export async function withRecallTimingContext<T>(context: RecallTimingContext, fn: () => Promise<T>): Promise<T> {
  return recallTimingContextStore.run(context, fn);
}

export function recallTimingContext(): RecallTimingContext | undefined {
  return recallTimingContextStore.getStore();
}

export function emitRecallTiming(event: RecallTimingEvent): void {
  if (!recallTimingEnabled()) return;
  try {
    const line = `${JSON.stringify(event)}\n`;
    const file = process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE?.trim();
    if (file) fs.appendFileSync(file, line, 'utf8');
    else process.stderr.write(line);
  } catch {
    // Observability must never change recall behavior.
  }
}

export function timingDurationMs(startedAt: number): number {
  return Math.max(0, monotonicNow() - startedAt);
}

export function emitRecallTimingSegment(
  segment: string,
  startedAt: number,
  extra: Record<string, string | number | boolean> = {},
): void {
  if (!recallTimingEnabled()) return;
  const context = recallTimingContext();
  if (!context) {
    unscopedEventIndex += 1;
    emitRecallTiming({
      schema_version: 1,
      event: 'relationship_memory_recall_timing',
      recall_id: 'unscoped',
      phase: 'unscoped',
      segment,
      duration_ms: timingDurationMs(startedAt),
      context_missing: true,
      event_index: unscopedEventIndex,
      ...extra,
    });
    return;
  }
  emitRecallTiming({
    schema_version: 1,
    event: 'relationship_memory_recall_timing',
    recall_id: context.recall_id,
    phase: context.phase,
    segment,
    duration_ms: timingDurationMs(startedAt),
    ...extra,
  });
}
