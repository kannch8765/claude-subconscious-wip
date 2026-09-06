import * as fs from 'fs';
import { performance } from 'perf_hooks';

export type RecallTimingPhase = 'initial' | 'expand' | 'total';

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
