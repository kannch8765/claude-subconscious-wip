import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalMemoryRecord, EvidenceRecord, ReinforcementRecord } from '../src/schema/index.js';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { clearReadCaches } from '../src/store/read_cache.js';
import { FileBackedSemanticRetriever, type EmbeddingProvider, type SemanticDocument } from '../src/retrieval/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';

// Every fixture here is synthetic: made-up ids, ASCII filler text, hashed vectors.
const SUBJECT = 'subject-synthetic';
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-memory-read-cache-'));
  roots.push(root);
  return root;
}

beforeEach(() => clearReadCaches());
afterEach(() => {
  vi.unstubAllEnvs();
  clearReadCaches();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

function memory(id: string, summary = `synthetic summary for ${id}`): CanonicalMemoryRecord {
  return {
    schema_version: 1, memory_id: id, subject_id: SUBJECT, kind: 'shared_experience', summary,
    participants: ['user', 'assistant'], payload: { detail: `synthetic detail ${id} lantern harbor` }, status: 'active',
    observed_at: '2026-03-01T00:00:00.000Z', created_at: '2026-03-01T00:00:00.000Z', source_key: `src-${id}`, dedupe_key: `dedupe-${id}`,
  };
}

function evidence(evidenceId: string, memoryId: string, quote = `synthetic quote ${evidenceId}`): EvidenceRecord {
  return {
    evidence_id: evidenceId, memory_id: memoryId, conversation_id: 'conversation-synthetic', message_id: `message-${evidenceId}`,
    role: 'user', quote, captured_at: `2026-03-01T00:00:${String(Number(evidenceId.replace(/\D/g, '')) % 60).padStart(2, '0')}.000Z`, event_kind: 'user_text',
  };
}

function reinforcement(id: string, memoryId: string, evidenceIds: string[]): ReinforcementRecord {
  return {
    schema_version: 1, reinforcement_id: id, memory_id: memoryId, batch_id: `batch-${id}`, evidence_ids: evidenceIds,
    latest_evidence_at: '2026-03-02T00:00:00.000Z', recorded_at: '2026-03-02T00:00:00.000Z',
  };
}

function readOnlyStore(root: string): RelationshipMemoryStore {
  return new RelationshipMemoryStore(root, SUBJECT, undefined, false);
}

function replaceByRename(file: string, content: string): void {
  const temp = `${file}.replace.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function withCacheOff<T>(read: () => T): T {
  vi.stubEnv('RELATIONSHIP_MEMORY_READ_CACHE', 'off');
  try { return read(); } finally { vi.unstubAllEnvs(); }
}

async function withCacheOffAsync<T>(read: () => Promise<T>): Promise<T> {
  vi.stubEnv('RELATIONSHIP_MEMORY_READ_CACHE', 'off');
  try { return await read(); } finally { vi.unstubAllEnvs(); }
}

describe('store JSONL read cache', () => {
  it('sees an append and parses only the new lines', () => {
    const root = tempRoot();
    const file = path.join(root, 'memories.jsonl');
    fs.writeFileSync(file, line(memory('mem-1')));
    const store = readOnlyStore(root);
    const first = store.listMemories();
    expect(first.map((item) => item.memory_id)).toEqual(['mem-1']);

    fs.appendFileSync(file, line(memory('mem-2')));
    const second = store.listMemories();
    expect(second.map((item) => item.memory_id)).toEqual(['mem-1', 'mem-2']);
    // The first record is reused, not re-parsed; callers still get a fresh array.
    expect(second[0]).toBe(first[0]);
    expect(second).not.toBe(first);
    second.pop();
    expect(store.listMemories()).toHaveLength(2);
  });

  it('sees a same-size in-place replacement even when mtime is put back', () => {
    const root = tempRoot();
    const file = path.join(root, 'memories.jsonl');
    fs.writeFileSync(file, line(memory('mem-1', 'summary AAAA')));
    const before = fs.statSync(file);
    const store = readOnlyStore(root);
    expect(store.listMemories()[0].summary).toBe('summary AAAA');

    fs.writeFileSync(file, line(memory('mem-1', 'summary BBBB')));
    fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).size).toBe(before.size);
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(store.listMemories()[0].summary).toBe('summary BBBB');
  });

  it('sees a same-size in-place change inside the tail guard of a large file', () => {
    const root = tempRoot();
    const file = path.join(root, 'evidence.jsonl');
    const records = Array.from({ length: 200 }, (_, index) => evidence(`ev-${index}`, `mem-${index % 7}`));
    fs.writeFileSync(file, records.map(line).join(''));
    expect(fs.statSync(file).size).toBeGreaterThan(4 * 4096);
    const store = readOnlyStore(root);
    expect(store.listEvidence()).toHaveLength(200);
    expect(store.listEvidenceForMemoryIds(['mem-3'])).toHaveLength(29);

    const before = fs.statSync(file);
    const changed = { ...records[199], quote: records[199].quote.replace('synthetic', 'SYNTHETIC') };
    fs.writeFileSync(file, [...records.slice(0, 199), changed].map(line).join(''));
    fs.utimesSync(file, before.atime, before.mtime);
    expect(store.listEvidence().at(-1)!.quote).toBe(changed.quote);
    expect(store.listEvidenceForMemoryIds([changed.memory_id]).at(-1)!.quote).toBe(changed.quote);
  });

  it('sees an inode swap, including a larger file that keeps the old bytes as its prefix', () => {
    const root = tempRoot();
    const file = path.join(root, 'memories.jsonl');
    fs.writeFileSync(file, line(memory('mem-1')));
    const store = readOnlyStore(root);
    const first = store.listMemories();

    replaceByRename(file, line(memory('mem-x')));
    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-x']);

    replaceByRename(file, line(memory('mem-x')) + line(memory('mem-y')));
    const third = store.listMemories();
    expect(third.map((item) => item.memory_id)).toEqual(['mem-x', 'mem-y']);
    expect(third[0]).not.toBe(first[0]);
  });

  it('reloads after a shrink and after a rewrite that grows the file', () => {
    const root = tempRoot();
    const file = path.join(root, 'memories.jsonl');
    fs.writeFileSync(file, line(memory('mem-1')) + line(memory('mem-2')));
    const store = readOnlyStore(root);
    expect(store.listMemories()).toHaveLength(2);

    fs.writeFileSync(file, line(memory('mem-3')));
    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-3']);

    // Same inode, larger, but the old bytes were rewritten rather than appended to.
    fs.writeFileSync(file, line(memory('mem-4', 'a much longer synthetic summary than before')) + line(memory('mem-5')));
    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-4', 'mem-5']);
  });

  it('sees a write from a second store instance', () => {
    const root = tempRoot();
    const reader = readOnlyStore(root);
    expect(reader.listMemories()).toEqual([]);
    expect(reader.listEvidenceForMemoryIds(['mem-1'])).toEqual([]);

    const writer = new RelationshipMemoryStore(root, SUBJECT);
    writer.appendMemory(memory('mem-1'), [evidence('ev-1', 'mem-1')]);
    expect(reader.listMemories().map((item) => item.memory_id)).toEqual(['mem-1']);
    expect(reader.listEvidenceForMemoryIds(['mem-1']).map((item) => item.evidence_id)).toEqual(['ev-1']);

    writer.appendReinforcement(reinforcement('reinf-1', 'mem-1', ['ev-2']), [evidence('ev-2', 'mem-1')]);
    expect(reader.listReinforcements().map((item) => item.reinforcement_id)).toEqual(['reinf-1']);
    expect(reader.listEvidenceForMemoryIds(['mem-1']).map((item) => item.evidence_id)).toEqual(['ev-1', 'ev-2']);
  });

  it('sees appends from another process while it keeps reading', async () => {
    const root = tempRoot();
    const store = readOnlyStore(root);
    expect(store.listOutcomes()).toEqual([]);
    const child = spawn(path.resolve('node_modules/.bin/tsx'), [path.resolve('relationship-memory/tests/concurrent-writer-child.ts'), 'append', root, 'batch-child', ''], {
      cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let exited = false;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => { exited = true; resolve(code); }));
    const counts: number[] = [];
    while (!exited) {
      counts.push(store.listOutcomes().length);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(await closed, stderr).toBe(0);
    for (let index = 1; index < counts.length; index += 1) expect(counts[index]).toBeGreaterThanOrEqual(counts[index - 1]);
    const final = store.listOutcomes();
    expect(final).toHaveLength(100);
    expect(final).toEqual(withCacheOff(() => readOnlyStore(root).listOutcomes()));
  });

  it('ignores a partial trailing line and picks it up once complete', () => {
    const root = tempRoot();
    const memories = path.join(root, 'memories.jsonl');
    const evidenceFile = path.join(root, 'evidence.jsonl');
    const pending = line(memory('mem-2'));
    const pendingEvidence = line(evidence('ev-2', 'mem-1'));
    fs.writeFileSync(memories, line(memory('mem-1')) + pending.slice(0, 40));
    fs.writeFileSync(evidenceFile, line(evidence('ev-1', 'mem-1')) + pendingEvidence.slice(0, pendingEvidence.indexOf('"role"')));
    const store = new RelationshipMemoryStore(root, SUBJECT);

    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-1']);
    expect(store.listEvidenceForMemoryIds(['mem-1']).map((item) => item.evidence_id)).toEqual(['ev-1']);
    // Under the mutation lock no writer can be mid-append, so the tail is corrupt.
    expect(() => store.withMutationBoundary(() => store.listMemories())).toThrow(SyntaxError);
    expect(() => store.withMutationBoundary(() => store.listEvidenceForMemoryIds(['mem-1']))).toThrow(SyntaxError);

    fs.appendFileSync(memories, pending.slice(40));
    fs.appendFileSync(evidenceFile, pendingEvidence.slice(pendingEvidence.indexOf('"role"')));
    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-1', 'mem-2']);
    expect(store.listEvidenceForMemoryIds(['mem-1']).map((item) => item.evidence_id)).toEqual(['ev-1', 'ev-2']);
  });

  it('returns a complete last record without a final newline, as before, and never caches it', () => {
    const root = tempRoot();
    const file = path.join(root, 'memories.jsonl');
    fs.writeFileSync(file, line(memory('mem-1')) + JSON.stringify(memory('mem-2')));
    const store = readOnlyStore(root);
    const expected = withCacheOff(() => store.listMemories());
    expect(store.listMemories()).toEqual(expected);
    expect(store.listMemories()).toEqual(expected);

    fs.appendFileSync(file, `\n${line(memory('mem-3'))}`);
    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-1', 'mem-2', 'mem-3']);
  });

  it('keeps the old corrupt-line behavior: full listings throw, evidence lookups throw only for matching ids', () => {
    const root = tempRoot();
    const file = path.join(root, 'evidence.jsonl');
    const corrupt = line(evidence('ev-2', 'mem-b')).replace('"role"', '"role');
    fs.writeFileSync(file, line(evidence('ev-1', 'mem-a')) + corrupt + line(evidence('ev-3', 'mem-a')));
    const store = readOnlyStore(root);
    for (const read of [() => store.listEvidence(), () => store.listEvidenceForMemoryIds(['mem-a', 'mem-b'])]) {
      expect(read).toThrow(SyntaxError);
      expect(() => withCacheOff(read)).toThrow(SyntaxError);
    }
    expect(store.listEvidenceForMemoryIds(['mem-a'])).toEqual(withCacheOff(() => store.listEvidenceForMemoryIds(['mem-a'])));
    expect(store.listEvidenceForMemoryIds(['mem-a']).map((item) => item.evidence_id)).toEqual(['ev-1', 'ev-3']);
  });

  it('answers evidence lookups in requested-id order, deduplicated, in file order per id', () => {
    const root = tempRoot();
    const file = path.join(root, 'evidence.jsonl');
    const records = [evidence('ev-1', 'mem-b'), evidence('ev-2', 'mem-a'), evidence('ev-3', 'mem-b'), evidence('ev-4', 'mem-c')];
    fs.writeFileSync(file, records.map(line).join(''));
    const store = readOnlyStore(root);
    const ids = ['mem-b', 'mem-missing', 'mem-a', 'mem-b'];
    expect(store.listEvidenceForMemoryIds(ids).map((item) => item.evidence_id)).toEqual(['ev-1', 'ev-3', 'ev-2']);
    expect(store.listEvidenceForMemoryIds(ids)).toEqual(withCacheOff(() => store.listEvidenceForMemoryIds(ids)));
    expect(store.listEvidenceForMemoryIds([])).toEqual([]);
  });

  it('turns off with RELATIONSHIP_MEMORY_READ_CACHE=off', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'memories.jsonl'), line(memory('mem-1')));
    const store = readOnlyStore(root);
    withCacheOff(() => {
      const first = store.listMemories();
      expect(store.listMemories()[0]).not.toBe(first[0]);
    });
    const cached = store.listMemories();
    expect(store.listMemories()[0]).toBe(cached[0]);
  });

  it('drops the cache after the idle period', async () => {
    vi.stubEnv('RELATIONSHIP_MEMORY_READ_CACHE_IDLE_MS', '40');
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'memories.jsonl'), line(memory('mem-1')));
    const store = readOnlyStore(root);
    const first = store.listMemories();
    expect(store.listMemories()[0]).toBe(first[0]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(store.listMemories()[0]).not.toBe(first[0]);
  });
});

const DIMENSIONS = 8;

function hashedVector(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text).digest();
  return Array.from({ length: DIMENSIONS }, (_, index) => digest.readInt16LE(index * 2) / 32768);
}

class HashedProvider implements EmbeddingProvider {
  readonly fingerprint = 'hashed-provider-synthetic';
  readonly model = 'hashed';
  readonly dimensions = DIMENSIONS;
  readonly maxBatchSize = 50;
  async embedDocuments(texts: string[]): Promise<number[][]> { return texts.map((text) => hashedVector(`doc:${text}`)); }
  async embedQuery(text: string): Promise<number[]> { return hashedVector(`query:${text}`); }
}

const WORDS = ['lantern', 'harbor', 'violet', 'orchard', 'pebble', 'comet', 'meadow', 'saffron', 'tundra', 'quill'];

describe('cached reads equal uncached reads', () => {
  function seedStore(root: string, count: number, offset = 0): void {
    const memories: CanonicalMemoryRecord[] = [];
    const evidenceRecords: EvidenceRecord[] = [];
    const reinforcements: ReinforcementRecord[] = [];
    for (let index = offset; index < offset + count; index += 1) {
      const id = `mem-${index}`;
      memories.push(memory(id, `${WORDS[index % WORDS.length]} ${WORDS[(index * 3) % WORDS.length]} synthetic summary ${index}`));
      for (let e = 0; e < 3; e += 1) evidenceRecords.push(evidence(`ev-${index}-${e}`, id, `${WORDS[(index + e) % WORDS.length]} synthetic quote ${index}-${e}`));
      if (index % 4 === 0) reinforcements.push(reinforcement(`reinf-${index}`, id, [`ev-${index}-0`]));
    }
    fs.appendFileSync(path.join(root, 'memories.jsonl'), memories.map(line).join(''));
    fs.appendFileSync(path.join(root, 'evidence.jsonl'), evidenceRecords.map(line).join(''));
    fs.appendFileSync(path.join(root, 'reinforcements.jsonl'), reinforcements.map(line).join(''));
  }

  async function observe(root: string, indexFile: string) {
    const store = readOnlyStore(root);
    const retriever = new FileBackedSemanticRetriever(new HashedProvider(), indexFile);
    const runtime = new RelationshipMemoryRuntime(store, new Map(), undefined, new Map(), false, retriever);
    const documents: SemanticDocument[] = store.listMemories().map((item) => ({ id: `memory:${item.memory_id}`, text: item.summary }));
    return {
      memories: store.listMemories(),
      evidence: store.listEvidence(),
      reinforcements: store.listReinforcements(),
      evidenceById: store.listEvidenceForMemoryIds(['mem-3', 'mem-1', 'mem-missing', 'mem-3', 'mem-40']),
      recalls: await Promise.all(['lantern harbor', 'violet', 'comet meadow quill', 'nothing matches'].map((query) =>
        runtime.memorySearchRecallHybridWithEvidence({ query, limit: 6 }))),
      ranked: [...await retriever.rankExisting!(documents, 'saffron tundra')],
    };
  }

  async function expectSameAsUncached(root: string, indexFile: string): Promise<void> {
    const cold = await observe(root, indexFile);
    const warm = await observe(root, indexFile);
    const uncached = await withCacheOffAsync(() => observe(root, indexFile));
    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
  }

  it('matches through appends, index rewrites, in-place edits and replacements', async () => {
    const root = tempRoot();
    const indexFile = path.join(tempRoot(), 'index.json');
    seedStore(root, 30);
    const prepare = () => new RelationshipMemoryRuntime(new RelationshipMemoryStore(root, SUBJECT), new Map(), undefined, new Map(), false,
      new FileBackedSemanticRetriever(new HashedProvider(), indexFile)).prepareCurrentMemorySemanticIndex();
    await prepare();
    await expectSameAsUncached(root, indexFile);

    // Another writer appends; the index does not cover the new memories yet.
    seedStore(root, 20, 30);
    await expectSameAsUncached(root, indexFile);

    // The index is refreshed (temp file + rename).
    await prepare();
    await expectSameAsUncached(root, indexFile);

    // A same-size in-place edit changes one summary, so its vector goes stale.
    const memoriesFile = path.join(root, 'memories.jsonl');
    const text = fs.readFileSync(memoriesFile, 'utf8');
    fs.writeFileSync(memoriesFile, text.replace('synthetic summary 7', 'SYNTHETIC summary 7'));
    await expectSameAsUncached(root, indexFile);

    // Evidence is replaced by a smaller file with a new inode.
    const evidenceFile = path.join(root, 'evidence.jsonl');
    const kept = fs.readFileSync(evidenceFile, 'utf8').split('\n').filter((row, index) => row && index % 2 === 0);
    replaceByRename(evidenceFile, kept.map((row) => `${row}\n`).join(''));
    await expectSameAsUncached(root, indexFile);
  });

  it('sees an index replaced by rename between recalls', async () => {
    const root = tempRoot();
    const indexFile = path.join(tempRoot(), 'index.json');
    seedStore(root, 10);
    const store = readOnlyStore(root);
    const documents: SemanticDocument[] = store.listMemories().map((item) => ({ id: `memory:${item.memory_id}`, text: item.summary }));
    const retriever = new FileBackedSemanticRetriever(new HashedProvider(), indexFile);
    await retriever.prepare!(documents);
    const before = await retriever.rankExisting!(documents, 'pebble');

    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.documents[documents[0].id].vector = hashedVector('replacement vector');
    delete index.documents[documents[1].id];
    replaceByRename(indexFile, `${JSON.stringify(index)}\n`);

    const after = await retriever.rankExisting!(documents, 'pebble');
    expect(after.get(documents[0].id)).not.toBe(before.get(documents[0].id));
    expect(after.has(documents[1].id)).toBe(false);
    expect([...after]).toEqual([...await withCacheOffAsync(() => retriever.rankExisting!(documents, 'pebble'))]);
  });
});
