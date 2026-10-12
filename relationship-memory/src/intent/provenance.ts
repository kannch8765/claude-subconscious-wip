import type { AssistantRememberIntentRecord, EffectiveMemoryRecord } from '../schema/index.js';
import type { RelationshipMemoryStore } from '../store/index.js';

/** The real foreground tool_use is authoritative; only backend-linked outcomes count. */
export function linkedAssistantIntentIndex(
  store: RelationshipMemoryStore,
): Map<string, AssistantRememberIntentRecord[]> {
  const intents = new Map(store.listAssistantIntents().map((intent) => [intent.intent_id, intent]));
  const latest = new Map(store.listAssistantIntentOutcomes().map((outcome) => [outcome.intent_id, outcome]));
  const byCanonical = new Map<string, AssistantRememberIntentRecord[]>();
  for (const [intentId, outcome] of latest) {
    if (!outcome.memory_id || (outcome.outcome !== 'accepted' && outcome.outcome !== 'duplicate')) continue;
    const intent = intents.get(intentId);
    if (!intent) continue;
    const bucket = byCanonical.get(outcome.memory_id) ?? [];
    bucket.push(intent);
    byCanonical.set(outcome.memory_id, bucket);
  }
  for (const bucket of byCanonical.values()) {
    bucket.sort((a, b) => b.captured_at.localeCompare(a.captured_at) || a.intent_id.localeCompare(b.intent_id));
  }
  return byCanonical;
}

/** Resolve immutable assistant memory/feel texts through an effective source family. */
export function intentsForEffectiveMemory(
  index: ReadonlyMap<string, readonly AssistantRememberIntentRecord[]>,
  memory: Pick<EffectiveMemoryRecord, 'memory_id' | 'resolution_source_memory_ids'>,
): AssistantRememberIntentRecord[] {
  const unique = new Map<string, AssistantRememberIntentRecord>();
  for (const id of memory.resolution_source_memory_ids ?? [memory.memory_id]) {
    for (const intent of index.get(id) ?? []) unique.set(intent.intent_id, intent);
  }
  return [...unique.values()]
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at) || a.intent_id.localeCompare(b.intent_id));
}

/** Current IDs whose own canonical root was explicitly authored by foreground Kohaku. */
export function protectedCurrentMemoryIds(
  index: ReadonlyMap<string, readonly AssistantRememberIntentRecord[]>,
  current: readonly EffectiveMemoryRecord[],
  memberIds: readonly string[],
): string[] {
  const wanted = new Set(memberIds);
  return current.filter((item) => wanted.has(item.memory_id) && item.status === 'active'
    && (index.get(item.memory_id)?.length ?? 0) > 0)
    .map((item) => item.memory_id).sort();
}
