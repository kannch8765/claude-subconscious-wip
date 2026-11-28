import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCanonicalEvidenceCatalog,
  ASSISTANT_REMEMBER_TOOL_NAME,
  buildCanonicalMessages,
  buildCanonicalMessagesWithStats,
  extractAssistantRememberIntents,
  logTranscriptTextStats,
  RELATIONSHIP_ALLOWED_BUILTIN_TOOLS,
  RELATIONSHIP_DISALLOWED_BUILTIN_TOOLS,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  type AssistantRememberIntentRecord,
  type CanonicalMessage,
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

describe('reinforce matches evidence by transcript source, not by conversation', () => {
  const transcript = [
    { type: 'user', uuid: 'msg-1', timestamp: '2026-08-10T00:00:00Z', message: { content: [{ type: 'text', text: 'We planted a small lemon tree on the balcony today.' }] } },
    { type: 'user', uuid: 'msg-2', timestamp: '2026-08-10T00:01:00Z', message: { content: [{ type: 'text', text: 'It already has two new leaves.' }] } },
    { type: 'assistant', uuid: 'msg-3', timestamp: '2026-08-10T00:02:00Z', message: { content: [
      { type: 'text', text: 'That sounds like a calm start to the week.' },
      { type: 'text', text: 'I will keep the tree in mind.' },
      { type: 'tool_use', id: 'toolu_note', name: 'Write', input: { file_path: 'notes.txt', content: 'lemon tree, two leaves' } },
    ] } },
  ] as any[];
  // Two conversations carry the same messages: same message ids and blocks, different transcript evidence ids.
  const convA = buildCanonicalMessages(transcript, -1, 'conv-a');
  const convB = buildCanonicalMessages(transcript, -1, 'conv-b');
  const eventId = (events: CanonicalMessage[], messageId: string, blockIndex = 0) =>
    events.find((event) => event.message_id === messageId && event.block_index === blockIndex)!.evidence_id!;
  // The pre-block shape: one message-level event holding the joined text of the message's text blocks.
  const messageLevel: CanonicalMessage = {
    conversation_id: 'conv-old', message_id: 'msg-3', role: 'assistant',
    quote: 'That sounds like a calm start to the week.\nI will keep the tree in mind.', captured_at: '2026-08-10T00:02:00Z',
  };

  function tree(evidence: Record<string, string[]>, summary = 'A lemon tree on the balcony') {
    return {
      schema_version: 1, kind: 'personal_experience', summary, participants: ['user'], ...evidence,
      payload: { title: summary, experience: 'The user planted a small tree at home.' },
    };
  }

  // `extra` events are added to the trusted batch; a message-level one replaces `messageLevel` for its message id.
  function setup(
    evidence: Record<string, string[]> = { evidence_ids: [eventId(convA, 'msg-1')] },
    intents: AssistantRememberIntentRecord[] = [],
    extra: CanonicalMessage[] = [],
  ) {
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    for (const intent of intents) store.appendAssistantIntent(intent);
    const messages = new Map([...convA, ...convB].map((event) => [event.evidence_id!, event]));
    for (const event of [messageLevel, ...extra]) messages.set(event.evidence_id ?? event.message_id, event);
    const runtime = new RelationshipMemoryRuntime(store, messages, () => '2026-08-11T00:00:00Z', new Map(intents.map((intent) => [intent.intent_id, intent])));
    const memoryId = runtime.remember('seed', tree(evidence)).memory_id!;
    const evidenceOf = (id = memoryId) => store.listEvidence().filter((item) => item.memory_id === id);
    return { store, runtime, memoryId, evidenceOf };
  }

  it('does not attach a message again when another conversation carries it', () => {
    const { store, runtime, memoryId, evidenceOf } = setup();
    expect(runtime.reinforce('first', { memory_id: memoryId, evidence_ids: [eventId(convA, 'msg-2')] })).toEqual({ outcome: 'accepted', memory_id: memoryId });
    const later = { memory_id: memoryId, evidence_ids: [eventId(convB, 'msg-2')] };
    expect(runtime.reinforce('later', later)).toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(runtime.reinforce('later', later)).toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(evidenceOf()).toHaveLength(2);
    expect(store.listReinforcements()).toHaveLength(1);
  });

  it("treats a message in the memory's original evidence as attached under any conversation", () => {
    const { store, runtime, memoryId, evidenceOf } = setup();
    expect(runtime.reinforce('later', { memory_id: memoryId, evidence_ids: [eventId(convB, 'msg-1')] })).toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(evidenceOf()).toHaveLength(1);
    expect(store.listReinforcements()).toHaveLength(0);
  });

  it('attaches only the new message when a call mixes an attached one and a new one', () => {
    const { store, runtime, memoryId, evidenceOf } = setup();
    expect(runtime.reinforce('mixed', { memory_id: memoryId, evidence_ids: [eventId(convB, 'msg-1'), eventId(convB, 'msg-2')] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    const [reinforcement] = store.listReinforcements();
    expect(reinforcement.evidence_ids).toHaveLength(1);
    expect(evidenceOf().find((item) => item.evidence_id === reinforcement.evidence_ids[0]))
      .toEqual(expect.objectContaining({ message_id: 'msg-2', conversation_id: 'conv-b' }));
    expect(evidenceOf()).toHaveLength(2);
  });

  it('attaches a message carried twice in one call once', () => {
    const { runtime, memoryId, evidenceOf } = setup();
    expect(runtime.reinforce('twice', { memory_id: memoryId, evidence_ids: [eventId(convA, 'msg-2'), eventId(convB, 'msg-2')] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(evidenceOf().filter((item) => item.message_id === 'msg-2')).toHaveLength(1);
  });

  it('keeps other blocks of the same message distinct', () => {
    const { runtime, memoryId, evidenceOf } = setup({ evidence_ids: [eventId(convA, 'msg-3', 0)] });
    expect(runtime.reinforce('other-blocks', { memory_id: memoryId, evidence_ids: [eventId(convB, 'msg-3', 1), eventId(convB, 'msg-3', 2)] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(evidenceOf().map((item) => item.block_index).sort()).toEqual([0, 1, 2]);
    expect(runtime.reinforce('same-block', { memory_id: memoryId, evidence_ids: [eventId(convB, 'msg-3', 0)] })).toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(evidenceOf()).toHaveLength(3);
  });

  it('still attaches the message to a different memory', () => {
    const { runtime, memoryId, evidenceOf } = setup();
    const other = runtime.remember('other', tree({ evidence_ids: [eventId(convA, 'msg-2')] }, 'New leaves on the tree')).memory_id!;
    expect(runtime.reinforce('other-memory', { memory_id: other, evidence_ids: [eventId(convB, 'msg-1')] })).toEqual({ outcome: 'accepted', memory_id: other });
    expect(evidenceOf(other).map((item) => item.message_id).sort()).toEqual(['msg-1', 'msg-2']);
    expect(evidenceOf(memoryId)).toHaveLength(1);
  });

  it('links an intent on a call whose messages are all attached already', () => {
    const intents = extractAssistantRememberIntents([{
      type: 'assistant', uuid: 'msg-intent', timestamp: '2026-08-10T00:03:00Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_intent', name: ASSISTANT_REMEMBER_TOOL_NAME, input: { memory: { text: 'Keep the tree.' }, feel: { text: 'Small and steady.' } } }] },
    }] as any[], -1, 'session-1', 'subject');
    const { store, runtime, memoryId, evidenceOf } = setup(undefined, intents);
    store.beginBatch('intent-batch', '2026-08-11T00:00:00Z');
    expect(runtime.reinforce('intent-batch', { memory_id: memoryId, evidence_ids: [eventId(convB, 'msg-1')], assistant_intent_id: intents[0].intent_id }))
      .toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(store.getTerminalAssistantIntentOutcome(intents[0].intent_id, 'intent-batch')).toEqual(expect.objectContaining({ outcome: 'duplicate', memory_id: memoryId }));
    expect(evidenceOf()).toHaveLength(1);
    expect(runtime.finalizeBatch('intent-batch', true)).toBe('completed');
  });

  // Message-level evidence keeps main's behaviour: it is matched by evidence id only, never by block source.
  it('never lets message-level evidence hold a block, even when its quote is the full old join', () => {
    const { runtime, memoryId, evidenceOf } = setup({ evidence_message_ids: ['msg-3'] });
    expect(evidenceOf()).toEqual([expect.not.objectContaining({ block_index: expect.anything() })]);
    expect(runtime.reinforce('blocks', { memory_id: memoryId, evidence_ids: [0, 1, 2].map((index) => eventId(convB, 'msg-3', index)) }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(evidenceOf().map((item) => item.block_index ?? 'message').sort()).toEqual([0, 1, 2, 'message']);
    expect(runtime.reinforce('same-legacy', { memory_id: memoryId, evidence_message_ids: ['msg-3'] })).toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(evidenceOf()).toHaveLength(4);
  });

  it('keeps message-level events of one message apart when their evidence ids differ', () => {
    const legacy = (evidenceId: string, quote: string): CanonicalMessage => ({ ...messageLevel, evidence_id: evidenceId, quote });
    const { runtime, memoryId, evidenceOf } = setup(undefined, [], [
      legacy('legacy-ev-a', 'That sounds like a calm start to the week.'),
      legacy('legacy-ev-b', 'That sounds like a calm start to the week.\nI will keep the tree in mind.'),
    ]);
    expect(runtime.reinforce('two-legacy', { memory_id: memoryId, evidence_ids: ['legacy-ev-a', 'legacy-ev-b', eventId(convB, 'msg-3', 1)] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(evidenceOf().filter((item) => item.message_id === 'msg-3').map((item) => item.block_index ?? item.source_evidence_id).sort())
      .toEqual([1, 'legacy-ev-a', 'legacy-ev-b']);
  });

  it('attaches a message-level legacy message when the memory holds only some blocks of it', () => {
    const { runtime, memoryId, evidenceOf } = setup({ evidence_ids: [eventId(convA, 'msg-3', 0)] });
    expect(runtime.reinforce('message-level', { memory_id: memoryId, evidence_message_ids: ['msg-3'] })).toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(runtime.reinforce('message-level-again', { memory_id: memoryId, evidence_message_ids: ['msg-3'] })).toEqual({ outcome: 'duplicate', memory_id: memoryId });
    expect(evidenceOf()).toHaveLength(2);
  });
});

describe('scheduled prompts and isMeta text on user entries', () => {
  const WAKE_PROMPT = 'Check the garden plan draft.';
  // The same shape main produced its evidence ids from; see the id test below.
  const base = [
    { type: 'user', uuid: 'user-typed', timestamp: '2026-03-01T09:00:00Z', message: { role: 'user', content: 'Can we look at the garden plan again?' } },
    { type: 'assistant', uuid: 'asst-1', timestamp: '2026-03-01T09:01:00Z', message: { content: [
      { type: 'text', text: 'Sure, I will check back later.' },
      { type: 'tool_use', id: 'toolu_wake', name: 'ScheduleWakeup', input: { delaySeconds: 1200, prompt: WAKE_PROMPT, reason: 'waiting' } },
    ] } },
    { type: 'user', uuid: 'user-result', timestamp: '2026-03-01T09:01:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wake', content: 'scheduled' }] } },
    { type: 'user', uuid: 'user-blocks', timestamp: '2026-03-01T09:02:00Z', message: { content: [{ type: 'text', text: 'Also add the bench.' }] } },
  ] as any[];
  const fired = (uuid: string, text: string, extra: Record<string, unknown> = { isMeta: true }) =>
    ({ type: 'user', uuid, timestamp: '2026-03-01T09:30:00Z', ...extra, message: { role: 'user', content: text } });
  const typed = (uuid: string, text: string) => ({ type: 'user', uuid, timestamp: '2026-03-01T09:40:00Z', message: { role: 'user', content: text } });
  const kinds = (events: CanonicalMessage[]) => events.map((event) => [event.message_id, event.event_kind]);
  const logged = (stats: Parameters<typeof logTranscriptTextStats>[0]) => {
    const lines: string[] = [];
    logTranscriptTextStats(stats, (line) => lines.push(line));
    return lines;
  };

  it('classifies a fired ScheduleWakeup prompt with isMeta as self_note, with no warning', () => {
    const { messages, stats } = buildCanonicalMessagesWithStats([...base, fired('wake-1', WAKE_PROMPT, { isMeta: true, promptSource: 'sdk' })], -1, 'conv-meta');
    expect(messages.at(-1)).toEqual(expect.objectContaining({ message_id: 'wake-1', role: 'user', event_kind: 'self_note', quote: WAKE_PROMPT }));
    expect(stats).toEqual({ scheduled_prompts: 1, self_note: 1, meta_text: 0, unmarked_prompt_match: 0, prompt_source: { sdk: 1, other: 0, none: 0 } });
    expect(logged(stats)).toEqual([
      'Transcript text kinds: scheduled_prompts_seen=1 self_note=1 meta_text=0 unmarked_prompt_match=0 prompt_source_sdk=1 prompt_source_other=0 prompt_source_none=0',
    ]);
  });

  it('keeps an unmarked entry equal to a scheduled prompt as user_text, and warns once without logging text', () => {
    const { messages, stats } = buildCanonicalMessagesWithStats([...base, fired('wake-1', WAKE_PROMPT, {})], -1, 'conv-meta');
    expect(messages.at(-1)?.event_kind).toBe('user_text');
    expect(stats).toEqual(expect.objectContaining({ self_note: 0, unmarked_prompt_match: 1 }));
    const lines = logged(stats);
    expect(lines.filter((line) => line.startsWith('WARNING:'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(WAKE_PROMPT);
    expect(lines.join('\n')).not.toContain('garden');
  });

  it('keeps the user typing a fired prompt again as citable user_text', () => {
    const transcript = [...base, fired('wake-1', WAKE_PROMPT), typed('user-repeat', WAKE_PROMPT)];
    const { messages, stats } = buildCanonicalMessagesWithStats(transcript, base.length - 1, 'conv-meta');
    expect(kinds(messages)).toEqual([['wake-1', 'self_note'], ['user-repeat', 'user_text']]);
    expect(stats).toEqual(expect.objectContaining({ self_note: 1, unmarked_prompt_match: 1 }));
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    const runtime = new RelationshipMemoryRuntime(store, new Map(messages.map((event) => [event.evidence_id!, event])), () => '2026-03-02T00:00:00Z');
    expect(runtime.remember('repeat', {
      schema_version: 1, kind: 'user_preference', summary: 'Keeps an eye on the garden plan draft', participants: ['user'],
      evidence_ids: [messages[1].evidence_id!], payload: { topic: 'garden plan', preference: 'Wants the draft checked.' },
    }).outcome).toBe('accepted');
  });

  it('finds the scheduling tool_use before startIndex when the firing comes in a later pass', () => {
    const transcript = [...base, fired('wake-1', `  ${WAKE_PROMPT}\n`)];
    expect(kinds(buildCanonicalMessages(transcript, base.length - 1, 'conv-meta'))).toEqual([['wake-1', 'self_note']]);
  });

  it('classifies every firing of a recurring CronCreate as self_note', () => {
    const cronPrompt = 'Water the herbs and note how they look.';
    const transcript = [
      ...base,
      { type: 'assistant', uuid: 'asst-cron', timestamp: '2026-03-01T09:03:00Z', message: { content: [
        { type: 'tool_use', id: 'toolu_cron', name: 'CronCreate', input: { cron: '0 8 * * *', prompt: cronPrompt, recurring: true } },
      ] } },
      fired('cron-1', cronPrompt),
      fired('cron-2', cronPrompt),
    ];
    const { messages, stats } = buildCanonicalMessagesWithStats(transcript, base.length, 'conv-meta');
    expect(kinds(messages)).toEqual([['cron-1', 'self_note'], ['cron-2', 'self_note']]);
    expect(messages[0].evidence_id).not.toBe(messages[1].evidence_id);
    expect(stats).toEqual(expect.objectContaining({ scheduled_prompts: 2, self_note: 2 }));
  });

  it('classifies other isMeta text as meta_text and logs promptSource only in fixed buckets', () => {
    const transcript = [
      ...base,
      fired('nudge-1', 'Runtime note: the last reply was empty.'),
      { type: 'user', uuid: 'nudge-2', timestamp: '2026-03-01T09:31:00Z', isMeta: true, promptSource: 'SyntheticPrivateValue', message: { content: [{ type: 'text', text: 'Runtime note: image resized.' }] } },
      fired('nudge-3', 'Runtime note: context trimmed.', { isMeta: true, promptSource: 'constructor' }),
    ];
    const { messages, stats } = buildCanonicalMessagesWithStats(transcript, base.length - 1, 'conv-meta');
    expect(kinds(messages)).toEqual([['nudge-1', 'meta_text'], ['nudge-2', 'meta_text'], ['nudge-3', 'meta_text']]);
    expect(stats).toEqual({ scheduled_prompts: 1, self_note: 0, meta_text: 3, unmarked_prompt_match: 0, prompt_source: { sdk: 0, other: 2, none: 1 } });
    const line = logged(stats).join('\n');
    expect(line).toContain('prompt_source_other=2 prompt_source_none=1');
    expect(line).not.toContain('SyntheticPrivateValue');
    expect(line).not.toContain('constructor');
  });

  it("keeps main's evidence ids for user_text, assistant_text, assistant_tool_use and tool_result events", () => {
    const events = buildCanonicalMessages([...base, fired('wake-1', WAKE_PROMPT), fired('nudge-1', 'Runtime note.')], -1, 'conv-meta');
    // Ids computed on main 308bc6b from `base`.
    expect(events.slice(0, 5).map((event) => [event.message_id, event.event_kind, event.evidence_id])).toEqual([
      ['user-typed', 'user_text', 'transcript_ev_ec8568da5172f0fa57c3d4d4'],
      ['asst-1', 'assistant_text', 'transcript_ev_cf7c72d8c4b6a2317654a9fb'],
      ['asst-1', 'assistant_tool_use', 'transcript_ev_40fecf5bd2677aca97681a92'],
      ['user-result', 'tool_result', 'transcript_ev_957dc17fd14edc03e333e7a8'],
      ['user-blocks', 'user_text', 'transcript_ev_e4046d115ca3c5f4aa5d3cea'],
    ]);
    expect(kinds(events.slice(5))).toEqual([['wake-1', 'self_note'], ['nudge-1', 'meta_text']]);
  });

  it('keeps user text that equals a prompt scheduled only later as user_text', () => {
    const transcript = [
      typed('user-asks', 'Remind me about the seed order.'),
      { type: 'assistant', uuid: 'asst-wake', timestamp: '2026-03-01T10:01:00Z', message: { content: [
        { type: 'tool_use', id: 'toolu_later', name: 'ScheduleWakeup', input: { delaySeconds: 600, prompt: 'Remind me about the seed order.' } },
      ] } },
      fired('wake-later', 'Remind me about the seed order.'),
    ];
    const { messages, stats } = buildCanonicalMessagesWithStats(transcript, -1, 'conv-meta');
    expect(kinds(messages).filter(([, kind]) => kind !== 'assistant_tool_use')).toEqual([['user-asks', 'user_text'], ['wake-later', 'self_note']]);
    expect(stats.unmarked_prompt_match).toBe(0);
  });

  it('shows the new kinds to the observer and says they are not the user\'s words', () => {
    const events = buildCanonicalMessages([...base, fired('wake-1', WAKE_PROMPT)], base.length - 1, 'conv-meta');
    const catalog = appendCanonicalEvidenceCatalog('observe', events);
    expect(catalog).toContain(`evidence_id="${events[0].evidence_id}" message_id="wake-1" role="user" event_kind="self_note"`);
    expect(catalog).toContain('cannot be cited as evidence');
  });

  describe('citing the new kinds', () => {
    const transcript = [
      ...base,
      fired('wake-1', WAKE_PROMPT),
      fired('nudge-1', 'Runtime note: the user keeps bees on the roof.'),
      typed('user-thanks', 'Thanks for checking.'),
    ];
    const events = buildCanonicalMessages(transcript, -1, 'conv-meta');
    const idOf = (messageId: string) => events.find((event) => event.message_id === messageId)!.evidence_id!;
    const proposal = (evidence: Record<string, string[]>, extra: Record<string, unknown> = {}) => ({
      schema_version: 1, kind: 'personal_experience', summary: 'Keeps bees on the roof', participants: ['user'], ...evidence, ...extra,
      payload: { title: 'Keeps bees on the roof', experience: 'The user keeps bees on the roof.' },
    });
    function setup(intents: AssistantRememberIntentRecord[] = []) {
      const store = new RelationshipMemoryStore(tempDir(), 'subject');
      for (const intent of intents) store.appendAssistantIntent(intent);
      const runtime = new RelationshipMemoryRuntime(
        store, new Map(events.map((event) => [event.evidence_id!, event])), () => '2026-03-02T00:00:00Z',
        new Map(intents.map((intent) => [intent.intent_id, intent])),
      );
      return { store, runtime };
    }
    const rejected = expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'not_citable_evidence' });

    it('rejects a remember that cites only a self_note, by evidence id or legacy message id', () => {
      const { store, runtime } = setup();
      const result = runtime.remember('only-note', proposal({ evidence_ids: [idOf('wake-1')] }));
      expect(result).toEqual(rejected);
      expect(result.reason).toContain(idOf('wake-1'));
      expect(result.reason).toContain("Neither is the user's words");
      expect(runtime.remember('only-note-legacy', proposal({ evidence_message_ids: ['wake-1'] }))).toEqual(rejected);
      expect(store.listMemories()).toHaveLength(0);
      expect(store.listEvidence()).toHaveLength(0);
    });

    it('rejects a mixed remember whole, so a claim only meta_text supported is never saved', () => {
      const { store, runtime } = setup();
      const result = runtime.remember('mixed', proposal({ evidence_ids: [idOf('nudge-1'), idOf('user-thanks')] }));
      expect(result).toEqual(rejected);
      expect(result.reason).toContain(idOf('nudge-1'));
      expect(result.reason).not.toContain(idOf('user-thanks'));
      expect(store.listMemories()).toHaveLength(0);
      expect(store.listEvidence()).toHaveLength(0);
    });

    it('leaves a linked remember intent open across a replay in the same batch, for a corrected call', () => {
      const intents = extractAssistantRememberIntents([{
        type: 'assistant', uuid: 'asst-intent', timestamp: '2026-03-01T09:05:00Z',
        message: { content: [{ type: 'tool_use', id: 'toolu_intent', name: ASSISTANT_REMEMBER_TOOL_NAME, input: { memory: { text: 'The garden plan.' }, feel: { text: 'Looking forward to it.' } } }] },
      }] as any[], -1, 'session-1', 'subject');
      const { store, runtime } = setup(intents);
      const intentId = intents[0].intent_id;
      store.beginBatch('intent-batch', '2026-03-02T00:00:00Z');
      const bad = proposal({ evidence_ids: [idOf('nudge-1'), idOf('user-typed')] }, { assistant_intent_id: intentId });
      expect(runtime.remember('intent-batch', bad)).toEqual(rejected);
      expect(runtime.remember('intent-batch', bad)).toEqual(rejected);
      expect(store.getTerminalAssistantIntentOutcome(intentId)).toBeUndefined();
      const corrected = {
        schema_version: 1, kind: 'personal_experience', summary: 'Looking at the garden plan again', participants: ['user'],
        evidence_ids: [idOf('user-typed')], assistant_intent_id: intentId,
        payload: { title: 'Looking at the garden plan again', experience: 'The user asked to look at the garden plan again.' },
      };
      const accepted = runtime.remember('intent-batch', corrected);
      expect(accepted.outcome).toBe('accepted');
      expect(store.getTerminalAssistantIntentOutcome(intentId, 'intent-batch')).toEqual(expect.objectContaining({ outcome: 'accepted', memory_id: accepted.memory_id }));
      expect(runtime.finalizeBatch('intent-batch', true)).toBe('completed');
    });

    it('rejects a reinforce that cites a self_note, alone or mixed, and attaches nothing', () => {
      const { store, runtime } = setup();
      const memoryId = runtime.remember('seed', proposal({ evidence_ids: [idOf('user-typed')] })).memory_id!;
      expect(runtime.reinforce('only-note', { memory_id: memoryId, evidence_ids: [idOf('wake-1')] })).toEqual(rejected);
      expect(runtime.reinforce('mixed', { memory_id: memoryId, evidence_ids: [idOf('wake-1'), idOf('user-blocks')] })).toEqual(rejected);
      expect(store.listReinforcements()).toHaveLength(0);
      expect(store.listEvidence().map((item) => item.message_id)).toEqual(['user-typed']);
      expect(runtime.reinforce('corrected', { memory_id: memoryId, evidence_ids: [idOf('user-blocks')] })).toEqual({ outcome: 'accepted', memory_id: memoryId });
    });

    it('applies the same rule to entity evidence', () => {
      const { store, runtime } = setup();
      const entity = (ids: string[]) => ({ schema_version: 1, canonical_name: 'Roof hive', aliases: ['the hive'], entity_type: 'other', description: 'A beehive the user keeps on the roof.', evidence_ids: ids });
      expect(runtime.rememberEntity('entity-note', entity([idOf('nudge-1')]))).toEqual(rejected);
      expect(runtime.rememberEntity('entity-mixed', entity([idOf('nudge-1'), idOf('user-thanks')]))).toEqual(rejected);
      expect(store.listEntities()).toHaveLength(0);
      expect(store.listEntityEvidence()).toHaveLength(0);
    });

    it('leaves stored self_note / meta_text evidence out of recall quote snippets', async () => {
      const { store, runtime } = setup();
      const memoryId = runtime.remember('seed', proposal({ evidence_ids: [idOf('user-typed')] })).memory_id!;
      // Only a direct store write can hold these kinds; recall must still never quote them as anyone's words.
      const stored = ['wake-1', 'nudge-1'].map((messageId) => {
        const event = events.find((item) => item.message_id === messageId)!;
        return {
          evidence_id: `ev-${messageId}`, memory_id: memoryId, conversation_id: event.conversation_id, message_id: messageId, role: event.role,
          quote: event.quote, captured_at: event.captured_at, source_evidence_id: event.evidence_id, event_kind: event.event_kind, block_index: 0,
        };
      });
      store.appendReinforcement({
        schema_version: 1, reinforcement_id: 'reinforce-direct', memory_id: memoryId, batch_id: 'direct',
        evidence_ids: stored.map((item) => item.evidence_id), latest_evidence_at: '2026-03-01T09:30:00Z', recorded_at: '2026-03-02T00:00:00Z',
      }, stored);
      const [hit] = await runtime.memorySearchHybridWithEvidence({});
      expect(hit.memory_id).toBe(memoryId);
      expect(hit.quote_snippets.map((snippet) => snippet.evidence_id)).not.toContain('ev-wake-1');
      expect(hit.quote_snippets.map((snippet) => snippet.evidence_id)).not.toContain('ev-nudge-1');
      expect(hit.quote_snippets.map((snippet) => snippet.quote)).toEqual(['Can we look at the garden plan again?']);
    });
  });
});
