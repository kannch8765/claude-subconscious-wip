import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord } from '../src/schema/index.js';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { LegacyMemorySourceStore, legacySourceId, type LegacyAssistantMemorySourceRecord } from '../src/legacy/index.js';
import {
  LegacySemanticMutationRuntime,
  legacyMemoryCreateToolSchema,
  legacyMemoryExistingToolSchema,
  legacySemanticBatchId,
} from '../src/legacy/semantic.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-subject-reconciliation-')); roots.push(root); return root; }
const manifest = '5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31';

function legacySource(id: string): LegacyAssistantMemorySourceRecord {
  return {
    schema_version: 1,
    legacy_source_id: legacySourceId('legacy-subject', 'dynamic', id),
    subject_id: 'legacy-subject',
    provenance_kind: 'legacy_assistant_memory',
    source_system: 'ombre_brain',
    bucket_type: 'dynamic',
    bucket_id: id,
    relative_path: `dynamic/${id}.md`,
    source_sha256: `sha-${id}`,
    original_markdown: `---\nid: ${id}\n---\n历史内容 ${id}`,
    body_text: `历史内容 ${id}`,
    frontmatter: { name: `桶${id}`, type: 'memory', domain: ['关系'], tags: ['琥珀'], importance: 8, valence: 0.7, arousal: 0.4, activation_count: 2 },
    raw_created: '2026-05-01T01:02:03',
    raw_last_active: '2026-05-02T01:02:03',
    created_at_utc: '2026-05-01T01:02:03.000Z',
    last_active_at_utc: '2026-05-02T01:02:03.000Z',
    manifest_digest: manifest,
  };
}

function preferenceProposal() {
  return {
    schema_version: 1,
    kind: 'user_preference',
    summary: '猫喜欢偏蓝调的滤镜风格',
    participants: ['user'],
    payload: { topic: '滤镜风格', preference: '猫偏好蓝调滤镜', context: '拍照时会优先尝试偏蓝调版本' },
  };
}

function targetMemory(id = 'target-memory'): CanonicalMemoryRecord {
  return {
    schema_version: 1,
    memory_id: id,
    subject_id: 'canonical-subject',
    kind: 'user_preference',
    summary: '猫喜欢偏蓝调的滤镜风格',
    participants: ['user'],
    payload: { topic: '滤镜风格', preference: '猫偏好蓝调滤镜', context: '拍照时会优先尝试偏蓝调版本' },
    status: 'active',
    observed_at: '2026-05-01T00:00:00Z',
    created_at: '2026-05-01T00:00:00Z',
    source_key: `src-${id}`,
    dedupe_key: `dedupe-${id}`,
  };
}

describe('Task 093AB canonical target subject reconciliation', () => {
  it('creates under the canonical target while preserving immutable legacy source subject identity', () => {
    const root = temp();
    const source = legacySource('create');
    const legacyStore = new LegacyMemorySourceStore(root);
    legacyStore.appendSource(source);

    const runtime = new LegacySemanticMutationRuntime(root, 'canonical-subject', source, legacySemanticBatchId(manifest, source.legacy_source_id), () => '2026-08-11T00:00:00Z');
    expect(runtime.createMemory(preferenceProposal()).outcome).toBe('created');

    const memories = new RelationshipMemoryStore(root, 'canonical-subject').listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].subject_id).toBe('canonical-subject');
    expect(legacyStore.listSources()).toEqual([source]);
    expect(legacyStore.listSources()[0].subject_id).toBe('legacy-subject');
  });

  it('dedupes against an existing memory in the canonical target subject despite a different source subject', () => {
    const root = temp();
    const source = legacySource('duplicate');
    new LegacyMemorySourceStore(root).appendSource(source);
    const canonicalStore = new RelationshipMemoryStore(root, 'canonical-subject');
    const existing = targetMemory('existing-target');
    canonicalStore.appendMemory(existing, []);

    const runtime = new LegacySemanticMutationRuntime(root, 'canonical-subject', source, legacySemanticBatchId(manifest, source.legacy_source_id), () => '2026-08-11T00:00:00Z');
    expect(runtime.createMemory(preferenceProposal())).toMatchObject({ outcome: 'duplicate_link', memory_id: existing.memory_id });
    expect(canonicalStore.listMemories()).toHaveLength(1);
  });

  it('explicitly duplicate-links an existing memory in the canonical target subject', () => {
    const root = temp();
    const source = legacySource('explicit-duplicate');
    new LegacyMemorySourceStore(root).appendSource(source);
    const canonicalStore = new RelationshipMemoryStore(root, 'canonical-subject');
    const existing = targetMemory('explicit-target');
    canonicalStore.appendMemory(existing, []);

    const runtime = new LegacySemanticMutationRuntime(root, 'canonical-subject', source, legacySemanticBatchId(manifest, source.legacy_source_id), () => '2026-08-11T00:00:00Z');
    expect(runtime.duplicateLink(existing.memory_id)).toMatchObject({ outcome: 'duplicate_link', memory_id: existing.memory_id });
  });

  it('reinforces an existing memory in the canonical target subject despite a different source subject', () => {
    const root = temp();
    const source = legacySource('reinforce');
    new LegacyMemorySourceStore(root).appendSource(source);
    const canonicalStore = new RelationshipMemoryStore(root, 'canonical-subject');
    const existing = targetMemory();
    canonicalStore.appendMemory(existing, []);

    const runtime = new LegacySemanticMutationRuntime(root, 'canonical-subject', source, legacySemanticBatchId(manifest, source.legacy_source_id), () => '2026-08-11T00:00:00Z');
    expect(runtime.reinforce(existing.memory_id)).toMatchObject({ outcome: 'reinforced', memory_id: existing.memory_id });
    expect(canonicalStore.listReinforcements()).toHaveLength(1);
  });

  it('keeps both source identity and canonical target subject backend-bound rather than model-controlled', () => {
    const source = legacySource('schema');
    const createSchema = legacyMemoryCreateToolSchema(source) as any;
    expect(createSchema.additionalProperties).toBe(false);
    expect(createSchema.properties.legacy_source_id).toBeUndefined();
    expect(createSchema.properties.subject_id).toBeUndefined();
    expect(createSchema.properties.canonical_subject_id).toBeUndefined();
    expect(createSchema.properties.canonicalSubjectId).toBeUndefined();

    const existingSchema = legacyMemoryExistingToolSchema() as any;
    expect(existingSchema.additionalProperties).toBe(false);
    expect(Object.keys(existingSchema.properties)).toEqual(['memory_id']);
  });
});
