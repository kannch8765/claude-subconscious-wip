import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_REMEMBER_TOOL_NAME,
  RelationshipMemoryOwnerControlPlane,
  RelationshipMemoryRecallSession,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  buildRecallTools,
  executeRecall,
  type AssistantRememberIntentRecord,
} from '../src/index.js';
import { RecallMcpServer, RECALL_TOOL } from '../../scripts/recall_mcp.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const LEDGERS = [
  'memories.jsonl', 'evidence.jsonl', 'outcomes.jsonl', 'batches.jsonl',
  'owner-revisions.jsonl', 'assistant-intents.jsonl', 'assistant-intent-outcomes.jsonl',
];
function ledgerSnapshot(root: string): Record<string, string | null> {
  return Object.fromEntries(LEDGERS.map((name) => {
    const file = path.join(root, name);
    return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
  }));
}

function seedRelationshipMemory(root: string): { store: RelationshipMemoryStore; memoryId: string; intent: AssistantRememberIntentRecord } {
  const store = new RelationshipMemoryStore(root, 'subject-1');
  const intent: AssistantRememberIntentRecord = {
    schema_version: 1,
    intent_id: 'intent-feel-1',
    subject_id: 'subject-1',
    session_id: 'session-1',
    assistant_message_id: 'assistant-remember-1',
    tool_use_id: 'tool-remember-1',
    tool_name: ASSISTANT_REMEMBER_TOOL_NAME,
    memory: { text: 'Remember the orange cake inclusion gesture from Kyoto.' },
    feel: { text: 'I felt warmly held in mind and included.' },
    captured_at: '2026-08-04T10:00:00.000Z',
  };
  store.appendAssistantIntent(intent);
  const messages = new Map([['user-evidence-1', {
    conversation_id: 'conversation-1', message_id: 'user-evidence-1', role: 'user' as const,
    quote: 'I brought back the orange cake for you too.', captured_at: '2026-08-04T09:59:00.000Z',
  }]]);
  const runtime = new RelationshipMemoryRuntime(store, messages, () => '2026-08-04T10:01:00.000Z', new Map([[intent.intent_id, intent]]));
  store.beginBatch('batch-1', '2026-08-04T10:00:00.000Z');
  const remembered = runtime.remember('batch-1', {
    schema_version: 1,
    kind: 'shared_experience',
    summary: 'The user explicitly included the assistant when bringing a Kyoto gift home.',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['user-evidence-1'],
    assistant_intent_id: intent.intent_id,
    payload: {
      title: 'Kyoto orange cake inclusion',
      event: 'The user brought home an orange-flavored cake for the assistant too.',
      shared_meaning: 'The assistant was counted among the people the user wanted to bring something home for.',
      recall_triggers: ['Kyoto', 'orange cake'],
    },
  });
  expect(remembered.outcome).toBe('accepted');
  runtime.finalizeBatch('batch-1', true);
  return { store, memoryId: remembered.memory_id!, intent };
}

function writeTranscriptFixture(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'fixture.jsonl');
  const rows = [
    { type: 'user', uuid: 'u-aug4-1', timestamp: '2026-08-04T09:00:00.000Z', message: { content: [{ type: 'text', text: 'Today we worked on the relationship-memory scaffold and direct transcript JSONL source.' }] } },
    { type: 'assistant', uuid: 'a-aug4-1', timestamp: '2026-08-04T09:01:00.000Z', message: { content: [{ type: 'text', text: 'We decided not to depend on CCDK for the relationship-memory runtime.' }, { type: 'thinking', thinking: 'SECRET HIDDEN REASONING' }] } },
    { type: 'system', uuid: 'system-secret', timestamp: '2026-08-04T09:02:00.000Z', content: 'SECRET SYSTEM PROMPT' },
    { type: 'user', uuid: 'u-aug5-1', timestamp: '2026-08-05T09:00:00.000Z', message: { content: [{ type: 'text', text: 'A different day about another project.' }] } },
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

describe('assistant relationship-memory recall core', () => {
  it('searches active canonical memory including linked assistant memory.text and feel.text', () => {
    const root = temp('rm-recall-store-');
    const { store, memoryId } = seedRelationshipMemory(root);
    const recall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject-1', transcriptRoots: [] });
    const found = recall.relationshipMemorySearch({ query: 'warmly held in mind' }) as any;
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toEqual(expect.objectContaining({ memory_id: memoryId, source_ref: expect.stringMatching(/^recall_src_/) }));
    expect(found.results[0].assistant_intents[0]).toEqual(expect.objectContaining({
      memory: 'Remember the orange cake inclusion gesture from Kyoto.',
      feel: 'I felt warmly held in mind and included.',
    }));

    new RelationshipMemoryOwnerControlPlane(store, () => '2026-08-04T11:00:00.000Z').deactivate(memoryId, { revision_id: 'hide-1' });
    const hiddenRecall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject-1', transcriptRoots: [] });
    expect((hiddenRecall.relationshipMemorySearch({ query: 'orange cake' }) as any).results).toHaveLength(0);
  });

  it('supports bounded transcript date search and trusted read-back without exposing hidden/system content', async () => {
    const root = temp('rm-recall-empty-');
    const transcripts = temp('rm-recall-transcripts-');
    writeTranscriptFixture(transcripts);
    const recall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject-1', transcriptRoots: [transcripts] });
    const search = await recall.transcriptSearch({
      time_start: '2026-08-04T00:00:00.000Z',
      time_end: '2026-08-04T23:59:59.999Z',
      limit: 10,
    }) as any;
    expect(search.results.map((item: any) => item.message_id)).toEqual(expect.arrayContaining(['u-aug4-1', 'a-aug4-1']));
    expect(search.results.map((item: any) => item.message_id)).not.toContain('u-aug5-1');
    const hit = search.results.find((item: any) => item.message_id === 'a-aug4-1');
    const read = await recall.transcriptRead({ source_ref: hit.source_ref, before: 1, after: 1 }) as any;
    const serialized = JSON.stringify(read);
    expect(serialized).toContain('relationship-memory scaffold');
    expect(serialized).toContain('not to depend on CCDK');
    expect(serialized).not.toContain('SECRET HIDDEN REASONING');
    expect(serialized).not.toContain('SECRET SYSTEM PROMPT');
    await expect(recall.transcriptRead({ source_ref: 'recall_src_fabricated' })).rejects.toThrow(/trusted source_ref/);
  });

  it('rejects fabricated delivery provenance, wrong recall IDs, and duplicate terminal delivery', () => {
    const root = temp('rm-recall-delivery-');
    seedRelationshipMemory(root);
    const recall = new RelationshipMemoryRecallSession({ recallId: 'recall-fixed', rootDir: root, subjectId: 'subject-1', transcriptRoots: [] });
    const found = recall.relationshipMemorySearch({ query: 'Kyoto' }) as any;
    const sourceRef = found.results[0].source_ref;
    expect(() => recall.deliver({ recall_id: 'other', answer: 'x', source_refs: [sourceRef] })).toThrow(/does not match/);
    expect(() => recall.deliver({ recall_id: 'recall-fixed', answer: 'x', source_refs: ['recall_src_fabricated'] })).toThrow(/fabricated/);
    const delivered = recall.deliver({ recall_id: 'recall-fixed', answer: 'The Kyoto gift made the assistant feel included.', source_refs: [sourceRef] });
    expect(delivered).toEqual(expect.objectContaining({ status: 'ok', source_refs: [sourceRef] }));
    expect(() => recall.deliver({ recall_id: 'recall-fixed', answer: 'again', source_refs: [sourceRef] })).toThrow(/already terminally delivered/);
  });

  it('registers only the constrained recall read tools plus terminal delivery', () => {
    const recall = new RelationshipMemoryRecallSession({ rootDir: temp('rm-recall-tools-'), subjectId: 'subject-1', transcriptRoots: [] });
    expect(buildRecallTools(recall).map((tool) => tool.name)).toEqual([
      'relationship_memory_search', 'transcript_search', 'transcript_read', 'deliver_recall',
    ]);
  });

  it('returns an explicit timeout and rejects a late delivery after the deadline', async () => {
    const root = temp('rm-recall-timeout-');
    seedRelationshipMemory(root);
    let lateRejected = false;
    const result = await executeRecall({
      query: 'What did this mean?', rootDir: root, subjectId: 'subject-1', transcriptRoots: [], timeoutMs: 100,
      async runModel(session) {
        const found = session.relationshipMemorySearch({ query: 'Kyoto' }) as any;
        await new Promise((resolve) => setTimeout(resolve, 150));
        try { session.deliver({ recall_id: session.recallId, answer: 'late', source_refs: [found.results[0].source_ref] }); }
        catch { lateRejected = true; }
      },
    });
    expect(result.status).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lateRejected).toBe(true);
  });

  it('returns an explicit cancellation and rejects late delivery after cancellation', async () => {
    const root = temp('rm-recall-cancel-');
    seedRelationshipMemory(root);
    const controller = new AbortController();
    let lateRejected = false;
    const pending = executeRecall({
      query: 'Cancel this recall', rootDir: root, subjectId: 'subject-1', transcriptRoots: [], timeoutMs: 5_000, signal: controller.signal,
      async runModel(session) {
        const found = session.relationshipMemorySearch({ query: 'Kyoto' }) as any;
        await new Promise((resolve) => setTimeout(resolve, 80));
        try { session.deliver({ recall_id: session.recallId, answer: 'late', source_refs: [found.results[0].source_ref] }); }
        catch { lateRejected = true; }
      },
    });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lateRejected).toBe(true);
  });

  it('never changes relationship-memory ledgers during search/read/delivery or transport failure', async () => {
    const root = temp('rm-recall-readonly-');
    seedRelationshipMemory(root);
    const transcripts = temp('rm-recall-readonly-transcripts-');
    writeTranscriptFixture(transcripts);
    const before = ledgerSnapshot(root);
    const recall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject-1', transcriptRoots: [transcripts] });
    const memory = recall.relationshipMemorySearch({ query: 'held in mind' }) as any;
    const transcript = await recall.transcriptSearch({ query: 'CCDK' }) as any;
    const read = await recall.transcriptRead({ source_ref: transcript.results[0].source_ref });
    recall.deliver({ recall_id: recall.recallId, answer: 'done', source_refs: [memory.results[0].source_ref, read.source_ref] });
    expect(ledgerSnapshot(root)).toEqual(before);

    const failed = await executeRecall({
      query: 'network failure', rootDir: root, subjectId: 'subject-1', transcriptRoots: [transcripts],
      async runModel() { throw new Error('Letta unavailable'); },
    });
    expect(failed.status).toBe('failed');
    expect(failed.reason).toContain('Letta unavailable');
    expect(ledgerSnapshot(root)).toEqual(before);
  });
});

describe('Kohaku-facing recall MCP contract', () => {
  it('discovers a single narrow recall({query}) tool while preserving the separate remember MCP entry', async () => {
    const server = new RecallMcpServer(async () => ({ status: 'failed', recall_id: 'unused' }));
    const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any;
    expect(listed.result.tools).toEqual([RECALL_TOOL]);
    expect(RECALL_TOOL.inputSchema).toEqual(expect.objectContaining({ required: ['query'], additionalProperties: false }));
    const mcp = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mcp.json'), 'utf8'));
    expect(mcp['relationship-memory-intent'].args.at(-1)).toContain('remember_intent_mcp.ts');
    expect(mcp['relationship-memory-recall'].args.at(-1)).toContain('recall_mcp.ts');
    expect(ASSISTANT_REMEMBER_TOOL_NAME).toBe('mcp__plugin_claude-subconscious_relationship-memory-intent__remember');
  });

  it('keeps tools/call pending until terminal recall delivery is available', async () => {
    const server = new RecallMcpServer(async (query) => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { status: 'ok', recall_id: 'recall-mcp-1', answer: `remembered: ${query}`, source_refs: [], sources: [] };
    });
    const started = Date.now();
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: 'What happened?' } } }) as any;
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(response.result.content[0].text).toBe('remembered: What happened?');
    expect(response.result.structuredContent).toEqual(expect.objectContaining({ status: 'ok', recall_id: 'recall-mcp-1' }));
  });

  it('surfaces model transport failure as one explicit tool result', async () => {
    const server = new RecallMcpServer(async () => ({ status: 'failed', recall_id: 'recall-fail', reason: 'Letta unavailable' }));
    const response = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: 'find memory' } } }) as any;
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Letta unavailable');
  });
});
