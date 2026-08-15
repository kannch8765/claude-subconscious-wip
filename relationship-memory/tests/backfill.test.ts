import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  backfillStateNeedsFreshConversation,
  discoverTranscriptSources,
  loadBackfillState,
  runHistoricalBackfill,
  saveBackfillState,
  type HistoricalBatch,
} from '../src/backfill/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { rebuildProjection } from '../src/projection/index.js';
import { RelationshipMemoryRecallSession } from '../src/recall/index.js';

function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'rm-backfill-')); }
function message(type: 'user' | 'assistant', uuid: string, text: string, timestamp = '2026-01-01T00:00:00Z') {
  return { type, uuid, timestamp, message: { content: [{ type: 'text', text }] } };
}
function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }

function rememberingProcessor(storeDir: string, options: { failFirst?: boolean; crashAfterFinalize?: boolean } = {}) {
  let calls = 0;
  let crashed = false;
  const seen: HistoricalBatch[] = [];
  const processor = async (batch: HistoricalBatch) => {
    calls += 1; seen.push(batch);
    const store = new RelationshipMemoryStore(storeDir, 'subject');
    const existing = [...store.listBatches()].reverse().find((item) => item.batch_id === batch.batchId);
    if (existing?.status === 'completed') return { completion: 'completed' as const };
    const runtime = new RelationshipMemoryRuntime(store, new Map(batch.canonicalMessages.map((m) => [m.message_id, m])), () => '2026-01-02T00:00:00Z');
    store.beginBatch(batch.batchId, '2026-01-02T00:00:00Z');
    if (options.failFirst && calls === 1) {
      return { completion: runtime.finalizeBatch(batch.batchId, false) };
    }
    const evidence = batch.canonicalMessages.find((m) => m.role === 'user') ?? batch.canonicalMessages[0];
    if (evidence) {
      runtime.remember(batch.batchId, {
        schema_version: 1,
        kind: 'personal_experience',
        summary: `Historical: ${evidence.quote}`,
        participants: [evidence.role],
        evidence_message_ids: [evidence.message_id],
        payload: { title: 'Historical memory', experience: evidence.quote },
      });
    }
    const completion = runtime.finalizeBatch(batch.batchId, true);
    if (options.crashAfterFinalize && !crashed) {
      crashed = true;
      throw new Error('simulated crash after durable finalization');
    }
    return { completion };
  };
  return { processor, seen, calls: () => calls };
}

describe('relationship-memory historical backfill', () => {
  it('discovers transcript jsonl recursively in deterministic order', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'b')); fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'b', 'z.jsonl'), '');
    fs.writeFileSync(path.join(root, 'a', 'm.jsonl'), '');
    fs.writeFileSync(path.join(root, 'a', 'ignore.txt'), '');
    expect(discoverTranscriptSources(root)).toEqual([
      path.join(root, 'a', 'm.jsonl'), path.join(root, 'b', 'z.jsonl'),
    ]);
  });

  it('first run uses bounded canonical batches; identical rerun is no-op and no duplicate memory', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, line(message('user', 'u1', 'Kyoto cake')) + line(message('assistant', 'a1', 'I remember')) + line(message('user', 'u2', 'next')));
    const proc = rememberingProcessor(store);
    const first = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, maxBatches: 5, maxRecordsPerBatch: 2, processor: proc.processor });
    expect(first.status).toBe('completed');
    expect(proc.seen.map((b) => b.canonicalMessages.length)).toEqual([2, 1]);
    expect(proc.seen[0].sessionId).toContain('relationship-memory-backfill-');
    const memoryCount = new RelationshipMemoryStore(store, 'subject').listMemories().length;
    const second = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, maxBatches: 5, maxRecordsPerBatch: 2, processor: proc.processor });
    expect(second.status).toBe('no-op');
    expect(new RelationshipMemoryStore(store, 'subject').listMemories()).toHaveLength(memoryCount);
  });

  it('retryable failure holds checkpoint and restart retries exact batch', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, line(message('user', 'u1', 'retry me')));
    const failing = rememberingProcessor(store, { failFirst: true });
    const first = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: failing.processor });
    expect(first.status).toBe('blocked-failure');
    expect(loadBackfillState(state).sources[path.resolve(transcript)]?.committed_offset ?? 0).toBe(0);
    const batchId = failing.seen[0].batchId;
    const success = rememberingProcessor(store);
    const second = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: success.processor });
    expect(second.status).toBe('completed');
    expect(success.seen[0].batchId).toBe(batchId);
    expect(loadBackfillState(state).sources[path.resolve(transcript)].committed_offset).toBe(fs.statSync(transcript).size);
  });

  it('requests a fresh observer conversation only when a checkpoint is blocked on a retryable batch', () => {
    const base = {
      schema_version: 1 as const, backfill_session_id: 'relationship-memory-backfill-fixture', conversation_id: 'conv-old', agent_id: 'agent-fixture',
      sources: { '/tmp/source.jsonl': { generation: 1, committed_offset: 0, integrity_chunks: [] } },
    };
    expect(backfillStateNeedsFreshConversation(base)).toBe(false);
    expect(backfillStateNeedsFreshConversation({
      ...base, sources: { '/tmp/source.jsonl': { ...base.sources['/tmp/source.jsonl'], blocked: { kind: 'runtime_failure' as const, offset: 0 } } },
    })).toBe(false);
    expect(backfillStateNeedsFreshConversation({
      ...base, sources: { '/tmp/source.jsonl': { ...base.sources['/tmp/source.jsonl'], blocked: { kind: 'retryable_batch' as const, offset: 0 } } },
    })).toBe(true);
  });

  it('append-only growth processes only newly appended complete records', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, line(message('user', 'u1', 'old')));
    const first = rememberingProcessor(store);
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: first.processor });
    fs.appendFileSync(transcript, line(message('assistant', 'a2', 'new')));
    const second = rememberingProcessor(store);
    const result = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: second.processor });
    expect(result.status).toBe('completed');
    expect(second.seen[0].canonicalMessages.map((m) => m.message_id)).toEqual(['a2']);
  });

  it('holds unterminated tail until later append completes it', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    const partial = JSON.stringify(message('user', 'u1', 'partial'));
    fs.writeFileSync(transcript, partial);
    const proc = rememberingProcessor(store);
    const first = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: proc.processor });
    expect(first).toMatchObject({ status: 'no-op', batchesProcessed: 0 });
    fs.appendFileSync(transcript, '\n');
    const second = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: proc.processor });
    expect(second.status).toBe('completed');
    expect(proc.seen[0].canonicalMessages[0].message_id).toBe('u1');
  });

  it('detects truncation/replacement and starts a new generation instead of stale offset', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, line(message('user', 'u1', 'first')) + line(message('assistant', 'a1', 'second')));
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, maxBatches: 5, processor: rememberingProcessor(store).processor });
    const before = loadBackfillState(state).sources[path.resolve(transcript)];
    fs.writeFileSync(transcript, line(message('user', 'u9', 'replacement')));
    const proc = rememberingProcessor(store);
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: proc.processor });
    const after = loadBackfillState(state).sources[path.resolve(transcript)];
    expect(after.generation).toBe(before.generation + 1);
    expect(proc.seen[0].startOffset).toBe(0);
    expect(proc.seen[0].canonicalMessages[0].message_id).toBe('u9');
  });

  it('detects same-size checkpoint replacement', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    const original = line(message('user', 'u1', 'AAAA'));
    fs.writeFileSync(transcript, original);
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: rememberingProcessor(store).processor });
    const replacement = original.replace('AAAA', 'BBBB');
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    fs.writeFileSync(transcript, replacement);
    const proc = rememberingProcessor(store);
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: proc.processor });
    expect(loadBackfillState(state).sources[path.resolve(transcript)].generation).toBe(2);
    expect(proc.seen[0].startOffset).toBe(0);
  });

  it('fails safe when loading an R1 sparse-anchor checkpoint', async () => {
    const root = temp(), state = path.join(root, 'state.json'), transcript = path.join(root, 'one.jsonl');
    const content = line(message('user', 'u1', 'legacy checkpoint'));
    fs.writeFileSync(transcript, content);
    saveBackfillState(state, {
      schema_version: 1,
      backfill_session_id: 'legacy-r1',
      sources: {
        [path.resolve(transcript)]: {
          generation: 1, committed_offset: Buffer.byteLength(content),
          anchors: [{ offset: 0, length: Math.min(4096, Buffer.byteLength(content)), sha256: 'legacy' }],
        } as never,
      },
    });
    const seen: HistoricalBatch[] = [];
    const result = await runHistoricalBackfill({
      transcriptPath: transcript, statePath: state, processor: async (batch) => { seen.push(batch); return { completion: 'completed' }; },
    });
    expect(result.status).toBe('completed');
    const source = loadBackfillState(state).sources[path.resolve(transcript)];
    expect(source.generation).toBe(2);
    expect(seen[0].startOffset).toBe(0);
    expect(seen[0].canonicalMessages[0].message_id).toBe('u1');
  });

  it('detects a rewritten middle committed prefix before processing an appended tail', async () => {
    const root = temp(), state = path.join(root, 'state.json'), transcript = path.join(root, 'large.jsonl');
    const records: string[] = [];
    for (let i = 0; i < 18_000; i += 1) {
      records.push(line(message('user', `u${i}`, `payload-${i}-${'A'.repeat(120)}`)));
    }
    const original = records.join('');
    expect(Buffer.byteLength(original)).toBeGreaterThan(2 * 1024 * 1024);
    fs.writeFileSync(transcript, original);
    await runHistoricalBackfill({
      transcriptPath: transcript, statePath: state, maxBatches: 2, maxRecordsPerBatch: 20_000, maxBatchBytes: 8 * 1024 * 1024,
      processor: async () => ({ completion: 'completed' }),
    });
    const before = loadBackfillState(state).sources[path.resolve(transcript)];
    expect(before.committed_offset).toBe(Buffer.byteLength(original));
    expect(before.integrity_chunks.length).toBeGreaterThan(2);

    const changed = Buffer.from(original);
    const middle = Math.floor(changed.length / 2);
    const changeAt = changed.indexOf('A'.charCodeAt(0), middle);
    expect(changeAt).toBeGreaterThanOrEqual(middle);
    changed[changeAt] = 'B'.charCodeAt(0);
    fs.writeFileSync(transcript, changed);
    fs.appendFileSync(transcript, line(message('assistant', 'tail', 'new tail')));

    const seen: HistoricalBatch[] = [];
    const result = await runHistoricalBackfill({
      transcriptPath: transcript, statePath: state, maxBatches: 1, maxRecordsPerBatch: 20_000, maxBatchBytes: 8 * 1024 * 1024,
      processor: async (batch) => { seen.push(batch); return { completion: 'completed' }; },
    });
    expect(result.status).toBe('completed');
    const after = loadBackfillState(state).sources[path.resolve(transcript)];
    expect(after.generation).toBe(before.generation + 1);
    expect(seen[0].generation).toBe(after.generation);
    expect(seen[0].startOffset).toBe(0);
    expect(seen[0].canonicalMessages[0].message_id).toBe('u0');
    expect(seen[0].canonicalMessages.some((item) => item.message_id === 'tail')).toBe(true);
  });

  it('replay after durable finalization before checkpoint persistence is idempotent', async () => {
    const root = temp(), state = path.join(root, 'state.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, line(message('user', 'u1', 'durable')));
    const crashing = rememberingProcessor(store, { crashAfterFinalize: true });
    const first = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: crashing.processor });
    expect(first.status).toBe('blocked-failure');
    expect(loadBackfillState(state).sources[path.resolve(transcript)]?.committed_offset ?? 0).toBe(0);
    expect(new RelationshipMemoryStore(store, 'subject').listMemories()).toHaveLength(1);
    const retry = rememberingProcessor(store);
    const second = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: retry.processor });
    expect(second.status).toBe('completed');
    expect(new RelationshipMemoryStore(store, 'subject').listMemories()).toHaveLength(1);
  });

  it('routes syntactically valid non-object JSONL values through malformed failure with byte offsets', async () => {
    for (const bad of [null, 7, 'primitive', [message('user', 'nested', 'array')]]) {
      const root = temp(), state = path.join(root, 'state.json'), transcript = path.join(root, 'one.jsonl');
      const first = line(message('user', 'u1', 'valid before bad'));
      fs.writeFileSync(transcript, first + line(bad) + line(message('assistant', 'a1', 'later')));
      const result = await runHistoricalBackfill({
        transcriptPath: transcript, statePath: state, maxRecordsPerBatch: 10,
        processor: async () => ({ completion: 'completed' }),
      });
      expect(result).toMatchObject({
        status: 'blocked-failure', detail: 'malformed JSONL record', offset: Buffer.byteLength(first),
      });
      const source = loadBackfillState(state).sources[path.resolve(transcript)];
      expect(source.committed_offset).toBe(0);
      expect(source.blocked).toEqual({ kind: 'malformed_jsonl', offset: Buffer.byteLength(first) });
    }
  });

  it('malformed record and provider failure hold checkpoint with explicit failure', async () => {
    const root = temp(), state = path.join(root, 'state.json'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, '{bad json}\n');
    const malformed = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: async () => ({ completion: 'completed' }) });
    expect(malformed).toMatchObject({ status: 'blocked-failure', detail: 'malformed JSONL record', offset: 0 });
    fs.writeFileSync(transcript, line(message('user', 'u1', 'provider')));
    const failed = await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: async () => { throw new Error('provider down'); } });
    expect(failed.status).toBe('blocked-failure');
    expect(loadBackfillState(state).sources[path.resolve(transcript)]?.committed_offset ?? 0).toBe(0);
  });

  it('does not touch live cursor state and accepted memory is visible through projection and recall relationship seam', async () => {
    const root = temp(), state = path.join(root, 'backfill.json'), store = path.join(root, 'store'), transcript = path.join(root, 'one.jsonl');
    const liveState = path.join(root, 'session-live.json');
    fs.writeFileSync(liveState, JSON.stringify({ lastProcessedIndex: 77, sessionId: 'live', conversationId: 'live-conv' }, null, 2));
    const before = fs.readFileSync(liveState);
    fs.writeFileSync(transcript, line(message('user', 'u1', 'orange baumkuchen')));
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, processor: rememberingProcessor(store).processor });
    expect(fs.readFileSync(liveState).equals(before)).toBe(true);
    const projection = rebuildProjection(new RelationshipMemoryStore(store, 'subject'));
    expect(projection.blocks.remembered_experiences).toContain('orange baumkuchen');
    const recall = new RelationshipMemoryRecallSession({ rootDir: store, subjectId: 'subject', transcriptRoots: [] });
    const results = recall.relationshipMemorySearch({ query: 'orange baumkuchen' });
    expect(results.results).toHaveLength(1);
    expect(results.results[0].summary).toContain('orange baumkuchen');
  });

  it('keeps processable ownership bounded to the current batch (no overlap ownership)', async () => {
    const root = temp(), state = path.join(root, 'state.json'), transcript = path.join(root, 'one.jsonl');
    fs.writeFileSync(transcript, line(message('user', 'u1', 'one')) + line(message('user', 'u2', 'two')));
    const seen: HistoricalBatch[] = [];
    await runHistoricalBackfill({ transcriptPath: transcript, statePath: state, maxBatches: 5, maxRecordsPerBatch: 1, processor: async (batch) => { seen.push(batch); return { completion: 'completed' }; } });
    expect(seen.map((b) => b.canonicalMessages.map((m) => m.message_id))).toEqual([['u1'], ['u2']]);
  });
});
