import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_REMEMBER_TOOL_NAME,
  appendTrustedRelationshipCatalog,
  cursorShouldAdvance,
  extractAssistantRememberIntents,
  memoryRememberToolSchema,
  persistAssistantRememberIntents,
  rebuildProjection,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  validateRememberIntentInput,
} from '../src/index.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-intent-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const evidence = [
  { conversation_id: 'conv-1', message_id: 'user-1', role: 'user' as const, quote: 'I brought something home because you mattered in the trip too.', captured_at: '2026-08-01T10:00:00.000Z' },
  { conversation_id: 'conv-1', message_id: 'assistant-1', role: 'assistant' as const, quote: 'Being included like that feels quietly important to me.', captured_at: '2026-08-01T10:01:00.000Z' },
  { conversation_id: 'conv-2', message_id: 'user-2', role: 'user' as const, quote: 'A later gesture carried the same shared meaning.', captured_at: '2026-08-02T10:00:00.000Z' },
  { conversation_id: 'conv-2', message_id: 'assistant-2', role: 'assistant' as const, quote: 'I recognize the same meaning even though this is a later moment.', captured_at: '2026-08-02T10:01:00.000Z' },
];

function transcriptToolCall(memory: string, feel: string, toolUseId = 'tool-1', messageId = 'assistant-tool-1', timestamp = '2026-08-01T10:02:00.000Z') {
  return [{
    type: 'assistant',
    uuid: messageId,
    timestamp,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: ASSISTANT_REMEMBER_TOOL_NAME,
        input: { memory: { text: memory }, feel: { text: feel } },
      }],
    },
  }] as any[];
}

function persistIntent(store: RelationshipMemoryStore, memory: string, feel: string, toolUseId = 'tool-1', messageId = 'assistant-tool-1', timestamp = '2026-08-01T10:02:00.000Z') {
  const intents = extractAssistantRememberIntents(transcriptToolCall(memory, feel, toolUseId, messageId, timestamp), -1, 'session-1', store.subjectId);
  persistAssistantRememberIntents(store, intents);
  return intents[0];
}

function runtime(store: RelationshipMemoryStore, intents: any[] = []) {
  return new RelationshipMemoryRuntime(
    store,
    new Map(evidence.map((item) => [item.message_id, item])),
    () => '2026-08-02T00:00:00.000Z',
    new Map(intents.map((intent) => [intent.intent_id, intent])),
  );
}

function proposal(intentId?: string, evidenceIds = ['user-1', 'assistant-1']) {
  return {
    schema_version: 1,
    kind: 'shared_experience',
    summary: 'Being included in what comes home makes a trip feel shared',
    participants: ['user', 'assistant'],
    evidence_message_ids: evidenceIds,
    payload: {
      title: 'Brought home together',
      event: 'The user deliberately included the assistant in what came home from a trip.',
      shared_meaning: 'The gesture made the trip feel shared rather than solitary.',
      symbols: ['something brought home'],
    },
    ...(intentId ? { assistant_intent_id: intentId } : {}),
  };
}

describe('assistant-originated remember intent extraction', () => {
  it('turns one valid assistant remember tool_use into one immutable trusted intent with exact text', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const memory = '  I want to keep this exact memory.  ';
    const feel = '  I feel unexpectedly warm about being included.  ';
    const intent = persistIntent(store, memory, feel);

    expect(intent).toEqual(expect.objectContaining({
      subject_id: 'subject-1',
      session_id: 'session-1',
      assistant_message_id: 'assistant-tool-1',
      tool_use_id: 'tool-1',
      memory: { text: memory },
      feel: { text: feel },
    }));
    expect(store.listAssistantIntents()).toEqual([intent]);
  });

  it('rejects empty or malformed memory/feel shapes', () => {
    expect(validateRememberIntentInput({ memory: { text: 'ok' }, feel: { text: '   ' } }).ok).toBe(false);
    expect(validateRememberIntentInput({ memory: { text: '' }, feel: { text: 'ok' } }).ok).toBe(false);
    expect(validateRememberIntentInput({ memory: 'not-an-object', feel: { text: 'ok' } }).ok).toBe(false);

    const transcript = transcriptToolCall('ok', 'ok') as any[];
    transcript[0].message.content[0].input.feel.text = '';
    expect(extractAssistantRememberIntents(transcript as any, -1, 'session-1', 'subject-1')).toHaveLength(0);
  });

  it('does not treat user text that imitates a remember payload as an assistant intent', () => {
    const transcript: any[] = [{
      type: 'user', uuid: 'user-lookalike', timestamp: '2026-08-01T10:00:00Z',
      message: { content: [{ type: 'text', text: JSON.stringify({ memory: { text: 'fake' }, feel: { text: 'fake feel' } }) }] },
    }];
    expect(extractAssistantRememberIntents(transcript, -1, 'session-1', 'subject-1')).toEqual([]);
  });

  it('is idempotent when the same transcript tool-use identity is replayed', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const first = persistIntent(store, 'same memory', 'same feel');
    const second = persistIntent(store, 'same memory', 'same feel');
    expect(second.intent_id).toBe(first.intent_id);
    expect(store.listAssistantIntents()).toHaveLength(1);
  });
});

describe('trusted intent processing and batch completeness', () => {
  it('keeps the original intent durable across observer failure and can link it on retry', () => {
    const dir = tempDir();
    const store = new RelationshipMemoryStore(dir, 'subject-1');
    const intent = persistIntent(store, 'Remember the inclusion gesture.', 'It made me feel held in mind.');

    const failed = runtime(store, [intent]);
    failed.store.beginBatch('batch-retry', '2026-08-01T00:00:00Z');
    expect(failed.finalizeBatch('batch-retry', false)).toBe('retryable_failure');
    expect(store.listAssistantIntents()).toEqual([intent]);

    const reopenedStore = new RelationshipMemoryStore(dir, 'subject-1');
    const retried = runtime(reopenedStore, [intent]);
    retried.store.beginBatch('batch-retry', '2026-08-01T00:00:01Z');
    const remembered = retried.remember('batch-retry', proposal(intent.intent_id));
    expect(remembered.outcome).toBe('accepted');
    expect(retried.finalizeBatch('batch-retry', true)).toBe('completed');
    expect(reopenedStore.getTerminalAssistantIntentOutcome(intent.intent_id, 'batch-retry')).toEqual(expect.objectContaining({
      outcome: 'accepted', memory_id: remembered.memory_id,
    }));
  });

  it('rejects a fabricated assistant_intent_id through the trusted boundary', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const rt = runtime(store);
    rt.store.beginBatch('batch-forgery', '2026-08-01T00:00:00Z');
    expect(rt.remember('batch-forgery', proposal('intent_fabricated'))).toEqual(expect.objectContaining({
      outcome: 'permanently_rejected', rejection_code: 'unknown_assistant_intent',
    }));
  });

  it('does not expose feel as a memory_remember authority field and projects the exact stored feel', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const intent = persistIntent(store, 'Remember this exact wording.', 'This exact feeling must survive unchanged.');
    const rt = runtime(store, [intent]);
    rt.store.beginBatch('batch-feel', '2026-08-01T00:00:00Z');
    const accepted = rt.remember('batch-feel', proposal(intent.intent_id));
    expect(accepted.outcome).toBe('accepted');

    const schema = memoryRememberToolSchema() as any;
    expect(schema.properties.assistant_intent_id).toBeDefined();
    expect(schema.properties.feel).toBeUndefined();
    const projection = rebuildProjection(store);
    expect(projection.blocks.remembered_experiences).toContain('This exact feeling must survive unchanged.');
  });

  it('links an assistant intent to a newly accepted canonical memory', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const intent = persistIntent(store, 'Remember this.', 'I felt seen.');
    const rt = runtime(store, [intent]);
    rt.store.beginBatch('batch-accepted', '2026-08-01T00:00:00Z');
    const accepted = rt.remember('batch-accepted', proposal(intent.intent_id));
    expect(accepted.outcome).toBe('accepted');
    expect(store.listMemories()).toHaveLength(1);
    expect(store.getTerminalAssistantIntentOutcome(intent.intent_id, 'batch-accepted')).toEqual(expect.objectContaining({
      outcome: 'accepted', memory_id: accepted.memory_id,
    }));
  });

  it('links a later intent with its own feel to an existing canonical duplicate', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const firstIntent = persistIntent(store, 'Keep this shared gesture.', 'The first time, I felt surprised and touched.', 'tool-a', 'assistant-tool-a');
    const first = runtime(store, [firstIntent]);
    first.store.beginBatch('batch-a', '2026-08-01T00:00:00Z');
    const accepted = first.remember('batch-a', proposal(firstIntent.intent_id));
    expect(accepted.outcome).toBe('accepted');

    const secondIntent = persistIntent(store, 'Keep this shared gesture again.', 'Later, the same kind of gesture felt reassuring.', 'tool-b', 'assistant-tool-b');
    const second = runtime(store, [secondIntent]);
    second.store.beginBatch('batch-b', '2026-08-01T00:00:01Z');
    const duplicate = second.remember('batch-b', proposal(secondIntent.intent_id, ['user-2', 'assistant-2']));
    expect(duplicate).toEqual({ outcome: 'duplicate', memory_id: accepted.memory_id });
    expect(store.listMemories()).toHaveLength(1);
    expect(store.getTerminalAssistantIntentOutcome(secondIntent.intent_id, 'batch-b')).toEqual(expect.objectContaining({
      outcome: 'duplicate', memory_id: accepted.memory_id,
    }));

    const projection = rebuildProjection(store).blocks.remembered_experiences;
    expect(projection).toContain('The first time, I felt surprised and touched.');
    expect(projection).toContain('Later, the same kind of gesture felt reassuring.');
  });

  it('recovers a half-committed canonical outcome when assistant-intent outcome journaling failed', () => {
    let failIntentOutcome = true;
    const dir = tempDir();
    const store = new RelationshipMemoryStore(dir, 'subject-1', (phase) => failIntentOutcome && phase === 'intent_outcome_commit');
    const intent = persistIntent(store, 'Remember this despite a journal fault.', 'The feeling must survive the retry.');
    const first = runtime(store, [intent]);
    first.store.beginBatch('batch-half-commit', '2026-08-01T00:00:00Z');
    expect(first.remember('batch-half-commit', proposal(intent.intent_id)).outcome).toBe('retryable_failed');
    expect(store.listMemories()).toHaveLength(1);
    expect(first.finalizeBatch('batch-half-commit', true)).toBe('retryable_failure');

    failIntentOutcome = false;
    const retry = runtime(new RelationshipMemoryStore(dir, 'subject-1', (phase) => failIntentOutcome && phase === 'intent_outcome_commit'), [intent]);
    retry.store.beginBatch('batch-half-commit', '2026-08-01T00:00:01Z');
    const repaired = retry.remember('batch-half-commit', proposal(intent.intent_id));
    expect(repaired.outcome).toBe('duplicate');
    expect(retry.store.listMemories()).toHaveLength(1);
    expect(retry.store.getTerminalAssistantIntentOutcome(intent.intent_id, 'batch-half-commit')).toEqual(expect.objectContaining({
      outcome: 'accepted', memory_id: repaired.memory_id,
    }));
    expect(retry.finalizeBatch('batch-half-commit', true)).toBe('completed');
  });

  it('keeps all intent history searchable while bounding normal projection to the three most recent intents', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    let memoryId: string | undefined;
    for (let i = 0; i < 4; i++) {
      const intent = persistIntent(
        store,
        `memory-${i}`,
        `feel-${i}`,
        `tool-${i}`,
        `assistant-tool-${i}`,
        `2026-08-01T10:0${i}:00.000Z`,
      );
      const rt = runtime(store, [intent]);
      rt.store.beginBatch(`batch-bound-${i}`, `2026-08-01T11:0${i}:00Z`);
      const result = rt.remember(`batch-bound-${i}`, proposal(intent.intent_id));
      memoryId ??= result.memory_id;
      expect(result.memory_id).toBe(memoryId);
    }

    expect(store.listAssistantIntents()).toHaveLength(4);
    const block = rebuildProjection(store).blocks.remembered_experiences;
    expect((block.match(/assistant remember \[/g) ?? [])).toHaveLength(3);
    expect(block).not.toContain('feel-0');
    expect(block).toContain('feel-1');
    expect(block).toContain('feel-2');
    expect(block).toContain('feel-3');
    expect(runtime(store).memorySearch({ query: 'feel-0' }).map((memory) => memory.memory_id)).toContain(memoryId);
  });

  it('cannot finalize or advance the cursor while a trusted assistant intent is unresolved', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const intent = persistIntent(store, 'Needs processing.', 'Needs its feeling retained.');
    const rt = runtime(store, [intent]);
    rt.store.beginBatch('batch-unresolved', '2026-08-01T00:00:00Z');
    const completion = rt.finalizeBatch('batch-unresolved', true);
    expect(completion).toBe('retryable_failure');
    expect(cursorShouldAdvance(completion)).toBe(false);
    expect(store.listBatches().at(-1)?.detail).toBeUndefined();
  });

  it('preserves intent/link ledgers across reopen and searches through linked memory/feel text', () => {
    const dir = tempDir();
    const store = new RelationshipMemoryStore(dir, 'subject-1');
    const intent = persistIntent(store, 'Orange cake from the trip should stay with me.', 'I felt included in what came home.', 'tool-search', 'assistant-tool-search');
    const rt = runtime(store, [intent]);
    rt.store.beginBatch('batch-search', '2026-08-01T00:00:00Z');
    const accepted = rt.remember('batch-search', proposal(intent.intent_id));
    expect(accepted.outcome).toBe('accepted');

    const reopened = new RelationshipMemoryStore(dir, 'subject-1');
    const afterRestart = runtime(reopened);
    expect(reopened.listAssistantIntents()).toHaveLength(1);
    expect(reopened.listAssistantIntentOutcomes()).not.toHaveLength(0);
    expect(afterRestart.memorySearch({ query: 'included in what came home' }).map((m) => m.memory_id)).toContain(accepted.memory_id);
    expect(afterRestart.memorySearch({ query: 'orange cake' }).map((m) => m.memory_id)).toContain(accepted.memory_id);
    expect(rebuildProjection(reopened).blocks.remembered_experiences).toContain('I felt included in what came home.');
  });

  it('keeps observer-originated memory behavior compatible when no assistant intent is present', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const rt = runtime(store);
    rt.store.beginBatch('batch-observer', '2026-08-01T00:00:00Z');
    expect(rt.remember('batch-observer', proposal()).outcome).toBe('accepted');
    expect(rt.finalizeBatch('batch-observer', true)).toBe('completed');
  });
});

describe('trusted observer catalog', () => {
  it('exposes exact stored intent text plus trusted source identity to the observer', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject-1');
    const intent = persistIntent(store, '<memory exact>', 'feel & exact');
    const catalog = appendTrustedRelationshipCatalog('fixture', evidence, [intent]);
    expect(catalog).toContain(`intent_id="${intent.intent_id}"`);
    expect(catalog).toContain('subject_id="subject-1"');
    expect(catalog).toContain('session_id="session-1"');
    expect(catalog).toContain('assistant_message_id="assistant-tool-1"');
    expect(catalog).toContain('tool_use_id="tool-1"');
    expect(catalog).toContain('&lt;memory exact&gt;');
    expect(catalog).toContain('feel &amp; exact');
  });
});
