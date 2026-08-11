import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_OBSERVER_CONTRACT,
  LegacyMemorySourceStore,
  buildLegacyManifest,
  discoverOmbreBucketFiles,
  legacySourceId,
  loadLegacyImportState,
  parseLegacySource,
  resolveLegacyLineage,
  runLegacyImport,
} from '../src/legacy/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-093x-')); roots.push(root); return root; }
function bucket(root: string, relative: string, overrides: string[] = [], body = '一段历史记忆。\n'): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const defaults = [
    `id: ${path.basename(relative, '.md')}`,
    'name: 测试记忆',
    'type: memory',
    'created: 2026-07-01T01:02:03',
    'last_active: 2026-07-02T04:05:06',
    'domain: [关系, 日常]',
    'tags:',
    '  - 琥珀',
    '  - 猫',
    'importance: 8',
    'valence: 0.7',
    'arousal: 0.4',
    'activation_count: 3.5',
  ];
  const keys = new Set(overrides.map((line) => line.split(':', 1)[0]));
  const lines = defaults.filter((line) => line.startsWith('  - ') || !keys.has(line.split(':', 1)[0]));
  for (const override of overrides) lines.push(override);
  fs.writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}`, 'utf8');
  return file;
}
function parsed(root: string, relative: string) {
  const manifest = buildLegacyManifest(root);
  const entry = manifest.entries.find((item) => item.relative_path === relative)!;
  return parseLegacySource(root, entry, manifest.manifest_digest, 'subject-kohaku');
}
function blockListBucket(root: string, relative: string, indent: '' | '  '): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = path.basename(relative, '.md');
  fs.writeFileSync(file, `---\nid: ${id}\nname: 列表兼容测试\ntype: memory\ncreated: 2026-07-01T01:02:03\nlast_active: 2026-07-02T04:05:06\ndomain:\n${indent}- relationship\n${indent}- daily\ntags:\n${indent}- kohaku\n${indent}- cat\nimportance: 8\nvalence: 0.7\narousal: 0.4\nactivation_count: 3.5\n---\nsynthetic fixture only.\n`, 'utf8');
  return file;
}

describe('Task 093X Ombre legacy source foundation', () => {
  it('recursively discovers nested category/topic markdown with bytewise deterministic ordering', () => {
    const root = temp(); bucket(root, 'dynamic/情绪/2.md'); bucket(root, 'permanent/工作/1.md'); bucket(root, 'archive/session/3.md');
    expect(discoverOmbreBucketFiles(root).map((f) => path.relative(root, f).split(path.sep).join('/'))).toEqual(['archive/session/3.md', 'dynamic/情绪/2.md', 'permanent/工作/1.md']);
  });

  it('builds a deterministic manifest and path-sensitive digest', () => {
    const root = temp(); bucket(root, 'dynamic/a/1.md');
    const first = buildLegacyManifest(root); const second = buildLegacyManifest(root);
    expect(second).toEqual(first);
    fs.mkdirSync(path.join(root, 'dynamic/b'), { recursive: true }); fs.renameSync(path.join(root, 'dynamic/a/1.md'), path.join(root, 'dynamic/b/1.md'));
    expect(buildLegacyManifest(root).manifest_digest).not.toBe(first.manifest_digest);
  });

  it('parses metadata while preserving exact source and raw UTC timestamps', () => {
    const root = temp(); const file = bucket(root, 'dynamic/topic/42.md', ['resolved: true', 'kind: thought', 'digested: false', 'model_valence: 0.6', 'pinned: true']);
    const exact = fs.readFileSync(file, 'utf8'); const source = parsed(root, 'dynamic/topic/42.md');
    expect(source.original_markdown).toBe(exact); expect(source.body_text).toBe('一段历史记忆。\n');
    expect(source.raw_created).toBe('2026-07-01T01:02:03'); expect(source.created_at_utc).toBe('2026-07-01T01:02:03.000Z');
    expect(source.frontmatter).toMatchObject({ resolved: true, kind: 'thought', digested: false, model_valence: 0.6, pinned: true });
  });

  it('normalizes numeric YAML IDs to strings without rewriting source and preserves float activation count', () => {
    const root = temp(); const file = bucket(root, 'dynamic/914798167722.md'); const raw = fs.readFileSync(file, 'utf8');
    const source = parsed(root, 'dynamic/914798167722.md'); expect(source.bucket_id).toBe('914798167722'); expect(source.original_markdown).toBe(raw); expect(source.frontmatter.activation_count).toBe(3.5);
  });

  it('accepts exact-id and title-prefixed filename forms while preserving the full relative path', () => {
    const root = temp(); bucket(root, 'dynamic/topic/42.md'); bucket(root, 'archive/topic/remembering_the_cat_77.md', ['id: 77']);
    const exact = parsed(root, 'dynamic/topic/42.md'); const titled = parsed(root, 'archive/topic/remembering_the_cat_77.md');
    expect(exact.bucket_id).toBe('42');
    expect(titled.bucket_id).toBe('77'); expect(titled.relative_path).toBe('archive/topic/remembering_the_cat_77.md');
  });

  it('requires an underscore token boundary for title-prefixed filenames', () => {
    const root = temp(); bucket(root, 'dynamic/title42.md', ['id: 42']); bucket(root, 'dynamic/title_43.md', ['id: 42']);
    const result = runLegacyImport({ rootDir: root, storeDir: path.join(root, 'store'), subjectId: 's', dryRun: true });
    expect(result.processed).toBe(2); expect(result.isolated).toHaveLength(2);
    expect(result.isolated.map((item) => item.relative_path)).toEqual(['dynamic/title42.md', 'dynamic/title_43.md']);
  });

  it('accepts naive, Z, and +00:00 UTC timestamps as the same semantic instant while preserving raw text', () => {
    const root = temp();
    bucket(root, 'dynamic/naive_1.md', ['id: 1', 'created: 2026-05-25T14:44:43.565804', 'last_active: 2026-05-25T14:44:43.565804']);
    bucket(root, 'dynamic/zulu_2.md', ['id: 2', 'created: 2026-05-25T14:44:43.565804Z', 'last_active: 2026-05-25T14:44:43.565804Z']);
    bucket(root, 'dynamic/offset_3.md', ['id: 3', 'created: 2026-05-25T14:44:43.565804+00:00', 'last_active: 2026-05-25T14:44:43.565804+00:00']);
    const naive = parsed(root, 'dynamic/naive_1.md'); const zulu = parsed(root, 'dynamic/zulu_2.md'); const offset = parsed(root, 'dynamic/offset_3.md');
    expect(naive.raw_created).toBe('2026-05-25T14:44:43.565804'); expect(zulu.raw_created).toBe('2026-05-25T14:44:43.565804Z'); expect(offset.raw_created).toBe('2026-05-25T14:44:43.565804+00:00');
    expect(zulu.created_at_utc).toBe(naive.created_at_utc); expect(offset.created_at_utc).toBe(naive.created_at_utc); expect(naive.created_at_utc).toBe('2026-05-25T14:44:43.565Z');
  });

  it('isolates malformed or non-zero-offset timestamps instead of coercing them', () => {
    const root = temp(); bucket(root, 'dynamic/bad_1.md', ['id: 1', 'created: 2026-02-31T14:44:43']); bucket(root, 'dynamic/offset_2.md', ['id: 2', 'created: 2026-05-25T14:44:43+09:00']);
    const result = runLegacyImport({ rootDir: root, storeDir: path.join(root, 'store'), subjectId: 's', dryRun: true });
    expect(result.processed).toBe(2); expect(result.accepted).toBe(0); expect(result.isolated).toHaveLength(2);
  });

  it('accepts both column-0 and indented block lists and creates normal legacy sources', () => {
    const root = temp(); const store = new LegacyMemorySourceStore(path.join(root, 'store'));
    blockListBucket(root, 'dynamic/101.md', ''); blockListBucket(root, 'dynamic/102.md', '  ');
    const columnZero = parsed(root, 'dynamic/101.md'); const indented = parsed(root, 'dynamic/102.md');
    expect(columnZero.frontmatter.domain).toEqual(['relationship', 'daily']);
    expect(columnZero.frontmatter.tags).toEqual(['kohaku', 'cat']);
    expect(indented.frontmatter.domain).toEqual(['relationship', 'daily']);
    expect(indented.frontmatter.tags).toEqual(['kohaku', 'cat']);
    expect(store.appendSource(columnZero)).toBe('accepted'); expect(store.appendSource(indented)).toBe('accepted');
  });

  it('dry-runs a mixed block-list fixture without isolation or persistent import mutation', () => {
    const root = temp(); const storeDir = path.join(root, 'dry-store');
    blockListBucket(root, 'dynamic/201.md', ''); blockListBucket(root, 'archive/topic/202.md', '  ');
    const result = runLegacyImport({ rootDir: root, storeDir, subjectId: 's', dryRun: true });
    expect(result.processed).toBe(2); expect(result.isolated).toHaveLength(0); expect(result.dry_run).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'legacy-assistant-sources.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'legacy-import-receipts.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'legacy-import-state.json'))).toBe(false);
  });

  it('isolates filename/id mismatch and malformed YAML without corrupting good inputs', () => {
    const root = temp(); bucket(root, 'dynamic/1.md'); bucket(root, 'dynamic/2.md', ['id: wrong']);
    fs.mkdirSync(path.join(root, 'feel'), { recursive: true }); fs.writeFileSync(path.join(root, 'feel/3.md'), '---\nid: 3\nBAD YAML\n---\nbody');
    const result = runLegacyImport({ rootDir: root, storeDir: path.join(root, 'store'), subjectId: 's' });
    expect(result.accepted).toBe(1); expect(result.isolated).toHaveLength(2);
    expect(new LegacyMemorySourceStore(path.join(root, 'store')).listSources()).toHaveLength(1);
  });

  it('preserves optional absence and supersession lineage resolves to deterministic source IDs', () => {
    const root = temp(); bucket(root, 'archive/10.md', ['superseded_by: 11']); bucket(root, 'archive/11.md', ['supersedes: 10']);
    const a = parsed(root, 'archive/10.md'); const b = parsed(root, 'archive/11.md');
    expect(a.frontmatter.resolved).toBeUndefined(); expect(resolveLegacyLineage(a, [a, b]).superseded_by).toBe(b.legacy_source_id); expect(resolveLegacyLineage(b, [a, b]).supersedes).toBe(a.legacy_source_id);
  });

  it('uses stable source identity independent of import time and path topic nesting', () => {
    expect(legacySourceId('s', 'dynamic', '42')).toBe(legacySourceId('s', 'dynamic', '42'));
    expect(legacySourceId('s', 'dynamic', '42')).not.toBe(legacySourceId('s', 'feel', '42'));
  });

  it('is duplicate-safe for an immutable source and rejects same identity with changed evidence', () => {
    const root = temp(); bucket(root, 'dynamic/1.md'); const source = parsed(root, 'dynamic/1.md'); const store = new LegacyMemorySourceStore(path.join(root, 'store'));
    expect(store.appendSource(source)).toBe('accepted'); expect(store.appendSource(source)).toBe('duplicate'); expect(store.listSources()).toHaveLength(1);
    expect(() => store.appendSource({ ...source, source_sha256: 'changed' })).toThrow(/identity collision/);
  });

  it('resume is manifest-bound and fails closed after a changed snapshot', () => {
    const root = temp(); bucket(root, 'dynamic/1.md'); bucket(root, 'dynamic/2.md'); const storeDir = path.join(root, 'store');
    const first = runLegacyImport({ rootDir: root, storeDir, subjectId: 's', maxRecords: 1 }); expect(first.processed).toBe(1);
    const manifest = buildLegacyManifest(root); expect(loadLegacyImportState(path.join(storeDir, 'legacy-import-state.json'), manifest.manifest_digest).processed_paths).toHaveLength(1);
    runLegacyImport({ rootDir: root, storeDir, subjectId: 's', maxRecords: 1 }); expect(new LegacyMemorySourceStore(storeDir).listSources()).toHaveLength(2);
    bucket(root, 'dynamic/3.md'); expect(() => runLegacyImport({ rootDir: root, storeDir, subjectId: 's' })).toThrow(/different manifest/);
  });

  it('checkpoints terminal isolation so bounded resume advances past a malformed first entry', () => {
    const root = temp(); const storeDir = path.join(root, 'store');
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archive/1.md'), '---\nid: 1\nBAD YAML\n---\nbody', 'utf8');
    bucket(root, 'dynamic/2.md');
    const first = runLegacyImport({ rootDir: root, storeDir, subjectId: 's', maxRecords: 1 });
    expect(first.processed).toBe(1); expect(first.isolated).toHaveLength(1); expect(first.isolated[0].relative_path).toBe('archive/1.md');
    const manifest = buildLegacyManifest(root);
    expect(loadLegacyImportState(path.join(storeDir, 'legacy-import-state.json'), manifest.manifest_digest).processed_paths).toEqual(['archive/1.md']);
    const second = runLegacyImport({ rootDir: root, storeDir, subjectId: 's', maxRecords: 1 });
    expect(second.processed).toBe(1); expect(second.accepted).toBe(1); expect(second.isolated).toHaveLength(0);
    const store = new LegacyMemorySourceStore(storeDir);
    expect(store.listSources()).toHaveLength(1);
    expect(store.listReceipts().filter((item) => item.relative_path === 'archive/1.md' && item.result === 'isolated')).toHaveLength(1);
  });

  it('dry-run and maxRecords never commit beyond the requested boundary', () => {
    const root = temp(); bucket(root, 'dynamic/1.md'); bucket(root, 'dynamic/2.md'); const dryStore = path.join(root, 'dry');
    const dry = runLegacyImport({ rootDir: root, storeDir: dryStore, subjectId: 's', maxRecords: 1, dryRun: true }); expect(dry.processed).toBe(1); expect(new LegacyMemorySourceStore(dryStore).listSources()).toHaveLength(0); expect(fs.existsSync(path.join(dryStore, 'legacy-import-state.json'))).toBe(false);
  });

  it('supports one immutable source -> many canonical memories and reverse lookup', () => {
    const root = temp(); bucket(root, 'dynamic/1.md', [], '一起旅行；猫喜欢蓝调滤镜；关系变得更亲近。\n'); const source = parsed(root, 'dynamic/1.md'); const store = new LegacyMemorySourceStore(path.join(root, 'store')); store.appendSource(source);
    store.appendProvenance({ legacy_source_id: source.legacy_source_id, canonical_memory_id: 'mem_event', disposition: 'created', recorded_at: '2026-08-10T00:00:00Z' });
    store.appendProvenance({ legacy_source_id: source.legacy_source_id, canonical_memory_id: 'mem_preference', disposition: 'created', recorded_at: '2026-08-10T00:00:00Z' });
    store.appendProvenance({ legacy_source_id: source.legacy_source_id, canonical_memory_id: 'mem_relationship', disposition: 'reinforced', recorded_at: '2026-08-10T00:00:00Z' });
    expect(store.memoriesForSource(source.legacy_source_id)).toEqual(['mem_event', 'mem_preference', 'mem_relationship']); expect(store.sourcesForMemory('mem_preference')).toEqual([source.legacy_source_id]); expect(store.listSources()).toHaveLength(1);
  });

  it('supports linking an existing canonical memory without requiring new creation', () => {
    const root = temp(); bucket(root, 'archive/1.md'); const source = parsed(root, 'archive/1.md'); const store = new LegacyMemorySourceStore(path.join(root, 'store')); store.appendSource(source);
    const link = store.appendProvenance({ legacy_source_id: source.legacy_source_id, canonical_memory_id: 'existing_memory', disposition: 'duplicate_link', recorded_at: '2026-08-10T00:00:00Z' });
    expect(link.disposition).toBe('duplicate_link'); expect(store.memoriesForSource(source.legacy_source_id)).toEqual(['existing_memory']);
  });

  it('observer contract requires 0..N semantic judgment, historical feel temporality, and no fake transcript IDs', () => {
    expect(LEGACY_OBSERVER_CONTRACT).toContain('zero, one, or many'); expect(LEGACY_OBSERVER_CONTRACT).toContain('naive paragraph splitting'); expect(LEGACY_OBSERVER_CONTRACT).toContain('feel/'); expect(LEGACY_OBSERVER_CONTRACT).toContain('historical temporality'); expect(LEGACY_OBSERVER_CONTRACT).toContain('Never invent conversation_id, message_id, or transcript evidence IDs'); expect(LEGACY_OBSERVER_CONTRACT).toContain('does not imply that the assistant performed an action whose actor is unstated'); expect(LEGACY_OBSERVER_CONTRACT).toContain('Never silently substitute one actor for another'); expect(LEGACY_OBSERVER_CONTRACT).toContain('do not strengthen, invent, or infer an action'); expect(LEGACY_OBSERVER_CONTRACT).toContain('X 管理的/拥有的/位于'); expect(LEGACY_OBSERVER_CONTRACT).toContain('Relationship-memory relevance is required'); expect(LEGACY_OBSERVER_CONTRACT).toContain('ordinary technical implementation, bug-fix, deployment, configuration, monitoring, or operational-status facts'); expect(LEGACY_OBSERVER_CONTRACT).toContain('Importance or technical detail alone');
  });

  it('ignores derived embedding/dehydration databases as primary source inputs', () => {
    const root = temp(); bucket(root, 'dynamic/1.md'); fs.writeFileSync(path.join(root, 'embeddings.db'), 'fake'); fs.writeFileSync(path.join(root, 'dehydration_cache.db'), 'fake');
    expect(buildLegacyManifest(root).entries.map((entry) => entry.relative_path)).toEqual(['dynamic/1.md']);
  });
});
