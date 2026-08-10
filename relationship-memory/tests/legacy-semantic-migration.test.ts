import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord } from '../src/schema/index.js';
import { RelationshipMemoryStore, stableId } from '../src/store/index.js';
import { LegacyMemorySourceStore, legacySourceId, type LegacyAssistantMemorySourceRecord } from '../src/legacy/index.js';
import {
  LEGACY_FEEL_TEMPORALITY,
  LegacySemanticMutationRuntime,
  legacyMemoryCreateToolSchema,
  legacySemanticBatchId,
  legacySourceCompleteToolSchema,
  listLegacySemanticReceipts,
  loadLegacySemanticState,
  runLegacySemanticMigration,
} from '../src/legacy/semantic.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-semantic-')); roots.push(root); return root; }
const manifest = '5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31';
const canonicalSubject = 'subject-kohaku';

function source(id: string, bucketType: 'dynamic' | 'feel' | 'archive' | 'permanent' = 'dynamic'): LegacyAssistantMemorySourceRecord {
  return {
    schema_version: 1,
    legacy_source_id: legacySourceId('subject-kohaku', bucketType, id),
    subject_id: 'subject-kohaku',
    provenance_kind: 'legacy_assistant_memory',
    source_system: 'ombre_brain',
    bucket_type: bucketType,
    bucket_id: id,
    relative_path: `${bucketType}/${id}.md`,
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
function seed(root: string, ...sources: LegacyAssistantMemorySourceRecord[]): LegacyMemorySourceStore {
  const store = new LegacyMemorySourceStore(root);
  for (const item of sources) store.appendSource(item);
  return store;
}
function sharedProposal(name = '京都旅行') {
  return { schema_version: 1, kind: 'shared_experience', summary: `${name}是猫和琥珀的重要共同经历`, participants: ['user', 'assistant'], payload: { title: name, event: `猫和琥珀一起经历了${name}`, shared_meaning: '这件事让彼此更亲近' } };
}
function preferenceProposal() {
  return { schema_version: 1, kind: 'user_preference', summary: '猫喜欢偏蓝调的滤镜风格', participants: ['user'], payload: { topic: '滤镜风格', preference: '猫偏好蓝调滤镜', context: '拍照时会优先尝试偏蓝调版本' } };
}
function existingMemory(root: string, id = 'existing'): CanonicalMemoryRecord {
  const store = new RelationshipMemoryStore(root, 'subject-kohaku');
  const memory: CanonicalMemoryRecord = {
    schema_version: 1, memory_id: id, subject_id: 'subject-kohaku', kind: 'user_preference', summary: '猫喜欢偏蓝调的滤镜风格', participants: ['user'],
    payload: { topic: '滤镜风格', preference: '猫偏好蓝调滤镜', context: '拍照时会优先尝试偏蓝调版本' }, status: 'active',
    observed_at: '2026-05-01T00:00:00Z', created_at: '2026-05-01T00:00:00Z', source_key: `src-${id}`, dedupe_key: `dedupe-${id}`,
  };
  store.appendMemory(memory, []);
  return memory;
}

describe('Task 093AA legacy semantic migration', () => {
  it('terminates a zero-memory source with a durable receipt and checkpoint without provenance', async () => {
    const root = temp(); const s = source('1'); seed(root, s);
    const result = await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, maxRecords: 1, processor: async (item, batchId) => {
      const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', item, batchId, () => '2026-08-11T00:00:00Z');
      expect(runtime.complete('no_memory_required')).toEqual({ completion: 'no_memory_required' });
      return { completion: 'no_memory_required' };
    } });
    expect(result.status).toBe('completed');
    expect(new LegacyMemorySourceStore(root).listProvenance()).toHaveLength(0);
    expect(listLegacySemanticReceipts(root)[0]).toMatchObject({ canonical_subject_id: canonicalSubject, legacy_source_id: s.legacy_source_id, result: 'no_memory_required', memory_ids: [] });
    expect(loadLegacySemanticState(path.join(root, 'legacy-semantic-migration-state.json'), manifest, canonicalSubject).processed_source_ids).toEqual([s.legacy_source_id]);
  });

  it('keeps immutable legacy source identity separate from canonical target subject', () => {
    const root = temp(); const s = source('subject-split'); seed(root, s);
    const targetSubject = 'kohaku-production';
    const runtime = new LegacySemanticMutationRuntime(root, targetSubject, s, legacySemanticBatchId(manifest, s.legacy_source_id, targetSubject), () => '2026-08-11T00:00:00Z');
    const result = runtime.createMemory(sharedProposal('旧 Ombre 记忆'));
    expect(result.outcome).toBe('created');
    const memories = new RelationshipMemoryStore(root, targetSubject).listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].subject_id).toBe(targetSubject);
    expect(s.subject_id).toBe('subject-kohaku');
    expect(runtime.provenance()[0]).toMatchObject({
      legacy_source_id: s.legacy_source_id,
      canonical_memory_id: memories[0].memory_id,
      disposition: 'created',
    });
  });

  it('creates multiple first-class canonical memories from one source with no fake transcript evidence', async () => {
    const root = temp(); const s = source('2'); seed(root, s);
    await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, processor: async (item, batchId) => {
      const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', item, batchId, () => '2026-08-11T00:00:00Z');
      expect(runtime.createMemory(sharedProposal()).outcome).toBe('created');
      expect(runtime.createMemory(preferenceProposal()).outcome).toBe('created');
      expect(runtime.complete('completed')).toEqual({ completion: 'completed' });
      return { completion: 'completed' };
    } });
    const canonical = new RelationshipMemoryStore(root, 'subject-kohaku');
    expect(canonical.listMemories()).toHaveLength(2);
    expect(canonical.listEvidence()).toHaveLength(0);
    const provenance = new LegacyMemorySourceStore(root).listProvenance();
    expect(provenance).toHaveLength(2); expect(new Set(provenance.map((p) => p.canonical_memory_id)).size).toBe(2);
  });

  it('duplicate-links an existing semantic memory instead of creating a second canonical record', () => {
    const root = temp(); const s = source('3'); seed(root, s); const existing = existingMemory(root);
    const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', s, legacySemanticBatchId(manifest, s.legacy_source_id, canonicalSubject), () => '2026-08-11T00:00:00Z');
    const result = runtime.createMemory(preferenceProposal());
    expect(result).toMatchObject({ outcome: 'duplicate_link', memory_id: existing.memory_id });
    expect(new RelationshipMemoryStore(root, 'subject-kohaku').listMemories()).toHaveLength(1);
    expect(runtime.provenance()[0]).toMatchObject({ disposition: 'duplicate_link', canonical_memory_id: existing.memory_id });
  });

  it('reinforces an existing memory from legacy provenance without fabricating EvidenceRecord rows', () => {
    const root = temp(); const s = source('4'); seed(root, s); const existing = existingMemory(root);
    const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', s, legacySemanticBatchId(manifest, s.legacy_source_id, canonicalSubject), () => '2026-08-11T00:00:00Z');
    expect(runtime.reinforce(existing.memory_id)).toMatchObject({ outcome: 'reinforced', memory_id: existing.memory_id });
    expect(runtime.reinforce(existing.memory_id)).toMatchObject({ outcome: 'reinforced', memory_id: existing.memory_id });
    const store = new RelationshipMemoryStore(root, 'subject-kohaku');
    expect(store.listReinforcements()).toHaveLength(1); expect(store.listReinforcements()[0].evidence_ids).toEqual([]); expect(store.listEvidence()).toHaveLength(0);
    expect(runtime.provenance()).toHaveLength(1); expect(runtime.provenance()[0].disposition).toBe('reinforced');
  });

  it('enforces explicit historical temporality for feel/ source creation', () => {
    const root = temp(); const s = source('5', 'feel'); seed(root, s);
    const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', s, legacySemanticBatchId(manifest, s.legacy_source_id, canonicalSubject));
    expect(runtime.createMemory(sharedProposal()).outcome).toBe('permanently_rejected');
    expect(runtime.createMemory({ ...sharedProposal(), historical_temporality: LEGACY_FEEL_TEMPORALITY }).outcome).toBe('created');
    const schema = legacyMemoryCreateToolSchema(s) as any;
    expect(schema.required).toContain('historical_temporality');
  });

  it('recovers idempotently after canonical mutation before source checkpoint', async () => {
    const root = temp(); const s = source('6'); seed(root, s);
    const first = await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, processor: async (item, batchId) => {
      const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', item, batchId, () => '2026-08-11T00:00:00Z');
      expect(runtime.createMemory(sharedProposal()).outcome).toBe('created');
      return { completion: 'retryable_failure', reason: 'synthetic interruption after mutation' };
    } });
    expect(first.status).toBe('blocked-failure');
    expect(loadLegacySemanticState(path.join(root, 'legacy-semantic-migration-state.json'), manifest, canonicalSubject).processed_source_ids).toEqual([]);
    const second = await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, processor: async (item, batchId) => {
      const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', item, batchId, () => '2026-08-11T00:01:00Z');
      expect(runtime.createMemory(sharedProposal()).outcome).toBe('duplicate_link');
      expect(runtime.complete('completed')).toEqual({ completion: 'completed' });
      return { completion: 'completed' };
    } });
    expect(second.status).toBe('completed');
    expect(new RelationshipMemoryStore(root, 'subject-kohaku').listMemories()).toHaveLength(1);
    expect(new LegacyMemorySourceStore(root).listProvenance()).toHaveLength(1);
    expect(listLegacySemanticReceipts(root).map((r) => r.result)).toEqual(['retryable_failure', 'completed']);
  });

  it('fails closed on manifest/state mismatch and processed-without-terminal-receipt corruption', async () => {
    const root = temp(); const s = source('7'); seed(root, s);
    fs.writeFileSync(path.join(root, 'bad-state.json'), JSON.stringify({ schema_version: 1, manifest_digest: 'other', canonical_subject_id: canonicalSubject, processed_source_ids: [] }));
    await expect(runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, statePath: path.join(root, 'bad-state.json'), processor: async () => ({ completion: 'no_memory_required' }) })).rejects.toThrow(/different manifest/);
    fs.writeFileSync(path.join(root, 'legacy-semantic-migration-state.json'), JSON.stringify({ schema_version: 1, manifest_digest: manifest, canonical_subject_id: canonicalSubject, processed_source_ids: [s.legacy_source_id] }));
    await expect(runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, processor: async () => ({ completion: 'no_memory_required' }) })).rejects.toThrow(/without terminal receipt/);
  });

  it('binds semantic state and terminal receipts to the canonical target subject', async () => {
    const root = temp(); const s = source('subject-bound-state'); seed(root, s);
    await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => ({ completion: 'no_memory_required' }),
    });
    expect(listLegacySemanticReceipts(root)[0].canonical_subject_id).toBe(canonicalSubject);
    await expect(runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: 'different-canonical-subject',
      processor: async () => ({ completion: 'no_memory_required' }),
    })).rejects.toThrow(/different canonical subject/);
  });

  it('supports bounded/exact-source canaries and a truthful non-mutating dry-run', async () => {
    const root = temp(); const a = source('8'); const b = source('9', 'archive'); seed(root, a, b);
    const before = fs.readdirSync(root).sort();
    const dry = await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, sourceIds: [b.legacy_source_id], maxRecords: 1, dryRun: true, processor: async () => { throw new Error('must not run'); } });
    expect(dry.status).toBe('dry-run'); expect(dry.remaining).toBe(1); expect(fs.readdirSync(root).sort()).toEqual(before);
    let seen = '';
    const live = await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, sourceIds: [b.legacy_source_id], maxRecords: 1, processor: async (item) => { seen = item.legacy_source_id; return { completion: 'no_memory_required' }; } });
    expect(live.status).toBe('completed'); expect(seen).toBe(b.legacy_source_id);
    await expect(runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, sourceIds: ['missing'], processor: async () => ({ completion: 'no_memory_required' }) })).rejects.toThrow(/unknown legacy source/);
  });

  it('does not expose legacy_source_id as a model-controlled tool argument and requires explicit completion', () => {
    const root = temp(); const s = source('10'); seed(root, s);
    const schema = legacyMemoryCreateToolSchema(s) as any;
    expect(schema.properties.legacy_source_id).toBeUndefined(); expect(schema.additionalProperties).toBe(false);
    const complete = legacySourceCompleteToolSchema() as any;
    expect(complete.required).toEqual(['result']); expect(complete.properties.result.enum).toEqual(['completed', 'no_memory_required']);
    const runtime = new LegacySemanticMutationRuntime(root, 'subject-kohaku', s, legacySemanticBatchId(manifest, s.legacy_source_id, canonicalSubject));
    expect(runtime.completionState()).toBeUndefined();
  });

  it('binds execution to the expected frozen manifest before processor work', async () => {
    const root = temp(); const s = source('manifest-ok'); seed(root, s);
    let calls = 0;
    const ok = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => { calls += 1; return { completion: 'no_memory_required' }; },
    });
    expect(ok.status).toBe('completed'); expect(calls).toBe(1);

    const wrongRoot = temp();
    const wrongManifest = '1'.repeat(64);
    seed(wrongRoot, { ...source('manifest-wrong'), manifest_digest: wrongManifest });
    let wrongCalls = 0;
    await expect(runLegacySemanticMigration({
      rootDir: wrongRoot, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => { wrongCalls += 1; return { completion: 'no_memory_required' }; },
    })).rejects.toThrow(/does not match expected frozen manifest/);
    expect(wrongCalls).toBe(0);
  });

  it('does not recover terminal completion from a different manifest', async () => {
    const root = temp(); const s = source('manifest-receipt'); seed(root, s);
    const oldManifest = '2'.repeat(64);
    fs.writeFileSync(path.join(root, 'legacy-semantic-receipts.jsonl'), `${JSON.stringify({
      schema_version: 1, receipt_id: 'old-receipt', manifest_digest: oldManifest, canonical_subject_id: canonicalSubject, legacy_source_id: s.legacy_source_id,
      batch_id: legacySemanticBatchId(oldManifest, s.legacy_source_id, canonicalSubject), result: 'no_memory_required', provenance_ids: [], memory_ids: [],
      recorded_at: '2026-08-10T00:00:00.000Z',
    })}\n`);
    let calls = 0;
    const result = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => { calls += 1; return { completion: 'no_memory_required' }; },
    });
    expect(result.status).toBe('completed'); expect(calls).toBe(1);
    const receipts = listLegacySemanticReceipts(root);
    expect(receipts).toHaveLength(2);
    expect(receipts[1].manifest_digest).toBe(manifest);
  });

  it('fails closed on malformed parseable legacy source rows before processor work', async () => {
    for (const [label, mutate] of [
      ['missing identity', (record: any) => { delete record.legacy_source_id; }],
      ['invalid digest', (record: any) => { record.manifest_digest = 'not-a-sha256'; }],
    ] as const) {
      const root = temp();
      const record: any = source(`malformed-${label.replace(/ /g, '-')}`);
      mutate(record);
      fs.writeFileSync(path.join(root, 'legacy-assistant-sources.jsonl'), `${JSON.stringify(record)}\n`);
      let calls = 0;
      await expect(runLegacySemanticMigration({
        rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
        processor: async () => { calls += 1; return { completion: 'no_memory_required' }; },
      })).rejects.toThrow(/legacy source/);
      expect(calls).toBe(0);
    }
  });

  it('keeps the semantic runner input authority inside the ingested source ledger', async () => {
    const root = temp(); const s = source('11'); seed(root, s);
    fs.mkdirSync(path.join(root, 'unrelated-ombre-tree', 'dynamic'), { recursive: true });
    fs.writeFileSync(path.join(root, 'unrelated-ombre-tree', 'dynamic', '999.md'), 'must not be read');
    let body = '';
    await runLegacySemanticMigration({ rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, processor: async (item) => { body = item.body_text; return { completion: 'no_memory_required' }; } });
    expect(body).toBe('历史内容 11');
    expect(loadLegacySemanticState(path.join(root, 'legacy-semantic-migration-state.json'), manifest, canonicalSubject).processed_source_ids).toEqual([s.legacy_source_id]);
  });
});
