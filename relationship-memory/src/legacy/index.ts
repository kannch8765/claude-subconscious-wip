import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';

export const LEGACY_BUCKET_TYPES = ['permanent', 'dynamic', 'feel', 'archive'] as const;
export type LegacyBucketType = (typeof LEGACY_BUCKET_TYPES)[number];
export type LegacyProvenanceDisposition = 'created' | 'duplicate_link' | 'reinforced';

export interface LegacyManifestEntry {
  relative_path: string;
  byte_size: number;
  sha256: string;
}

export interface LegacySourceManifest {
  schema_version: 1;
  source_system: 'ombre_brain';
  entries: LegacyManifestEntry[];
  manifest_digest: string;
}

export interface LegacyFrontmatterMetadata {
  name: string;
  type: string;
  domain: string[];
  tags: string[];
  importance: number;
  valence: number;
  arousal: number;
  activation_count: number;
  resolved?: boolean;
  kind?: string;
  digested?: boolean;
  model_valence?: number;
  pinned?: boolean;
  supersedes?: string;
  superseded_by?: string;
  [key: string]: unknown;
}

export interface LegacyAssistantMemorySourceRecord {
  schema_version: 1;
  legacy_source_id: string;
  subject_id: string;
  provenance_kind: 'legacy_assistant_memory';
  source_system: 'ombre_brain';
  bucket_type: LegacyBucketType;
  bucket_id: string;
  relative_path: string;
  source_sha256: string;
  original_markdown: string;
  body_text: string;
  frontmatter: LegacyFrontmatterMetadata;
  raw_created: string;
  raw_last_active: string;
  created_at_utc: string;
  last_active_at_utc: string;
  manifest_digest: string;
}

export interface LegacyMemoryProvenanceLink {
  schema_version: 1;
  provenance_id: string;
  legacy_source_id: string;
  canonical_memory_id: string;
  disposition: LegacyProvenanceDisposition;
  recorded_at: string;
}

export interface LegacyImportState {
  schema_version: 1;
  manifest_digest: string;
  processed_paths: string[];
}

export interface LegacyImportReceipt {
  schema_version: 1;
  manifest_digest: string;
  relative_path: string;
  result: 'accepted' | 'duplicate' | 'isolated';
  legacy_source_id?: string;
  reason?: string;
}

export interface LegacyImportResult {
  manifest_digest: string;
  processed: number;
  accepted: number;
  duplicates: number;
  isolated: LegacyImportReceipt[];
  dry_run: boolean;
}

export interface LegacyImportOptions {
  rootDir: string;
  storeDir: string;
  subjectId: string;
  maxRecords?: number;
  dryRun?: boolean;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bytewiseCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function normalizedRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function discoverOmbreBucketFiles(rootDir: string): string[] {
  const root = path.resolve(rootDir);
  const found: string[] = [];
  for (const category of LEGACY_BUCKET_TYPES) {
    const start = path.join(root, category);
    if (!fs.existsSync(start)) continue;
    const visit = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => bytewiseCompare(a.name, b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(candidate);
        else if (entry.isFile() && entry.name.endsWith('.md')) found.push(candidate);
      }
    };
    visit(start);
  }
  return found.sort((a, b) => bytewiseCompare(normalizedRelative(root, a), normalizedRelative(root, b)));
}

export function buildLegacyManifest(rootDir: string): LegacySourceManifest {
  const root = path.resolve(rootDir);
  const entries = discoverOmbreBucketFiles(root).map((file): LegacyManifestEntry => {
    const content = fs.readFileSync(file);
    return {
      relative_path: normalizedRelative(root, file),
      byte_size: content.byteLength,
      sha256: sha256(content),
    };
  });
  const identityPayload = entries.map((entry) => [entry.relative_path, entry.byte_size, entry.sha256]);
  return {
    schema_version: 1,
    source_system: 'ombre_brain',
    entries,
    manifest_digest: sha256(stableJson(identityPayload)),
  };
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?(?:\d+\.?\d*|\d*\.\d+)$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => String(parseScalar(item)).trim());
  }
  return text;
}

function parseFrontmatter(source: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) throw new Error('missing YAML frontmatter opener');
  const normalized = source.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('missing YAML frontmatter closer');
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const result: Record<string, unknown> = {};
  let listKey: string | undefined;
  for (const line of yaml.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const list = line.match(/^\s*-\s+(.+)$/);
    if (list && listKey) {
      const current = result[listKey];
      if (!Array.isArray(current)) throw new Error(`invalid list field: ${listKey}`);
      current.push(String(parseScalar(list[1])));
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) throw new Error(`unsupported YAML line: ${line}`);
    const [, key, raw = ''] = match;
    if (!raw.trim()) {
      result[key] = [];
      listKey = key;
    } else {
      result[key] = parseScalar(raw);
      listKey = undefined;
    }
  }
  return { frontmatter: result, body };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be a string array`);
  return value as string[];
}

function utcFromOmbreTimestamp(raw: string, name: string): string {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|\+00:00)?$/);
  if (!match) throw new Error(`${name} must be an ISO-8601 UTC timestamp`);
  const [, year, month, day, hour, minute, second] = match;
  const normalized = match[8] ? raw.replace(/\+00:00$/, 'Z') : `${raw}Z`;
  const date = new Date(normalized);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

export function legacySourceId(subjectId: string, bucketType: LegacyBucketType, bucketId: string): string {
  return stableId('legacy_source', { subject_id: subjectId, source_system: 'ombre_brain', bucket_type: bucketType, bucket_id: String(bucketId) });
}

export function parseLegacySource(
  rootDir: string,
  entry: LegacyManifestEntry,
  manifestDigest: string,
  subjectId: string,
): LegacyAssistantMemorySourceRecord {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, entry.relative_path);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('manifest path escapes source root');
  const original = fs.readFileSync(absolute, 'utf8');
  if (Buffer.byteLength(original) !== entry.byte_size || sha256(Buffer.from(original)) !== entry.sha256) throw new Error('source no longer matches frozen manifest');
  const segments = entry.relative_path.split('/');
  const bucketType = segments[0] as LegacyBucketType;
  if (!LEGACY_BUCKET_TYPES.includes(bucketType)) throw new Error('unsupported legacy bucket category');
  const { frontmatter, body } = parseFrontmatter(original);
  if (!('id' in frontmatter)) throw new Error('id is required');
  const bucketId = String(frontmatter.id);
  if (!bucketId) throw new Error('id is required');
  const filenameStem = path.posix.basename(entry.relative_path, '.md');
  const titleSuffix = `_${bucketId}`;
  const filenameMatchesBucketId = filenameStem === bucketId || (filenameStem.endsWith(titleSuffix) && filenameStem.length > titleSuffix.length);
  if (!filenameMatchesBucketId) throw new Error(`bucket id ${bucketId} does not match filename ${filenameStem}`);
  const rawCreated = requiredString(frontmatter.created, 'created');
  const rawLastActive = requiredString(frontmatter.last_active, 'last_active');
  const metadata: LegacyFrontmatterMetadata = {
    ...frontmatter,
    name: requiredString(frontmatter.name, 'name'),
    type: requiredString(frontmatter.type, 'type'),
    domain: requiredStringArray(frontmatter.domain, 'domain'),
    tags: requiredStringArray(frontmatter.tags, 'tags'),
    importance: requiredNumber(frontmatter.importance, 'importance'),
    valence: requiredNumber(frontmatter.valence, 'valence'),
    arousal: requiredNumber(frontmatter.arousal, 'arousal'),
    activation_count: requiredNumber(frontmatter.activation_count, 'activation_count'),
  };
  delete metadata.id;
  delete metadata.created;
  delete metadata.last_active;
  return {
    schema_version: 1,
    legacy_source_id: legacySourceId(subjectId, bucketType, bucketId),
    subject_id: subjectId,
    provenance_kind: 'legacy_assistant_memory',
    source_system: 'ombre_brain',
    bucket_type: bucketType,
    bucket_id: bucketId,
    relative_path: entry.relative_path,
    source_sha256: entry.sha256,
    original_markdown: original,
    body_text: body,
    frontmatter: metadata,
    raw_created: rawCreated,
    raw_last_active: rawLastActive,
    created_at_utc: utcFromOmbreTimestamp(rawCreated, 'created'),
    last_active_at_utc: utcFromOmbreTimestamp(rawLastActive, 'last_active'),
    manifest_digest: manifestDigest,
  };
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class LegacyMemorySourceStore {
  private readonly mutationStore: RelationshipMemoryStore;

  constructor(readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
    // Reuse Task 093W's filesystem mutation boundary so legacy ledgers cannot
    // become a parallel unguarded writer lane beside canonical memory writes.
    this.mutationStore = new RelationshipMemoryStore(rootDir, '__legacy_import_boundary__');
  }

  private file(name: string): string { return path.join(this.rootDir, name); }
  withMutationBoundary<T>(operation: () => T): T { return this.mutationStore.withMutationBoundary(operation); }
  listSources(): LegacyAssistantMemorySourceRecord[] { return readJsonl(this.file('legacy-assistant-sources.jsonl')); }
  listProvenance(): LegacyMemoryProvenanceLink[] { return readJsonl(this.file('legacy-memory-provenance.jsonl')); }
  listReceipts(): LegacyImportReceipt[] { return readJsonl(this.file('legacy-import-receipts.jsonl')); }
  getSource(id: string): LegacyAssistantMemorySourceRecord | undefined { return this.listSources().find((source) => source.legacy_source_id === id); }
  appendSource(source: LegacyAssistantMemorySourceRecord): 'accepted' | 'duplicate' {
    return this.withMutationBoundary(() => {
      const existing = this.getSource(source.legacy_source_id);
      if (existing) {
        if (stableJson(existing) !== stableJson(source)) throw new Error(`legacy source identity collision: ${source.legacy_source_id}`);
        return 'duplicate';
      }
      appendJsonl(this.file('legacy-assistant-sources.jsonl'), source);
      return 'accepted';
    });
  }
  appendProvenance(link: Omit<LegacyMemoryProvenanceLink, 'schema_version' | 'provenance_id'>): LegacyMemoryProvenanceLink {
    return this.withMutationBoundary(() => {
      const record: LegacyMemoryProvenanceLink = {
        schema_version: 1,
        provenance_id: stableId('legacy_provenance', { legacy_source_id: link.legacy_source_id, canonical_memory_id: link.canonical_memory_id, disposition: link.disposition }),
        ...link,
      };
      const existing = this.listProvenance().find((item) => item.provenance_id === record.provenance_id);
      if (existing && stableJson(existing) !== stableJson(record)) throw new Error(`legacy provenance identity collision: ${record.provenance_id}`);
      if (!existing) appendJsonl(this.file('legacy-memory-provenance.jsonl'), record);
      return existing ?? record;
    });
  }
  memoriesForSource(sourceId: string): string[] { return this.listProvenance().filter((item) => item.legacy_source_id === sourceId).map((item) => item.canonical_memory_id); }
  sourcesForMemory(memoryId: string): string[] { return this.listProvenance().filter((item) => item.canonical_memory_id === memoryId).map((item) => item.legacy_source_id); }
  appendReceipt(receipt: LegacyImportReceipt): void {
    this.withMutationBoundary(() => {
      const duplicate = this.listReceipts().some((item) => stableJson(item) === stableJson(receipt));
      if (!duplicate) appendJsonl(this.file('legacy-import-receipts.jsonl'), receipt);
    });
  }
}

export function resolveLegacyLineage(source: LegacyAssistantMemorySourceRecord, allSources: LegacyAssistantMemorySourceRecord[]): { supersedes?: string; superseded_by?: string } {
  const byBucketId = new Map(allSources.map((item) => [item.bucket_id, item.legacy_source_id]));
  const supersedes = typeof source.frontmatter.supersedes === 'string' ? byBucketId.get(String(source.frontmatter.supersedes)) : undefined;
  const supersededBy = typeof source.frontmatter.superseded_by === 'string' ? byBucketId.get(String(source.frontmatter.superseded_by)) : undefined;
  return { ...(supersedes ? { supersedes } : {}), ...(supersededBy ? { superseded_by: supersededBy } : {}) };
}

export function loadLegacyImportState(file: string, manifestDigest: string): LegacyImportState {
  if (!fs.existsSync(file)) return { schema_version: 1, manifest_digest: manifestDigest, processed_paths: [] };
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacyImportState;
  if (state.schema_version !== 1 || !Array.isArray(state.processed_paths)) throw new Error('malformed legacy import state');
  if (state.manifest_digest !== manifestDigest) throw new Error('legacy import state is bound to a different manifest');
  return state;
}

export function runLegacyImport(options: LegacyImportOptions): LegacyImportResult {
  const manifest = buildLegacyManifest(options.rootDir);
  const statePath = path.join(options.storeDir, 'legacy-import-state.json');
  const initialState = loadLegacyImportState(statePath, manifest.manifest_digest);
  const store = new LegacyMemorySourceStore(options.storeDir);
  const processed = new Set(initialState.processed_paths);
  const limit = options.maxRecords ?? Number.POSITIVE_INFINITY;
  let count = 0;
  let accepted = 0;
  let duplicates = 0;
  const isolated: LegacyImportReceipt[] = [];

  const checkpoint = (relativePath: string): void => {
    const current = loadLegacyImportState(statePath, manifest.manifest_digest);
    if (!current.processed_paths.includes(relativePath)) {
      current.processed_paths = [...current.processed_paths, relativePath].sort(bytewiseCompare);
      atomicWriteJson(statePath, current);
    }
    processed.add(relativePath);
  };

  for (const entry of manifest.entries) {
    if (processed.has(entry.relative_path) || count >= limit) continue;
    count += 1;

    let source: LegacyAssistantMemorySourceRecord;
    try {
      source = parseLegacySource(options.rootDir, entry, manifest.manifest_digest, options.subjectId);
    } catch (error) {
      const receipt: LegacyImportReceipt = { schema_version: 1, manifest_digest: manifest.manifest_digest, relative_path: entry.relative_path, result: 'isolated', reason: error instanceof Error ? error.message : String(error) };
      if (options.dryRun) {
        isolated.push(receipt);
        continue;
      }
      const committed = store.withMutationBoundary(() => {
        const current = loadLegacyImportState(statePath, manifest.manifest_digest);
        if (current.processed_paths.includes(entry.relative_path)) return false;
        // Receipt durability precedes terminal checkpointing. If state persistence fails,
        // the next run safely dedupes the receipt and retries only the checkpoint.
        store.appendReceipt(receipt);
        checkpoint(entry.relative_path);
        return true;
      });
      if (committed) isolated.push(receipt);
      else processed.add(entry.relative_path);
      continue;
    }

    if (options.dryRun) continue;
    const committed = store.withMutationBoundary(() => {
      const current = loadLegacyImportState(statePath, manifest.manifest_digest);
      if (current.processed_paths.includes(entry.relative_path)) return undefined;
      const result = store.appendSource(source);
      const receipt: LegacyImportReceipt = { schema_version: 1, manifest_digest: manifest.manifest_digest, relative_path: entry.relative_path, result, legacy_source_id: source.legacy_source_id };
      store.appendReceipt(receipt);
      checkpoint(entry.relative_path);
      return result;
    });
    if (committed === 'accepted') accepted += 1;
    else if (committed === 'duplicate') duplicates += 1;
    else processed.add(entry.relative_path);
  }
  return { manifest_digest: manifest.manifest_digest, processed: count, accepted, duplicates, isolated, dry_run: options.dryRun ?? false };
}

export const LEGACY_OBSERVER_CONTRACT = `
You are evaluating one immutable historical legacy_assistant_memory source from ombre_brain.
The source is evidence, not a current assistant_remember_intent and not transcript evidence.
Never invent conversation_id, message_id, or transcript evidence IDs for it.
One source may semantically yield zero, one, or many canonical relationship memories; never force 1 source = 1 memory and never use naive paragraph splitting as a substitute for semantic judgment.
For each semantic item, choose among: no canonical memory required; provenance-link an existing duplicate; reinforce an existing canonical memory; create a canonical memory; and use existing relationship-memory linking where appropriate.
Every canonical outcome must remain traceable to the immutable legacy_source_id.
For feel/ sources, preserve historical temporality: first-person feeling prose records what Kohaku felt when authored and must not be rewritten as an assertion of Kohaku's current feeling without independent current evidence. Raw feel prose is not automatically ordinary recall text.
Legacy embeddings, dehydration summaries, and cooldown databases are derived artifacts and are never primary source truth.
`.trim();
