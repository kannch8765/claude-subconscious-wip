import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';
import {
  ASSISTANT_REMEMBER_TOOL_NAME,
  FileBackedSemanticRetriever,
  RelationshipMemoryRecallSession,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
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
    intent_id: 'sample-intent-1',
    subject_id: 'subject-1',
    session_id: 'sample-session-1',
    assistant_message_id: 'sample-assistant-1',
    tool_use_id: 'sample-tool-1',
    tool_name: ASSISTANT_REMEMBER_TOOL_NAME,
    memory: { text: 'Synthetic sample memory provenance.' },
    feel: { text: 'Synthetic sample feeling provenance.' },
    captured_at: '2026-08-04T10:00:00.000Z',
  };
  store.appendAssistantIntent(intent);
  const messages = new Map([['sample-evidence-1', {
    conversation_id: 'sample-conversation-1',
    message_id: 'sample-evidence-1',
    role: 'user' as const,
    quote: 'Synthetic orange cake evidence.',
    captured_at: '2026-08-04T09:59:00.000Z',
  }]]);
  const runtime = new RelationshipMemoryRuntime(store, messages, () => '2026-08-04T10:01:00.000Z', new Map([[intent.intent_id, intent]]));
  store.beginBatch('sample-batch-1', '2026-08-04T10:00:00.000Z');
  const remembered = runtime.remember('sample-batch-1', {
    schema_version: 1,
    kind: 'shared_experience',
    summary: 'Synthetic Kyoto orange cake memory for offline timing.',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['sample-evidence-1'],
    assistant_intent_id: intent.intent_id,
    payload: {
      title: 'Synthetic timing memory',
      event: 'Synthetic event for timing instrumentation.',
      shared_meaning: 'Synthetic meaning only.',
      recall_triggers: ['Kyoto', 'orange cake'],
    },
  });
  expect(remembered.outcome).toBe('accepted');
  runtime.finalizeBatch('sample-batch-1', true);
}

it('prints a real synthetic explicit-recall timing sample for Task 15', async () => {
  const root = temp('rm-task15-sample-store-');
  seedSyntheticMemory(root);
  const transcripts = temp('rm-task15-sample-transcripts-');
  fs.writeFileSync(path.join(transcripts, 'sample.jsonl'), [
    JSON.stringify({ type: 'user', uuid: 'sample-u1', timestamp: '2026-08-04T09:00:00.000Z', message: { content: [{ type: 'text', text: 'Synthetic Kyoto orange cake transcript.' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'sample-a1', timestamp: '2026-08-04T09:01:00.000Z', message: { content: [{ type: 'text', text: 'Synthetic response about the orange cake.' }] } }),
  ].join('\n') + '\n');

  const retriever = new FileBackedSemanticRetriever({
    fingerprint: 'task15-sample-fingerprint',
    model: 'task15-sample-model',
    dimensions: 3,
    maxBatchSize: 16,
    async embedDocuments(texts: string[]) { return texts.map((_, index) => [index + 1, index + 2, index + 3]); },
    async embedQuery() { return [1, 2, 3]; },
  }, path.join(temp('rm-task15-sample-index-'), 'index.json'));

  const warmup = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject-1', transcriptRoots: [transcripts], semanticRetriever: retriever });
  await warmup.relationshipMemorySearchHybrid({ query: 'Kyoto orange cake' });

  const timingFile = path.join(temp('rm-task15-sample-output-'), 'timing.jsonl');
  process.env.RELATIONSHIP_MEMORY_RECALL_TIMING = '1';
  process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE = timingFile;

  const result = await executeRecall({
    query: 'Kyoto orange cake',
    rootDir: root,
    subjectId: 'subject-1',
    transcriptRoots: [transcripts],
    semanticRetriever: retriever,
    recallId: 'recall-task15-offline-sample',
    async runModel(session) {
      const initial = await session.evidenceBundle({ query: 'Kyoto orange cake' });
      await session.expandEvidenceBundle({ query: 'orange cake Kyoto' });
      session.deliver({ recall_id: session.recallId, answer: 'synthetic timing sample complete', source_refs: initial.source_refs.slice(0, 1) });
    },
  });
  expect(result.status).toBe('ok');

  const events = fs.readFileSync(timingFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) console.log(`TASK15_TIMING_SAMPLE ${JSON.stringify(event)}`);
});
