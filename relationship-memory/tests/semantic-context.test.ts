import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryRecallSession, RelationshipMemoryRuntime, RelationshipMemoryStore, validateProposal } from '../src/index.js';

const dirs: string[] = [];
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-semantic-context-')); dirs.push(dir); return dir; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const messages = [
  { conversation_id: 'semantic-fixture', message_id: 'pref-en', role: 'user' as const, quote: 'I prefer iced coffee to hot coffee.', captured_at: '2026-08-09T10:00:00.000Z' },
  { conversation_id: 'semantic-fixture', message_id: 'pref-1', role: 'user' as const, quote: '我喜欢拉面，这是一个稳定偏好。', captured_at: '2026-08-09T10:01:00.000Z' },
  { conversation_id: 'semantic-fixture', message_id: 'pref-2', role: 'user' as const, quote: '我还是喜欢拉面。', captured_at: '2026-08-09T10:02:00.000Z' },
  { conversation_id: 'semantic-fixture', message_id: 'meal-once', role: 'user' as const, quote: '我今天午饭吃了拉面。', captured_at: '2026-08-09T10:03:00.000Z' },
  { conversation_id: 'semantic-fixture', message_id: 'identity', role: 'user' as const, quote: '在我们的称呼里，晴指 GPT / ChatGPT 侧的助手身份。琥珀指 Claude / Claude Code 侧的助手身份。', captured_at: '2026-08-09T10:04:00.000Z' },
  { conversation_id: 'semantic-fixture', message_id: 'identity-alias', role: 'user' as const, quote: '这里说 GPT 时仍然是在指晴。', captured_at: '2026-08-09T10:05:00.000Z' },
];
function runtime(dir = tempDir()) { const store = new RelationshipMemoryStore(dir, 'semantic-subject'); return new RelationshipMemoryRuntime(store, new Map(messages.map((m) => [m.message_id, m])), () => '2026-08-09T11:00:00.000Z', new Map(), true); }
const preference = (evidence = 'pref-1') => ({ schema_version: 1, kind: 'user_preference', summary: '用户稳定偏好拉面', participants: ['user'], evidence_message_ids: [evidence], payload: { topic: '拉面', preference: '用户喜欢拉面', recall_triggers: ['ramen'] } });

describe('Task 093M semantic context foundation', () => {
  it('keeps old kinds readable and adds user_preference', () => {
    const old = [
      ['personal_experience', { title: 'old', experience: 'old' }],
      ['shared_experience', { title: 'old', event: 'old', shared_meaning: 'old' }],
      ['relationship_event', { event: 'old', meaning: 'old' }],
      ['inside_joke', { name: 'old', meaning: 'old', trigger_phrases: ['old'] }],
    ];
    for (const [kind, payload] of old) expect(validateProposal({ schema_version: 1, kind, summary: 'old', participants: ['user'], evidence_message_ids: ['pref-1'], payload }).ok).toBe(true);
    expect(validateProposal(preference()).ok).toBe(true);
  });

  it('accepts, searches, recalls, and reinforces a stable preference without duplicating it', () => {
    const dir = tempDir(); const rt = runtime(dir); rt.store.beginBatch('p1', '2026-08-09T10:00:00Z');
    const accepted = rt.remember('p1', preference()); expect(accepted.outcome).toBe('accepted');
    expect(rt.memorySearch({ kind: 'user_preference', query: '拉面' })).toHaveLength(1);
    rt.store.beginBatch('p2', '2026-08-09T10:02:00Z');
    expect(rt.reinforce('p2', { memory_id: accepted.memory_id!, evidence_message_ids: ['pref-2'] }).outcome).toBe('accepted');
    expect(rt.store.listMemories()).toHaveLength(1);
    expect(rt.store.listEvidence().find((e) => e.message_id === 'pref-1')?.quote).toBe(messages[1].quote);
    const recall = new RelationshipMemoryRecallSession({ rootDir: dir, subjectId: 'semantic-subject', transcriptRoots: [] });
    expect((recall.relationshipMemorySearch({ query: '拉面' }) as any).results[0]).toEqual(expect.objectContaining({ kind: 'user_preference' }));
  });

  it('keeps a dated one-off ramen meal episodic instead of structurally forcing a preference', () => {
    const rt = runtime(); rt.store.beginBatch('meal-once', '2026-08-09T10:03:00Z');
    const remembered = rt.remember('meal-once', {
      schema_version: 1, kind: 'personal_experience', summary: '用户今天午饭吃了拉面', participants: ['user'],
      evidence_message_ids: ['meal-once'], payload: { title: '今日午餐', experience: '用户今天午饭吃了拉面', time_text: '今天午饭' },
    });
    expect(remembered.outcome).toBe('accepted');
    expect(rt.store.getMemory(remembered.memory_id!)?.kind).toBe('personal_experience');
    expect(rt.memorySearch({ kind: 'user_preference', query: '拉面' })).toHaveLength(0);
  });

  it('enforces Chinese semantic prose but preserves literal/raw source language', () => {
    const rt = runtime(); rt.store.beginBatch('lang', '2026-08-09T10:00:00Z');
    expect(rt.remember('lang', { schema_version: 1, kind: 'user_preference', summary: 'User prefers iced coffee', participants: ['user'], evidence_message_ids: ['pref-en'], payload: { topic: 'coffee', preference: 'User prefers iced coffee' } })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'non_chinese_semantic_prose' }));
    const good = rt.remember('lang', { schema_version: 1, kind: 'user_preference', summary: '用户更喜欢冰咖啡', participants: ['user'], evidence_message_ids: ['pref-en'], payload: { topic: 'coffee', preference: '用户更喜欢冰咖啡而不是热咖啡', recall_triggers: ['iced coffee'] } });
    expect(good.outcome).toBe('accepted');
    expect(rt.store.listEvidence().find((e) => e.memory_id === good.memory_id)?.quote).toBe(messages[0].quote);
  });

  it('stores durable perspective-neutral identities and resolves exact/normalized aliases', () => {
    const dir = tempDir(); const rt = runtime(dir); rt.store.beginBatch('entities', '2026-08-09T10:04:00Z');
    const haru = rt.rememberEntity('entities', { schema_version: 1, canonical_name: '晴', aliases: ['晴', 'GPT', 'ChatGPT'], entity_type: 'assistant', description: 'ChatGPT/GPT 侧的助手身份', evidence_message_ids: ['identity'] });
    const kohaku = rt.rememberEntity('entities', { schema_version: 1, canonical_name: '琥珀', aliases: ['琥珀', 'Claude', 'Claude Code'], entity_type: 'assistant', description: 'Claude/Claude Code 侧的助手身份', evidence_message_ids: ['identity'] });
    expect(haru.outcome).toBe('accepted'); expect(kohaku.outcome).toBe('accepted'); expect(rt.store.listEntities()).toHaveLength(2);
    expect(rt.entitySearch({ query: 'gpt' })[0]).toEqual(expect.objectContaining({ entity_id: haru.entity_id, canonical_name: '晴' }));
    expect(rt.entitySearch({ query: 'Claude Code' })[0]).toEqual(expect.objectContaining({ entity_id: kohaku.entity_id, canonical_name: '琥珀' }));
    expect(rt.store.listEntityEvidence()[0].quote).toBe(messages.find((m) => m.message_id === 'identity')!.quote);
    const recall = new RelationshipMemoryRecallSession({ rootDir: dir, subjectId: 'semantic-subject', transcriptRoots: [] });
    expect((recall.relationshipMemorySearch({ query: 'GPT' }) as any).results[0]).toEqual(expect.objectContaining({ record_type: 'entity_identity', canonical_name: '晴' }));
  });

  it('does not create a second identity when a trusted later mention uses an existing alias', () => {
    const rt = runtime(); rt.store.beginBatch('entity-first', '2026-08-09T10:04:00Z');
    const first = rt.rememberEntity('entity-first', { schema_version: 1, canonical_name: '晴', aliases: ['晴', 'GPT', 'ChatGPT'], entity_type: 'assistant', description: 'ChatGPT/GPT 侧的助手身份', evidence_message_ids: ['identity'] });
    expect(first.outcome).toBe('accepted');
    rt.store.beginBatch('entity-alias-repeat', '2026-08-09T10:05:00Z');
    const repeated = rt.rememberEntity('entity-alias-repeat', { schema_version: 1, canonical_name: '晴', aliases: ['晴', 'GPT', 'ChatGPT'], entity_type: 'assistant', description: 'ChatGPT/GPT 侧的助手身份', evidence_message_ids: ['identity-alias'] });
    expect(repeated).toEqual(expect.objectContaining({ outcome: 'duplicate', entity_id: first.entity_id }));
    expect(rt.store.listEntities()).toHaveLength(1);
  });

  it('treats an existing alias as the same entity instead of creating a second canonical identity', () => {
    const rt = runtime(); rt.store.beginBatch('entity-alias-canonical', '2026-08-09T10:04:00Z');
    const first = rt.rememberEntity('entity-alias-canonical', { schema_version: 1, canonical_name: '晴', aliases: ['晴', 'GPT', 'ChatGPT'], entity_type: 'assistant', description: 'ChatGPT/GPT 侧的助手身份', evidence_message_ids: ['identity'] });
    rt.store.beginBatch('entity-alias-canonical-2', '2026-08-09T10:05:00Z');
    const alias = rt.rememberEntity('entity-alias-canonical-2', { schema_version: 1, canonical_name: 'GPT', aliases: ['GPT'], entity_type: 'assistant', description: 'ChatGPT/GPT 侧的助手身份', evidence_message_ids: ['identity-alias'] });
    expect(alias).toEqual(expect.objectContaining({ outcome: 'duplicate', entity_id: first.entity_id }));
    expect(rt.store.listEntities()).toHaveLength(1);
    const searched = rt.entitySearch({ query: 'GPT' });
    expect(searched[0]).toEqual(expect.objectContaining({ canonical_name: '晴', evidence_message_ids: ['identity'] }));
  });

  it('recovers an entity batch after a transient entity commit failure', () => {
    const dir = tempDir();
    const firstStore = new RelationshipMemoryStore(dir, 'semantic-subject', (phase) => phase === 'memory_commit');
    const first = new RelationshipMemoryRuntime(firstStore, new Map(messages.map((m) => [m.message_id, m])), () => '2026-08-09T11:00:00.000Z', new Map(), true);
    firstStore.beginBatch('entity-retry', '2026-08-09T10:04:00Z');
    const proposal = { schema_version: 1, canonical_name: '晴', aliases: ['晴', 'GPT'], entity_type: 'assistant', description: 'GPT 侧的助手身份', evidence_message_ids: ['identity'] };
    expect(first.rememberEntity('entity-retry', proposal).outcome).toBe('retryable_failed');
    expect(first.finalizeBatch('entity-retry', true)).toBe('retryable_failure');
    expect(firstStore.listEntityOutcomes().at(-1)?.outcome).toBe('retryable_failed');

    const replayStore = new RelationshipMemoryStore(dir, 'semantic-subject');
    const replay = new RelationshipMemoryRuntime(replayStore, new Map(messages.map((m) => [m.message_id, m])), () => '2026-08-09T11:01:00.000Z', new Map(), true);
    expect(replay.rememberEntity('entity-retry', proposal).outcome).toBe('accepted');
    expect(replay.finalizeBatch('entity-retry', true)).toBe('completed');
    expect(replayStore.listEntities()).toHaveLength(1);
  });

  it('keeps exact 093I assistant-intent provenance while storing a Chinese canonical summary', () => {
    const dir = tempDir();
    const store = new RelationshipMemoryStore(dir, 'semantic-subject');
    const intent = {
      schema_version: 1 as const, intent_id: 'intent-semantic-093m', subject_id: 'semantic-subject', session_id: 'session-semantic',
      assistant_message_id: 'assistant-intent-message', tool_use_id: 'tool-semantic', tool_name: 'remember_relationship_memory',
      memory: { text: 'Keep THIS exact memory text, including English.' },
      feel: { text: 'この気持ちは原文のまま残して。' }, captured_at: '2026-08-09T10:06:00.000Z',
    };
    store.appendAssistantIntent(intent);
    const rt = new RelationshipMemoryRuntime(store, new Map(messages.map((m) => [m.message_id, m])), () => '2026-08-09T11:00:00.000Z', new Map([[intent.intent_id, intent]]), true);
    rt.store.beginBatch('assistant-intent-cn', '2026-08-09T10:06:00Z');
    const remembered = rt.remember('assistant-intent-cn', {
      schema_version: 1, kind: 'relationship_event', summary: '助手希望保留这段关系记忆', participants: ['assistant'], evidence_message_ids: ['identity-alias'],
      assistant_intent_id: intent.intent_id, payload: { event: '助手主动请求保留一段关系记忆', meaning: '这段记忆对助手具有持续的关系意义' },
    });
    expect(remembered.outcome).toBe('accepted');
    expect(store.getMemory(remembered.memory_id!)?.summary).toBe('助手希望保留这段关系记忆');
    expect(store.getAssistantIntent(intent.intent_id)?.memory.text).toBe('Keep THIS exact memory text, including English.');
    expect(store.getAssistantIntent(intent.intent_id)?.feel.text).toBe('この気持ちは原文のまま残して。');
  });

  it('rejects untrusted identity evidence and non-Chinese identity semantics', () => {
    const rt = runtime(); rt.store.beginBatch('bad', '2026-08-09T10:04:00Z');
    expect(rt.rememberEntity('bad', { schema_version: 1, canonical_name: '晴', aliases: ['GPT'], entity_type: 'assistant', description: 'GPT-side assistant identity', evidence_message_ids: ['identity'] })).toEqual(expect.objectContaining({ rejection_code: 'non_chinese_semantic_prose' }));
    expect(rt.rememberEntity('bad', { schema_version: 1, canonical_name: '晴', aliases: ['GPT'], entity_type: 'assistant', description: 'GPT 侧的助手身份', evidence_message_ids: ['unknown'] })).toEqual(expect.objectContaining({ rejection_code: 'unresolvable_evidence' }));
    expect(rt.store.listEntities()).toHaveLength(0);
  });
});
