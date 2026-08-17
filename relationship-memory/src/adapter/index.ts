import * as os from 'os';
import * as path from 'path';
import type { TranscriptMessage } from '../../../scripts/transcript_utils.js';
import type { AssistantRememberIntentRecord, CanonicalMessage, ParticipantRole, TranscriptEvidenceKind } from '../schema/index.js';
import { RelationshipMemoryStore, stableId } from '../store/index.js';
import { entityRememberToolSchema, entitySearchToolSchema, memoryRememberToolSchema, memoryReinforceToolSchema, memorySearchToolSchema, RelationshipMemoryRuntime } from '../tools/index.js';
import { rebuildProjection } from '../projection/index.js';
import { createSemanticRetrieverFromEnvironment } from '../retrieval/index.js';

export interface RelationshipTool {
  label: string;
  name: 'memory_search' | 'memory_remember' | 'memory_reinforce' | 'entity_search' | 'entity_remember';
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, args: unknown): Promise<unknown>;
}

export type ResultWrapper = (value: unknown) => unknown;

export function relationshipMemoryRoot(): string {
  return process.env.RELATIONSHIP_MEMORY_DIR || path.join(os.homedir(), '.local', 'share', 'relationship-memory');
}

const MAX_TRANSCRIPT_EVIDENCE_CHARS = 12_000;

function boundedEvidenceText(value: unknown): string | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
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

export function buildCanonicalMessages(
  messages: TranscriptMessage[],
  startIndex: number,
  conversationId: string,
): CanonicalMessage[] {
  const result: CanonicalMessage[] = [];
  const toolNames = new Map<string, string>();
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

      if (block?.type === 'text') {
        eventKind = role === 'user' ? 'user_text' : 'assistant_text';
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
    }
  }
  return result;
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
  return `${withEvidence}\n\n<assistant_remember_intent_catalog trusted="true">\n${entries}\n</assistant_remember_intent_catalog>`;
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

export function buildRelationshipTools(
  runtime: RelationshipMemoryRuntime,
  batchId: string,
  wrapResult: ResultWrapper = (value) => value,
): RelationshipTool[] {
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
      description: 'Reinforce one existing canonical memory with trusted current-batch evidence for the same underlying episode/event or stable preference. Explicit repeated durable-preference evidence should be bound here rather than treated as no_memory_required. Do not use lexical similarity alone to decide sameness.',
      parameters: memoryReinforceToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.reinforce(batchId, args as never)); },
    },
    {
      label: 'memory_remember', name: 'memory_remember',
      description: 'Propose one schema-version-1 relationship memory bound to trusted transcript evidence. Write a source-grounded historical event/stable-fact index, not a relationship essay: summarize what happened or what was explicitly stated, and do not infer feelings, motives, fulfillment, present-day meaning, or relationship conclusions. Historical affect may be represented only when directly evidenced. Never invent quotes. When processing a trusted assistant remember intent, copy its assistant_intent_id; never invent or rewrite feel text.',
      parameters: memoryRememberToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.remember(batchId, args)); },
    },
  ];
}

export const RELATIONSHIP_ALLOWED_BUILTIN_TOOLS = [] as const;
export const RELATIONSHIP_EXTERNAL_TOOLS = ['memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember'] as const;
export const RELATIONSHIP_ALLOWED_CLIENT_TOOLS = [...RELATIONSHIP_ALLOWED_BUILTIN_TOOLS, ...RELATIONSHIP_EXTERNAL_TOOLS] as const;
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
