/**
 * Whisper text the harness renders itself (docs/specs/WORLD-UPDATE.md §5).
 *
 * A world_update whisper carries no quotes: Kohaku gets the anchor's timeline, read from the store at delivery time so
 * a revision written after the pick still shows. The other kinds keep the summary + quotes rendering of the delivery
 * path.
 */
import type { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { renderWorldUpdateTimeline } from '../scripts/world_update_whisper.js';

/** The timeline text for a world_update whisper, or null when the memory is not a current world_update. */
export function worldWhisperText(runtime: RelationshipMemoryRuntime, memoryId: string): string | null {
  const memory = runtime.currentWorldUpdate(memoryId);
  return memory ? renderWorldUpdateTimeline(memory) : null;
}
