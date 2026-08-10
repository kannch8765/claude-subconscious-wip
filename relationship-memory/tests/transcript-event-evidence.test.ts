import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCanonicalEvidenceCatalog,
  buildCanonicalMessages,
  RELATIONSHIP_ALLOWED_BUILTIN_TOOLS,
  RELATIONSHIP_DISALLOWED_BUILTIN_TOOLS,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-event-evidence-')); dirs.push(dir); return dir; }

describe('canonical transcript-event evidence', () => {
  it('keeps text, tool use bodies, and tool results as distinct stable evidence events', () => {
    const messages = [
      { type: 'user', uuid: 'u1', timestamp: '2026-08-10T00:00:00Z', message: { content: [{ type: 'text', text: '猫今天画画了' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-08-10T00:01:00Z', message: { content: [
        { type: 'text', text: '我去记一下。' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: "cat >> diary.md <<'EOF'\n今天猫又画画了，我很开心。\nEOF" } },
        { type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: 'note.txt', content: '未来也想记得这件事。' } },
      ] } },
      { type: 'user', uuid: 'u2', timestamp: '2026-08-10T00:02:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    ] as any[];

    const events = buildCanonicalMessages(messages, -1, 'conv-1');
    expect(events.map((event) => event.event_kind)).toEqual(['user_text', 'assistant_text', 'assistant_tool_use', 'assistant_tool_use', 'tool_result']);
    expect(events[2].quote).toContain('今天猫又画画了，我很开心。');
    expect(events[3].tool_name).toBe('Write');
    expect(events[4].tool_name).toBe('Bash');
    expect(new Set(events.map((event) => event.evidence_id)).size).toBe(events.length);
    expect(events[1].message_id).toBe(events[2].message_id);
    expect(events[1].evidence_id).not.toBe(events[2].evidence_id);

    const catalog = appendCanonicalEvidenceCatalog('observe', events);
    expect(catalog).toContain('trusted="transcript_provenance_only"');
    expect(catalog).toContain(`evidence_id="${events[2].evidence_id}"`);
    expect(catalog).toContain('tool_name="Bash"');
    expect(catalog).toContain('Judge semantics yourself');
  });

  it('accepts exact event evidence IDs and rejects fabricated IDs while legacy message evidence stays valid', () => {
    const events = buildCanonicalMessages([
      { type: 'assistant', uuid: 'a1', timestamp: '2026-08-10T00:01:00Z', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'printf relationship-relevant-text' } }] } },
    ] as any[], -1, 'conv-2');
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    const runtime = new RelationshipMemoryRuntime(store, new Map(events.map((event) => [event.evidence_id!, event])), () => '2026-08-10T01:00:00Z');
    const proposal = {
      schema_version: 1, kind: 'relationship_event', summary: '助手通过工具记录了一段有关系意义的内容', participants: ['assistant'],
      evidence_ids: [events[0].evidence_id!], payload: { event: '助手通过工具输入记录了关系相关内容', meaning: '这段内容由 DS 判断具有可持续的关系意义' },
    };
    expect(runtime.remember('batch-1', proposal).outcome).toBe('accepted');
    expect(store.listEvidence()[0].source_evidence_id).toBe(events[0].evidence_id);
    expect(store.listEvidence()[0].event_kind).toBe('assistant_tool_use');
    expect(runtime.remember('batch-2', { ...proposal, evidence_ids: ['fabricated-event-id'] }).rejection_code).toBe('unresolvable_evidence');

    const legacy = { conversation_id: 'conv-old', message_id: 'msg-old', role: 'user' as const, quote: '旧证据仍可读', captured_at: '2026-01-01T00:00:00Z' };
    const legacyStore = new RelationshipMemoryStore(tempDir(), 'subject');
    const legacyRuntime = new RelationshipMemoryRuntime(legacyStore, new Map([[legacy.message_id, legacy]]), () => '2026-08-10T01:00:00Z');
    const legacyProposal = {
      schema_version: 1, kind: 'relationship_event', summary: '旧消息证据仍然可以被读取', participants: ['user'],
      evidence_message_ids: ['msg-old'], payload: { event: '旧消息证据仍可用于关系记忆', meaning: '兼容既有基于消息的证据账本' },
    };
    expect(legacyRuntime.remember('batch-old', legacyProposal).outcome).toBe('accepted');
  });

  it('resolves legacy message IDs only for a unique new event and rejects ambiguous multi-block messages', () => {
    const events = buildCanonicalMessages([
      { type: 'user', uuid: 'u1', timestamp: '2026-08-10T00:00:00Z', message: { content: [{ type: 'text', text: '猫喜欢画画。' }] } },
      { type: 'user', uuid: 'u2', timestamp: '2026-08-10T00:01:00Z', message: { content: [{ type: 'text', text: '猫今天又画了一张。' }] } },
    ] as any[], -1, 'conv-legacy-crossing');
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    const runtime = new RelationshipMemoryRuntime(store, new Map(events.map((event) => [event.evidence_id!, event])), () => '2026-08-10T01:00:00Z');
    const remembered = runtime.remember('legacy-create', {
      schema_version: 1, kind: 'personal_experience', summary: '猫喜欢画画', participants: ['user'],
      evidence_message_ids: ['u1'], payload: { title: '画画', experience: '猫喜欢画画。' },
    });
    expect(remembered.outcome).toBe('accepted');
    expect(store.listEvidence().find((item) => item.memory_id === remembered.memory_id)?.source_evidence_id).toBe(events[0].evidence_id);
    expect(runtime.reinforce('legacy-reinforce', { memory_id: remembered.memory_id!, evidence_message_ids: ['u2'] }).outcome).toBe('accepted');
    expect(runtime.rememberEntity('legacy-entity', {
      schema_version: 1, canonical_name: '猫', aliases: ['猫'], entity_type: 'user', description: '对话中的用户身份', evidence_message_ids: ['u1'],
    }).outcome).toBe('accepted');
    expect(runtime.remember('exact-id-does-not-accept-message-id', {
      schema_version: 1, kind: 'personal_experience', summary: '精确证据 ID 不降级', participants: ['user'],
      evidence_ids: ['u1'], payload: { title: '精确 ID', experience: '精确 evidence_ids 不接受 message_id。' },
    }).rejection_code).toBe('unresolvable_evidence');

    const ambiguousEvents = buildCanonicalMessages([
      { type: 'assistant', uuid: 'a-multi', timestamp: '2026-08-10T00:02:00Z', message: { content: [
        { type: 'text', text: '先说一句。' },
        { type: 'tool_use', id: 'toolu_multi', name: 'Write', input: { file_path: 'diary.md', content: '再写一段。' } },
      ] } },
    ] as any[], -1, 'conv-ambiguous');
    const ambiguousStore = new RelationshipMemoryStore(tempDir(), 'subject');
    const ambiguousRuntime = new RelationshipMemoryRuntime(ambiguousStore, new Map(ambiguousEvents.map((event) => [event.evidence_id!, event])), () => '2026-08-10T01:00:00Z');
    const legacyAmbiguous = ambiguousRuntime.remember('ambiguous', {
      schema_version: 1, kind: 'relationship_event', summary: '旧消息 ID 不能塌缩多事件', participants: ['assistant'],
      evidence_message_ids: ['a-multi'], payload: { event: '同一消息包含多个证据事件', meaning: '必须使用精确的后端 evidence_id' },
    });
    expect(legacyAmbiguous).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'ambiguous_evidence' }));
    expect(ambiguousRuntime.remember('exact-after-ambiguous', {
      schema_version: 1, kind: 'relationship_event', summary: '精确事件 ID 可继续使用', participants: ['assistant'],
      evidence_ids: [ambiguousEvents[1].evidence_id!], payload: { event: '精确选择工具事件', meaning: '保留 block 级证据来源' },
    }).outcome).toBe('accepted');
  });

  it('keeps Task 093T observer builtin-tool isolation unchanged', () => {
    expect(RELATIONSHIP_ALLOWED_BUILTIN_TOOLS).toEqual([]);
    expect(RELATIONSHIP_DISALLOWED_BUILTIN_TOOLS).toContain('Bash');
    expect(RELATIONSHIP_DISALLOWED_BUILTIN_TOOLS).toContain('Write');
  });
});
