import type { CanonicalMemoryRecord, EffectiveMemoryRecord } from '../schema/index.js';
import { RelationshipMemoryStore, stableId } from '../store/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';

export interface ProjectionBundle {
  revision: string;
  blocks: Record<'shared_language' | 'remembered_experiences' | 'relationship_context', string>;
}

function renderMemory(memory: CanonicalMemoryRecord | EffectiveMemoryRecord): string {
  const linked = memory.linked_memory_ids?.length ? `\n  linked: ${memory.linked_memory_ids.join(', ')}` : '';
  return `- [${memory.memory_id}] ${memory.summary}${linked}`;
}

export function renderProjection(memories: Array<CanonicalMemoryRecord | EffectiveMemoryRecord>): ProjectionBundle {
  const sorted = [...memories].filter((m) => m.status === 'active').sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  const sharedLanguage = sorted.filter((m) => m.kind === 'inside_joke').map(renderMemory);
  const experiences = sorted.filter((m) => m.kind === 'personal_experience' || m.kind === 'shared_experience').map(renderMemory);
  const relationship = sorted.filter((m) => m.kind === 'relationship_event').map(renderMemory);
  const blocks = {
    shared_language: ['# Shared language', ...sharedLanguage].join('\n'),
    remembered_experiences: ['# Remembered experiences', ...experiences].join('\n'),
    relationship_context: ['# Relationship context', ...relationship].join('\n'),
  };
  return { revision: stableId('projection', sorted), blocks };
}

export function rebuildProjection(store: RelationshipMemoryStore): ProjectionBundle {
  return renderProjection(new RelationshipMemoryOwnerControlPlane(store).search({ active: true }));
}
