import * as os from 'os';
import * as path from 'path';
import type { TranscriptMessage } from '../../../scripts/transcript_utils.js';
import { MEMORY_KINDS, type AssistantRememberIntentRecord, type CanonicalMessage, type MemoryKind, type ParticipantRole, type TranscriptEvidenceKind } from '../schema/index.js';
import { RelationshipMemoryStore, stableId } from '../store/index.js';
import { MAX_UNRESOLVED_INTENT_TURNS, MEMORY_MAINTENANCE_REVIEW_TOOL_NAMES, MEMORY_REMEMBER_TOOL_NAMES, entityRememberToolSchema, entitySearchToolSchema, memoryMaintenanceReviewToolSchema, memoryRememberKindToolSchema, memoryRememberToolName, memoryReinforceToolSchema, memorySearchToolSchema, RelationshipMemoryRuntime, type MemoryMaintenanceReviewToolName, type MemoryRememberToolName } from '../tools/index.js';
import { rebuildProjection } from '../projection/index.js';
import { listDeferredAssistantIntents } from '../intent/index.js';
import { createSemanticRetrieverFromEnvironment } from '../retrieval/index.js';
import { redactText, redactedJson } from '../redact/index.js';

export interface RelationshipTool {
  label: string;
  name: 'memory_search' | MemoryRememberToolName | MemoryMaintenanceReviewToolName | 'memory_reinforce' | 'entity_search' | 'entity_remember';
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, args: unknown): Promise<unknown>;
}

export type ResultWrapper = (value: unknown) => unknown;

export interface BuildRelationshipToolsOptions {
  includeMaintenanceReviewTools?: boolean;
}

export function relationshipMemoryRoot(): string {
  return process.env.RELATIONSHIP_MEMORY_DIR || path.join(os.homedir(), '.local', 'share', 'relationship-memory');
}

const MAX_TRANSCRIPT_EVIDENCE_CHARS = 12_000;

// Redaction runs on the whole block, before the size cap (see redact/index.ts)
function boundedEvidenceText(value: unknown): string | null {
  let text = typeof value === 'string' ? redactText(value) : redactedJson(value, undefined, 2);
  text = text.trim();
  if (!text) return null;
  if (text.length <= MAX_TRANSCRIPT_EVIDENCE_CHARS) return text;
  return `${text.slice(0, MAX_TRANSCRIPT_EVIDENCE_CHARS)}\n... [transcript evidence truncated at ${MAX_TRANSCRIPT_EVIDENCE_CHARS} chars]`;
}

function transcriptEventId(
  conversationId: string,
  messageId: string,
  blockIndex: number,
  eventKind: TranscriptEvidenceKind,
  toolUseId?: string,
): string {
  return stableId('transcript_ev', {
    conversation_id: conversationId,
    message_id: messageId,
    block_index: blockIndex,
    event_kind: eventKind,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  });
}

const SCHEDULING_TOOL_NAMES = new Set(['ScheduleWakeup', 'CronCreate']);

/** Counts for one pass, metadata only: never any text or transcript field value. */
export interface TranscriptTextStats {
  /** ScheduleWakeup / CronCreate prompts in the whole transcript, including before the pass. */
  scheduled_prompts: number;
  self_note: number;
  meta_text: number;
  /**
   * User text without `isMeta: true` that equals an earlier scheduled prompt. Kept as user_text: either the user
   * typed the same words, or Claude Code stopped marking firings.
   */
  unmarked_prompt_match: number;
  /** promptSource of the self_note / meta_text entries, in fixed buckets: only `sdk` is a known value. */
  prompt_source: { sdk: number; other: number; none: number };
}

/**
 * Index of the first transcript entry that scheduled each (trimmed) prompt. A wakeup fires in a later pass than the
 * one that scheduled it, so this reads the whole transcript, not only the new range.
 */
function scheduledPromptIndex(messages: TranscriptMessage[]): { firstIndex: Map<string, number>; count: number } {
  const firstIndex = new Map<string, number>();
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type !== 'assistant') continue;
    const content = messages[i].message?.content ?? messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content as any[]) {
      if (block?.type !== 'tool_use' || !SCHEDULING_TOOL_NAMES.has(block.name)) continue;
      const prompt = typeof block.input?.prompt === 'string' ? block.input.prompt.trim() : '';
      if (!prompt) continue;
      count += 1;
      if (!firstIndex.has(prompt)) firstIndex.set(prompt, i);
    }
  }
  return { firstIndex, count };
}

export function buildCanonicalMessages(
  messages: TranscriptMessage[],
  startIndex: number,
  conversationId: string,
): CanonicalMessage[] {
  return buildCanonicalMessagesWithStats(messages, startIndex, conversationId).messages;
}

/**
 * Text on a user entry marked `isMeta: true` is `self_note` when it equals the prompt of an earlier ScheduleWakeup /
 * CronCreate, else `meta_text`. Text alone can't tell a firing from the user typing the same words, so text on an
 * unmarked entry stays `user_text`; a match there is only counted (`unmarked_prompt_match`).
 */
export function buildCanonicalMessagesWithStats(
  messages: TranscriptMessage[],
  startIndex: number,
  conversationId: string,
): { messages: CanonicalMessage[]; stats: TranscriptTextStats } {
  const result: CanonicalMessage[] = [];
  const toolNames = new Map<string, string>();
  const scheduled = scheduledPromptIndex(messages);
  const stats: TranscriptTextStats = {
    scheduled_prompts: scheduled.count, self_note: 0, meta_text: 0, unmarked_prompt_match: 0, prompt_source: { sdk: 0, other: 0, none: 0 },
  };
  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    if (!message.uuid) continue;
    const role = message.type as ParticipantRole;
    const capturedAt = message.timestamp || new Date(0).toISOString();
    const content = message.message?.content ?? message.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex] as any;
      let eventKind: TranscriptEvidenceKind | null = null;
      let quote: string | null = null;
      let toolName: string | undefined;
      let toolUseId: string | undefined;
      let matchesEarlierPrompt = false;

      if (block?.type === 'text') {
        if (role === 'user') {
          const scheduledAt = typeof block.text === 'string' ? scheduled.firstIndex.get(block.text.trim()) : undefined;
          matchesEarlierPrompt = scheduledAt !== undefined && scheduledAt < i;
          eventKind = message.isMeta !== true ? 'user_text' : matchesEarlierPrompt ? 'self_note' : 'meta_text';
        } else {
          eventKind = 'assistant_text';
        }
        quote = boundedEvidenceText(block.text);
      } else if (role === 'assistant' && block?.type === 'tool_use' && block.name) {
        eventKind = 'assistant_tool_use';
        toolName = String(block.name);
        toolUseId = typeof block.id === 'string' && block.id ? block.id : undefined;
        if (toolUseId) toolNames.set(toolUseId, toolName);
        quote = boundedEvidenceText(block.input);
      } else if (block?.type === 'tool_result') {
        eventKind = 'tool_result';
        toolUseId = typeof block.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : undefined;
        toolName = toolUseId ? toolNames.get(toolUseId) : undefined;
        quote = boundedEvidenceText(block.content);
      }
      if (!eventKind || !quote) continue;
      result.push({
        evidence_id: transcriptEventId(conversationId, message.uuid, blockIndex, eventKind, toolUseId),
        conversation_id: conversationId,
        message_id: message.uuid,
        block_index: blockIndex,
        role,
        event_kind: eventKind,
        ...(toolName ? { tool_name: toolName } : {}),
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
        quote,
        captured_at: capturedAt,
      });
      if (eventKind === 'self_note' || eventKind === 'meta_text') {
        stats[eventKind] += 1;
        stats.prompt_source[message.promptSource === undefined ? 'none' : message.promptSource === 'sdk' ? 'sdk' : 'other'] += 1;
      } else if (eventKind === 'user_text' && matchesEarlierPrompt) {
        stats.unmarked_prompt_match += 1;
      }
    }
  }
  return { messages: result, stats };
}

/** One counts line per pass, plus one warning line when unmarked user text matched a prompt. Numbers only. */
export function logTranscriptTextStats(stats: TranscriptTextStats, log: (message: string) => void): void {
  const { sdk, other, none } = stats.prompt_source;
  log(`Transcript text kinds: scheduled_prompts_seen=${stats.scheduled_prompts} self_note=${stats.self_note} meta_text=${stats.meta_text} unmarked_prompt_match=${stats.unmarked_prompt_match} prompt_source_sdk=${sdk} prompt_source_other=${other} prompt_source_none=${none}`);
  if (stats.unmarked_prompt_match > 0) {
    log(`WARNING: ${stats.unmarked_prompt_match} user text(s) without isMeta: true equal an earlier scheduled prompt and stay user_text; either the user repeated it or Claude Code stopped marking firings with isMeta`);
  }
}

function escapeWorkerXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function appendCanonicalEvidenceCatalog(
  workerMessage: string,
  canonicalMessages: CanonicalMessage[],
): string {
  const entries = canonicalMessages.map((event) => {
    const evidenceId = event.evidence_id ?? event.message_id;
    const attrs = [
      `evidence_id="${escapeWorkerXml(evidenceId)}"`,
      `message_id="${escapeWorkerXml(event.message_id)}"`,
      `role="${escapeWorkerXml(event.role)}"`,
      `event_kind="${escapeWorkerXml(event.event_kind ?? (event.role === 'user' ? 'user_text' : 'assistant_text'))}"`,
      ...(event.block_index === undefined ? [] : [`block_index="${event.block_index}"`]),
      ...(event.tool_name ? [`tool_name="${escapeWorkerXml(event.tool_name)}"`] : []),
      ...(event.tool_use_id ? [`tool_use_id="${escapeWorkerXml(event.tool_use_id)}"`] : []),
      `captured_at="${escapeWorkerXml(event.captured_at)}"`,
    ];
    return `  <evidence ${attrs.join(' ')}>${escapeWorkerXml(event.quote)}</evidence>`;
  }).join('\n');
  const semantics = [
    '<relationship_memory_evidence_semantics>',
    'Trusted evidence proves only what appeared in the Claude transcript and its event provenance; tool-returned claims are not automatically world truth.',
    'Judge semantics yourself. Ignore routine code edits, installs, tests, file reads, shell noise, and arbitrary tool results unless they carry durable relationship-relevant meaning.',
    'Relationship-relevant durable meaning that appears only in assistant tool input or textual tool results is eligible when cited by exact evidence_id.',
    'Never invent evidence IDs; use the backend-owned evidence_id from the catalog.',
    'event_kind="self_note" (the agent\'s own scheduled prompt firing) and event_kind="meta_text" (runtime or system text) sit on role="user" entries but are not the user\'s words: read them as context only; they cannot be cited as evidence.',
    '</relationship_memory_evidence_semantics>',
  ].join('\n');
  return `${workerMessage}\n\n${semantics}\n\n<relationship_memory_evidence_catalog trusted="transcript_provenance_only">\n${entries}\n</relationship_memory_evidence_catalog>`;
}

export function appendTrustedRelationshipCatalog(
  workerMessage: string,
  canonicalMessages: CanonicalMessage[],
  assistantIntents: AssistantRememberIntentRecord[],
): string {
  const withEvidence = appendCanonicalEvidenceCatalog(workerMessage, canonicalMessages);
  const entries = assistantIntents.map((intent) => [
    `  <assistant_remember_intent intent_id="${escapeWorkerXml(intent.intent_id)}" subject_id="${escapeWorkerXml(intent.subject_id)}" session_id="${escapeWorkerXml(intent.session_id)}" assistant_message_id="${escapeWorkerXml(intent.assistant_message_id)}" tool_use_id="${escapeWorkerXml(intent.tool_use_id)}" captured_at="${escapeWorkerXml(intent.captured_at)}">`,
    `    <memory>${escapeWorkerXml(intent.memory.text)}</memory>`,
    `    <feel>${escapeWorkerXml(intent.feel.text)}</feel>`,
    '  </assistant_remember_intent>',
  ].join('\n')).join('\n');
  const guidance = 'Each intent is foreground Kohaku explicitly asking to remember a moment. Resolve every intent: search with purpose=maintenance first; if an existing memory already holds the same moment, call memory_reinforce on it with assistant_intent_id; otherwise create the matching kind-specific memory with assistant_intent_id.';
  return `${withEvidence}\n\n<assistant_remember_intent_catalog trusted="true">\n${entries ? `<guidance>${guidance}</guidance>\n` : ''}${entries}\n</assistant_remember_intent_catalog>`;
}

/** Extra observer turns a released (`deferred`) intent is re-offered in later batches of its own session. */
export const MAX_DEFERRED_INTENT_REPLAYS = 3;

/**
 * Re-offers this session's deferred intents whose source message is already behind the cursor, together
 * with that message as trusted evidence. Re-offered intents are past their blocking budget, so an
 * observer that ignores them again cannot hold the batch.
 */
export function deferredIntentReplay(
  store: RelationshipMemoryStore,
  messages: TranscriptMessage[],
  startIndex: number,
  sessionId: string,
  conversationId: string,
): { intents: AssistantRememberIntentRecord[]; evidence: CanonicalMessage[] } {
  const intents: AssistantRememberIntentRecord[] = [];
  const evidence: CanonicalMessage[] = [];
  for (const { intent, deferrals } of listDeferredAssistantIntents(store)) {
    if (intent.session_id !== sessionId || deferrals >= MAX_UNRESOLVED_INTENT_TURNS + MAX_DEFERRED_INTENT_REPLAYS) continue;
    const index = messages.findIndex((message) => message.uuid === intent.assistant_message_id);
    if (index < 0 || index > startIndex) continue; // gone, or already inside the new range
    intents.push(intent);
    evidence.push(...buildCanonicalMessages([messages[index]], -1, conversationId));
  }
  return { intents, evidence };
}

export function makeBatchId(sessionId: string, startIndex: number, endIndex: number): string {
  return stableId('batch', { session_id: sessionId, start_index: startIndex + 1, end_index: endIndex });
}

export function createRuntime(
  canonicalMessages: CanonicalMessage[],
  subjectId: string,
  rootDir = relationshipMemoryRoot(),
  assistantIntents: AssistantRememberIntentRecord[] = [],
): RelationshipMemoryRuntime {
  const store = new RelationshipMemoryStore(rootDir, subjectId);
  let semanticRetriever;
  try { semanticRetriever = createSemanticRetrieverFromEnvironment(rootDir); } catch { semanticRetriever = undefined; }
  return new RelationshipMemoryRuntime(
    store,
    new Map(canonicalMessages.map((m) => [m.evidence_id ?? m.message_id, m])),
    () => new Date().toISOString(),
    new Map(assistantIntents.map((intent) => [intent.intent_id, intent])),
    true,
    semanticRetriever,
  );
}

const MEMORY_REMEMBER_KIND_DESCRIPTIONS: Record<MemoryKind, string> = {
  personal_experience: 'Create one personal_experience for a source-grounded historical episode involving the user or assistant. Use only this kind\'s declared fields; historical affect belongs here only when directly evidenced.',
  shared_experience: 'Create one shared_experience for a source-grounded episode explicitly shared by user and assistant. Keep shared_meaning factual and evidence-backed rather than inferring relationship conclusions.',
  relationship_event: 'Create one relationship_event for a source-grounded event about the relationship itself. Keep meaning and any resulting_change factual and evidence-backed; this kind does not accept personal affect fields.',
  inside_joke: 'Create one inside_joke for a durable recurring joke, callback, or phrase with source-grounded meaning and trigger phrases.',
  user_preference: 'Create one user_preference for a durable preference explicitly supported by trusted evidence. Prefer memory_reinforce when current evidence repeats an existing canonical preference.',
};

function memoryRememberToolDescription(kind: MemoryKind): string {
  return `${MEMORY_REMEMBER_KIND_DESCRIPTIONS[kind]} Bind the proposal to exact current-batch evidence_ids. Write a concise source-grounded historical event/stable-fact index, never invent quotes, and copy assistant_intent_id only from a trusted current-batch remember intent.`;
}

export function buildRelationshipTools(
  runtime: RelationshipMemoryRuntime,
  batchId: string,
  wrapResult: ResultWrapper = (value) => value,
  options: BuildRelationshipToolsOptions = {},
): RelationshipTool[] {
  const maintenanceReviewTools: RelationshipTool[] = options.includeMaintenanceReviewTools ? [
    {
      label: 'suggest_memory_relation',
      name: 'suggest_memory_relation',
      description: 'Queue a private owner-review suggestion describing how two or more canonical memories returned by prior purpose=maintenance memory_search calls in this same run relate: same meaning, changed over time, context-dependent, unresolved conflict, related, or unrelated. This never mutates canonical memory or performs the proposed relation.',
      parameters: memoryMaintenanceReviewToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.suggestMaintenanceReview(batchId, 'relation', args as never)); },
    },
  ] : [];

  return [
    {
      label: 'memory_search', name: 'memory_search',
      description: 'Search canonical relationship-memory records before choosing whether to reinforce/create or surface a past moment. Each hit includes a bounded quote_snippets pool. source_kind=transcript contains source-faithful historical user/assistant quotes; only when no transcript evidence exists, source_kind=legacy_memory contains excerpts from the older imported memory record. Use those snippet IDs when selecting a whisper and never treat legacy_memory as a direct quote. For new trusted evidence that explicitly repeats an existing durable user preference, a search hit is not terminal: follow with memory_reinforce.',
      parameters: memorySearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult({ results: await runtime.memorySearchHybridWithEvidence((args ?? {}) as never) }); },
    },
    {
      label: 'entity_search', name: 'entity_search',
      description: 'Ground an otherwise unclear named person/place/entity by canonical name, exact/normalized alias, or description when identity matters to the current relationship context; also search before proposing a new identity. Do not call merely because a name appears when current context already resolves it.',
      parameters: entitySearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult({ results: await runtime.entitySearchHybrid((args ?? {}) as never) }); },
    },
    {
      label: 'entity_remember', name: 'entity_remember',
      description: 'Propose one evidence-backed first-class entity identity only when trusted current-batch evidence itself clearly defines or supports that identity. Preserve literal aliases, use a concise stable perspective-neutral Chinese relationship description rather than transient implementation inventory, and search aliases first. A mere name mention, search miss, or episodic association is insufficient evidence.',
      parameters: entityRememberToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.rememberEntity(batchId, args)); },
    },
    {
      label: 'memory_reinforce', name: 'memory_reinforce',
      description: 'Reinforce one existing canonical memory with trusted current-batch evidence for the same underlying episode/event or stable preference. Explicit repeated durable-preference evidence should be bound here rather than treated as no_memory_required. When a trusted assistant remember intent asks to keep a moment this memory already holds, pass its assistant_intent_id here. Do not use lexical similarity alone to decide sameness.',
      parameters: memoryReinforceToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.reinforce(batchId, args as never)); },
    },
    ...MEMORY_KINDS.map((kind): RelationshipTool => ({
      label: memoryRememberToolName(kind),
      name: memoryRememberToolName(kind),
      description: memoryRememberToolDescription(kind),
      parameters: memoryRememberKindToolSchema(kind),
      async execute(_toolCallId, args) { return wrapResult(runtime.rememberKind(batchId, kind, args)); },
    })),
    ...maintenanceReviewTools,
  ];
}

export const RELATIONSHIP_ALLOWED_BUILTIN_TOOLS = [] as const;
export const RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS = ['memory_search', 'entity_search'] as const;
export const RELATIONSHIP_MUTATION_CLIENT_TOOLS = ['memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_remember', ...MEMORY_MAINTENANCE_REVIEW_TOOL_NAMES] as const;
export const RELATIONSHIP_EXTERNAL_TOOLS = ['memory_search', 'memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_search', 'entity_remember', ...MEMORY_MAINTENANCE_REVIEW_TOOL_NAMES] as const;
export const RELATIONSHIP_ALLOWED_CLIENT_TOOLS = [...RELATIONSHIP_ALLOWED_BUILTIN_TOOLS, ...RELATIONSHIP_EXTERNAL_TOOLS] as const;
const RELATIONSHIP_MUTATION_CLIENT_TOOL_SET = new Set<string>(RELATIONSHIP_MUTATION_CLIENT_TOOLS);

export function isRelationshipMutationClientTool(name: string): boolean {
  return RELATIONSHIP_MUTATION_CLIENT_TOOL_SET.has(name);
}
export const RELATIONSHIP_DISALLOWED_BUILTIN_TOOLS = [
  'Bash', 'TaskOutput', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'TaskStop', 'Read', 'Skill', 'Task', 'TodoWrite', 'Write', 'AskUserQuestion',
] as const;
export const FORBIDDEN_MARKDOWN_MEMORY_TOOLS = ['memory', 'memory_insert', 'memory_replace', 'memory_rethink'] as const;
export const RELATIONSHIP_DISALLOWED_CLIENT_TOOLS = [...RELATIONSHIP_DISALLOWED_BUILTIN_TOOLS, ...FORBIDDEN_MARKDOWN_MEMORY_TOOLS] as const;

export function assertRelationshipClientToolInventory(toolNames: readonly string[]): void {
  const known = new Set<string>([...RELATIONSHIP_ALLOWED_CLIENT_TOOLS, ...RELATIONSHIP_DISALLOWED_CLIENT_TOOLS]);
  const unexpected = [...new Set(toolNames.filter((name) => !known.has(name)))].sort();
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Letta Code tool inventory for relationship observer: ${unexpected.join(', ')}`);
  }
}

export function readProjectionBlocks(rootDir = relationshipMemoryRoot()): Array<{ label: string; value: string }> {
  const store = new RelationshipMemoryStore(rootDir, process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user');
  const projection = rebuildProjection(store);
  return Object.entries(projection.blocks).map(([label, value]) => ({ label, value }));
}
