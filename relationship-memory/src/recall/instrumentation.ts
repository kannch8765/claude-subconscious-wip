import * as fs from 'fs';
import * as path from 'path';
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

export function timingDurationMs(startedAt: number): number {
  return Math.max(0, monotonicNow() - startedAt);
}

function canonicalPathForContainment(target: string): string {
  let current = path.resolve(target);
  const missingParts: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    missingParts.unshift(path.basename(current));
    current = parent;
  }
  try { return path.join(fs.realpathSync(current), ...missingParts); }
  catch { return path.resolve(target); }
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function timingFileOutsideStore(file: string, storeRootDir: string | undefined): boolean {
  if (!storeRootDir) return true;
  const canonicalFile = canonicalPathForContainment(file);
  const canonicalStore = canonicalPathForContainment(storeRootDir);
  return !isWithinDirectory(canonicalFile, canonicalStore);
}

export function emitRecallTiming(event: RecallTimingEvent, storeRootDir?: string): void {
  if (!recallTimingEnabled()) return;
  try {
    const line = `${JSON.stringify(event)}\n`;
    const file = process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE?.trim();
    if (file) {
      if (!timingFileOutsideStore(file, storeRootDir)) return;
      fs.appendFileSync(file, line, 'utf8');
      return;
    }
    process.stderr.write(line);
  } catch {
    // Observability must never change recall behavior.
  }
}
