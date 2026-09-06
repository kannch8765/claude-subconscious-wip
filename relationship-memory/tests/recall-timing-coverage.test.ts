import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';
import {
  ASSISTANT_REMEMBER_TOOL_NAME,
  FileBackedSemanticRetriever,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  buildRecallTools,
  executeRecall,
  type AssistantRememberIntentRecord,
} from '../src/index.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING;
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE;
});

function seedSyntheticMemory(root: string): void {
  const store = new RelationshipMemoryStore(root, 'subject-1');
  const intent: AssistantRememberIntentRecord = {
    schema_version: 1,
    intent_id: 'task16-intent-1',
    subject_id: 'subject-1',
    session_id: 'task16-session-1',
    assistant_message_id: 'task16-assistant-1',
    tool_use_id: 'task16-tool-1',
    tool_name: ASSISTANT_REMEMBER_TOOL_NAME,
    memory: { text: 'TASK16_MEMORY_SENTINEL' },
    feel: { text: 'TASK16_FEEL_SENTINEL' },
    captured_at: '2026-08-04T10:00:00.000Z',
  };
  store.appendAssistantIntent(intent);
  const messages = new Map([['task16-evidence-1', {
    conversation_id: 'task16-conversation-1',
    message_id: 'task16-evidence-1',
    role: 'user' as const,
    quote: 'TASK16_EVIDENCE_SENTINEL',
    captured_at: '2026-08-04T09:59:00.000Z',
  }]]);
  const runtime = new RelationshipMemoryRuntime(
    store,
    messages,
    () => '2026-08-04T10:01:00.000Z',
    new Map([[intent.intent_id, intent]]),
  );
  store.beginBatch('task16-batch-1', '2026-08-04T10:00:00.000Z');
  const remembered = runtime.remember('task16-batch-1', {
    schema_version: 1,
    kind: 'shared_experience',
    summary: 'TASK16_MEMORY_SUMMARY_SENTINEL',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['task16-evidence-1'],
    assistant_intent_id: intent.intent_id,
    payload: {
      title: 'Task 16 synthetic timing memory',
      event: 'TASK16_MEMORY_EVENT_SENTINEL',
      shared_meaning: 'Synthetic only.',
      recall_triggers: ['task16', 'coverage'],
    },
  });
  expect(remembered.outcome).toBe('accepted');
  runtime.finalizeBatch('task16-batch-1', true);
}

it('records segmented timing for repeated buildRecallTools calls without logging user content', async () => {
  const root = temp('rm-task16-store-');
  seedSyntheticMemory(root);
  const transcripts = temp('rm-task16-transcripts-');
  fs.writeFileSync(path.join(transcripts, 'sample.jsonl'), [
    JSON.stringify({ type: 'user', uuid: 'task16-u1', timestamp: '2026-08-04T09:00:00.000Z', message: { content: [{ type: 'text', text: 'TASK16_TRANSCRIPT_SENTINEL task16 coverage' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'task16-a1', timestamp: '2026-08-04T09:01:00.000Z', message: { content: [{ type: 'text', text: 'Synthetic response for task16 coverage.' }] } }),
  ].join('\n') + '\n');

  const retriever = new FileBackedSemanticRetriever({
    fingerprint: 'task16-coverage-fingerprint',
    model: 'task16-coverage-model',
    dimensions: 3,
    maxBatchSize: 16,
    async embedDocuments(texts: string[]) { return texts.map((_, index) => [index + 1, index + 2, index + 3]); },
    async embedQuery() { return [1, 2, 3]; },
  }, path.join(temp('rm-task16-index-'), 'index.json'));

  const timingFile = path.join(temp('rm-task16-output-'), 'timing.jsonl');
  process.env.RELATIONSHIP_MEMORY_RECALL_TIMING = '1';
  process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE = timingFile;

  const result = await executeRecall({
    query: 'TASK16_QUERY_SENTINEL',
    rootDir: root,
    subjectId: 'subject-1',
    transcriptRoots: [transcripts],
    semanticRetriever: retriever,
    recallId: 'recall-task16-multiround',
    async runModel(session) {
      const tools = new Map(buildRecallTools(session).map((tool) => [tool.name, tool]));
      const relationship = tools.get('relationship_memory_search')!;
      const transcriptSearch = tools.get('transcript_search')!;
      const transcriptRead = tools.get('transcript_read')!;

      await relationship.execute('task16-call-rel-1', { query: 'task16 coverage' });
      await relationship.execute('task16-call-rel-2', { query: 'task16 coverage' });
      const transcript = await transcriptSearch.execute('task16-call-transcript-search', { query: 'task16 coverage' }) as { results: Array<{ source_ref: string }> };
      expect(transcript.results.length).toBeGreaterThan(0);
      await transcriptRead.execute('task16-call-transcript-read', {
        source_ref: transcript.results[0].source_ref,
        before: 1,
        after: 1,
      });
      session.deliver({ recall_id: session.recallId, answer: 'synthetic task16 complete', source_refs: [] });
    },
  });
  expect(result.status).toBe('ok');

  const output = fs.readFileSync(timingFile, 'utf8');
  const events = output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  console.log(`TASK16_MULTIROUND_TIMING_EVENTS ${JSON.stringify(events)}`);

  const toolEvents = events.filter((event) => event.phase === 'tool_call');
  const seen = new Set(toolEvents.map((event) => `${event.tool_name}:${event.segment}`));
  expect(seen).toContain('relationship_memory_search:relationship_candidate_set_construction');
  expect(seen).toContain('relationship_memory_search:relationship_lexical_scoring');
  expect(seen).toContain('relationship_memory_search:semantic_query_embedding_external');
  expect(seen).toContain('relationship_memory_search:semantic_local_vector_comparison');
  expect(seen).toContain('relationship_memory_search:relationship_local_vector_sorting');
  expect(seen).toContain('transcript_search:transcript_search_total');
  expect(seen).toContain('transcript_read:transcript_read_window');

  const relationshipCalls = new Set(
    toolEvents
      .filter((event) => event.tool_name === 'relationship_memory_search')
      .map((event) => event.tool_call_index),
  );
  expect(relationshipCalls.size).toBe(2);

  expect(output).not.toContain('TASK16_QUERY_SENTINEL');
  expect(output).not.toContain('TASK16_MEMORY_SENTINEL');
  expect(output).not.toContain('TASK16_FEEL_SENTINEL');
  expect(output).not.toContain('TASK16_EVIDENCE_SENTINEL');
  expect(output).not.toContain('TASK16_MEMORY_SUMMARY_SENTINEL');
  expect(output).not.toContain('TASK16_MEMORY_EVENT_SENTINEL');
  expect(output).not.toContain('TASK16_TRANSCRIPT_SENTINEL');
});