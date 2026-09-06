import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_REMEMBER_TOOL_NAME,
  FileBackedSemanticRetriever,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  executeRecall,
  type AssistantRememberIntentRecord,
  type EmbeddingProvider,
  type SemanticRankTiming,
} from '../src/index.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING;
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE;
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seedRelationshipMemory(root: string): void {
  const store = new RelationshipMemoryStore(root, 'subject-1');
  const intent: AssistantRememberIntentRecord = {
    schema_version: 1,
    intent_id: 'intent-timing-1',
    subject_id: 'subject-1',
    session_id: 'session-timing-1',
    assistant_message_id: 'assistant-timing-1',
    tool_use_id: 'tool-timing-1',
    tool_name: ASSISTANT_REMEMBER_TOOL_NAME,
    memory: { text: 'Remember the orange cake inclusion gesture from Kyoto.' },
    feel: { text: 'I felt warmly held in mind and included.' },
    captured_at: '2026-08-04T10:00:00.000Z',
  };
  store.appendAssistantIntent(intent);
  const messages = new Map([['user-evidence-timing-1', {
    conversation_id: 'conversation-timing-1', message_id: 'user-evidence-timing-1', role: 'user' as const,
    quote: 'I brought back the orange cake for you too.', captured_at: '2026-08-04T09:59:00.000Z',
  }]]);
  const runtime = new RelationshipMemoryRuntime(store, messages, () => '2026-08-04T10:01:00.000Z', new Map([[intent.intent_id, intent]]));
  store.beginBatch('batch-timing-1', '2026-08-04T10:00:00.000Z');
  const remembered = runtime.remember('batch-timing-1', {
    schema_version: 1,
    kind: 'shared_experience',
    summary: 'The user explicitly included the assistant when bringing a Kyoto gift home.',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['user-evidence-timing-1'],
    assistant_intent_id: intent.intent_id,
    payload: {
      title: 'Kyoto orange cake inclusion',
      event: 'The user brought home an orange-flavored cake for the assistant too.',
      shared_meaning: 'The assistant was counted among the people the user wanted to bring something home for.',
      recall_triggers: ['Kyoto', 'orange cake'],
    },
  });
  expect(remembered.outcome).toBe('accepted');
  runtime.finalizeBatch('batch-timing-1', true);
}

function writeTranscriptFixture(root: string): void {
  fs.writeFileSync(path.join(root, 'timing.jsonl'), [
    { type: 'user', uuid: 'timing-u1', timestamp: '2026-08-04T09:00:00.000Z', message: { content: [{ type: 'text', text: 'Today we worked on the relationship-memory scaffold and direct transcript JSONL source.' }] } },
    { type: 'assistant', uuid: 'timing-a1', timestamp: '2026-08-04T09:01:00.000Z', message: { content: [{ type: 'text', text: 'We kept the relationship-memory runtime read-only during explicit recall.' }] } },
    { type: 'system', uuid: 'timing-system', timestamp: '2026-08-04T09:02:00.000Z', content: 'SENSITIVE_SYSTEM_MARKER' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
}

async function runInstrumentedRecall(root: string, transcripts: string, recallId: string) {
  const semanticRetriever = {
    async rank() { throw new Error('foreground refresh is not expected'); },
    async rankExisting(
      documents: Array<{ id: string }>,
      _query: string,
      _signal?: AbortSignal,
      timing?: SemanticRankTiming,
    ) {
      timing?.segment('semantic_index_lookup', 0.25, { document_count: documents.length, usable_vectors: documents.length });
      timing?.segment('query_embedding', 1.25, { usable_vectors: documents.length });
      timing?.segment('vector_compare', 0.5, { usable_vectors: documents.length });
      return new Map(documents.map((document, index) => [document.id, 0.9 - index * 0.01]));
    },
  };
  const query = 'relationship-memory Kyoto SENSITIVE_QUERY_MARKER';
  return executeRecall({
    query,
    rootDir: root,
    subjectId: 'subject-1',
    transcriptRoots: [transcripts],
    semanticRetriever,
    recallId,
    async runModel(session) {
      const initial = await session.evidenceBundle({ query });
      await session.expandEvidenceBundle({ query });
      session.deliver({ recall_id: session.recallId, answer: 'instrumentation test answer', source_refs: initial.source_refs });
    },
  });
}

describe('explicit recall timing instrumentation', () => {
  it('is off by default, emits all required segments when enabled, and preserves the exact recall result', async () => {
    const root = temp('rm-recall-timing-store-');
    seedRelationshipMemory(root);
    const transcripts = temp('rm-recall-timing-transcripts-');
    writeTranscriptFixture(transcripts);
    const timingFile = path.join(temp('rm-recall-timing-output-'), 'timing.jsonl');
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING;
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE = timingFile;
    const disabled = await runInstrumentedRecall(root, transcripts, 'recall-timing-fixed');
    expect(fs.existsSync(timingFile)).toBe(false);
    expect(stderrWrite).not.toHaveBeenCalled();

    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING = '1';
    const enabled = await runInstrumentedRecall(root, transcripts, 'recall-timing-fixed');
    expect(JSON.stringify(enabled)).toBe(JSON.stringify(disabled));

    const raw = fs.readFileSync(timingFile, 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.schema_version === 1 && line.event === 'relationship_memory_recall_timing')).toBe(true);
    expect(lines.every((line) => line.recall_id === 'recall-timing-fixed')).toBe(true);
    expect(lines.every((line) => typeof line.duration_ms === 'number' && line.duration_ms >= 0)).toBe(true);
    expect(lines.map((line) => line.segment)).toEqual(expect.arrayContaining([
      'candidate_set_build', 'lexical_scoring', 'semantic_index_lookup', 'query_embedding', 'vector_compare', 'ranking_sort',
      'transcript_search', 'transcript_read', 'fit_evidence_bundle', 'evidence_bundle_total', 'expand_recall', 'recall_total',
    ]));
    expect(lines.filter((line) => line.segment === 'candidate_set_build').map((line) => line.phase)).toEqual(expect.arrayContaining(['initial', 'expand']));
    expect(lines.filter((line) => line.segment === 'query_embedding').map((line) => line.phase)).toEqual(expect.arrayContaining(['initial', 'expand']));
    expect(lines.find((line) => line.segment === 'recall_total')).toEqual(expect.objectContaining({ phase: 'total', expand_recall: true }));
    const transcriptSearch = lines.find((line) => line.segment === 'transcript_search' && line.phase === 'initial');
    expect(transcriptSearch).toEqual(expect.objectContaining({ scanned_files: 1 }));
    expect(transcriptSearch.parsed_lines).toBeGreaterThan(0);
    expect(lines.some((line) => line.segment === 'transcript_read' && line.phase === 'initial')).toBe(true);

    console.log('TASK15_RECALL_TIMING_SAMPLE');
    for (const event of ['candidate_set_build', 'query_embedding', 'transcript_search', 'fit_evidence_bundle', 'recall_total']) {
      const sample = lines.find((line) => line.segment === event && (event === 'recall_total' || line.phase === 'initial'));
      if (sample) console.log(JSON.stringify(sample));
    }

    expect(raw).not.toContain('SENSITIVE_QUERY_MARKER');
    expect(raw).not.toContain('relationship-memory scaffold');
    expect(raw).not.toContain('Remember the orange cake inclusion gesture from Kyoto.');
    expect(raw).not.toContain('The user explicitly included the assistant when bringing a Kyoto gift home.');
    expect(raw).not.toContain('SENSITIVE_SYSTEM_MARKER');
  });

  it('keeps recall working when the timing file cannot be written', async () => {
    const root = temp('rm-recall-timing-failure-store-');
    seedRelationshipMemory(root);
    const transcripts = temp('rm-recall-timing-failure-transcripts-');
    writeTranscriptFixture(transcripts);
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING = '1';
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE = path.join(temp('rm-recall-timing-failure-output-'), 'missing-parent', 'timing.jsonl');

    const result = await runInstrumentedRecall(root, transcripts, 'recall-timing-write-failure');
    expect(result).toEqual(expect.objectContaining({ status: 'ok', answer: 'instrumentation test answer' }));
  });

  it('refuses to place timing output inside the relationship-memory store', async () => {
    const root = temp('rm-recall-timing-store-boundary-');
    seedRelationshipMemory(root);
    const transcripts = temp('rm-recall-timing-store-boundary-transcripts-');
    writeTranscriptFixture(transcripts);
    const forbiddenTimingFile = path.join(root, 'recall-timing.jsonl');
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING = '1';
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE = forbiddenTimingFile;

    const result = await runInstrumentedRecall(root, transcripts, 'recall-timing-store-boundary');
    expect(result.status).toBe('ok');
    expect(fs.existsSync(forbiddenTimingFile)).toBe(false);
  });

  it('measures the real rankExisting local lookup, query embedding, and vector comparison boundaries', async () => {
    const indexFile = path.join(temp('rm-recall-timing-semantic-index-'), 'index.json');
    let queryCalls = 0;
    const provider: EmbeddingProvider = {
      fingerprint: 'timing-provider-v1',
      model: 'mock-embedding',
      dimensions: 2,
      maxBatchSize: 10,
      async embedDocuments(texts) { return texts.map(() => [1, 0]); },
      async embedQuery() { queryCalls += 1; return [1, 0]; },
    };
    const retriever = new FileBackedSemanticRetriever(provider, indexFile);
    const documents = [{ id: 'doc-1', text: 'synthetic document' }];
    await retriever.rank(documents, 'seed derivative index');
    queryCalls = 0;

    const events: Array<{ name: string; durationMs: number; counts?: Record<string, number> }> = [];
    const ranked = await retriever.rankExisting(documents, 'synthetic query', undefined, {
      segment(name, durationMs, counts) { events.push({ name, durationMs, counts }); },
    });
    expect(queryCalls).toBe(1);
    expect(ranked.get('doc-1')).toBeCloseTo(1);
    expect(events.map((event) => event.name)).toEqual(['semantic_index_lookup', 'query_embedding', 'vector_compare']);
    expect(events.every((event) => event.durationMs >= 0)).toBe(true);
    expect(events[0].counts).toEqual(expect.objectContaining({ document_count: 1, usable_vectors: 1 }));

    await expect(retriever.rankExisting(documents, 'synthetic query', undefined, {
      segment() { throw new Error('timing sink failed'); },
    })).resolves.toEqual(new Map([['doc-1', 1]]));
  });
});
