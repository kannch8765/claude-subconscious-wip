import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  CanonicalMemoryRecord,
  EffectiveMemoryRecord,
} from '../schema/index.js';
import { RelationshipMemoryStore, stableId } from '../store/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';

export interface ProjectionBundle {
  revision: string;
  blocks: Record<'shared_language' | 'remembered_experiences' | 'relationship_context', string>;
}

const MAX_ASSISTANT_INTENTS_PER_MEMORY = 3;

function renderAssistantIntent(intent: AssistantRememberIntentRecord): string {
  return [
    `  assistant remember [${intent.intent_id}]`,
    `    memory: ${intent.memory.text}`,
    `    feel: ${intent.feel.text}`,
  ].join('\n');
}

function renderMemory(
  memory: CanonicalMemoryRecord | EffectiveMemoryRecord,
  provenance: AssistantRememberIntentRecord[] = [],
): string {
  const linked = memory.linked_memory_ids?.length ? `\n  linked: ${memory.linked_memory_ids.join(', ')}` : '';
  const assistant = provenance.length ? `\n${provenance.map(renderAssistantIntent).join('\n')}` : '';
  return `- [${memory.memory_id}] ${memory.summary}${linked}${assistant}`;
}

export function renderProjection(
  memories: Array<CanonicalMemoryRecord | EffectiveMemoryRecord>,
  assistantProvenance: Map<string, AssistantRememberIntentRecord[]> = new Map(),
): ProjectionBundle {
  const sorted = [...memories].filter((m) => m.status === 'active').sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  const render = (memory: CanonicalMemoryRecord | EffectiveMemoryRecord) => renderMemory(memory, assistantProvenance.get(memory.memory_id) ?? []);
  const sharedLanguage = sorted.filter((m) => m.kind === 'inside_joke').map(render);
  const experiences = sorted.filter((m) => m.kind === 'personal_experience' || m.kind === 'shared_experience').map(render);
  const relationship = sorted.filter((m) => m.kind === 'relationship_event').map(render);
  const blocks = {
    shared_language: ['# Shared language', ...sharedLanguage].join('\n'),
    remembered_experiences: ['# Remembered experiences', ...experiences].join('\n'),
    relationship_context: ['# Relationship context', ...relationship].join('\n'),
  };
  const provenanceRevision = [...assistantProvenance.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([memoryId, intents]) => [memoryId, intents] as const);
  return { revision: stableId('projection', { memories: sorted, assistant_provenance: provenanceRevision }), blocks };
}

function buildAssistantProvenance(store: RelationshipMemoryStore): Map<string, AssistantRememberIntentRecord[]> {
  const latest = new Map<string, AssistantIntentOutcome>();
  for (const outcome of store.listAssistantIntentOutcomes()) latest.set(outcome.intent_id, outcome);
  const grouped = new Map<string, AssistantRememberIntentRecord[]>();
  for (const [intentId, outcome] of latest) {
    if ((outcome.outcome !== 'accepted' && outcome.outcome !== 'duplicate') || !outcome.memory_id) continue;
    const intent = store.getAssistantIntent(intentId);
    if (!intent) continue;
    const items = grouped.get(outcome.memory_id) ?? [];
    items.push(intent);
    grouped.set(outcome.memory_id, items);
  }
  for (const [memoryId, items] of grouped) {
    items.sort((a, b) => b.captured_at.localeCompare(a.captured_at) || b.intent_id.localeCompare(a.intent_id));
    grouped.set(memoryId, items.slice(0, MAX_ASSISTANT_INTENTS_PER_MEMORY));
  }
  return grouped;
}

export function rebuildProjection(store: RelationshipMemoryStore): ProjectionBundle {
  return renderProjection(
    new RelationshipMemoryOwnerControlPlane(store).search({ active: true }),
    buildAssistantProvenance(store),
  );
}
