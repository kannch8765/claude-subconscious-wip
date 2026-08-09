import * as os from 'os';
import * as path from 'path';
import type { TranscriptMessage } from '../../../scripts/transcript_utils.js';
import { extractAllContent } from '../../../scripts/transcript_utils.js';
import type { AssistantRememberIntentRecord, CanonicalMessage, ParticipantRole } from '../schema/index.js';
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

export function buildCanonicalMessages(
  messages: TranscriptMessage[],
  startIndex: number,
  conversationId: string,
): CanonicalMessage[] {
  const result: CanonicalMessage[] = [];
  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    const text = extractAllContent(message).text?.trim();
    if (!text || !message.uuid) continue;
    result.push({
      conversation_id: conversationId,
      message_id: message.uuid,
      role: message.type as ParticipantRole,
      quote: text,
      captured_at: message.timestamp || new Date(0).toISOString(),
    });
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
  const entries = canonicalMessages.map((message) =>
    `  <evidence message_id="${escapeWorkerXml(message.message_id)}" role="${escapeWorkerXml(message.role)}">${escapeWorkerXml(message.quote)}</evidence>`,
  ).join('\n');
  return `${workerMessage}\n\n<relationship_memory_evidence_catalog>\n${entries}\n</relationship_memory_evidence_catalog>`;
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
    new Map(canonicalMessages.map((m) => [m.message_id, m])),
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
      description: 'Search canonical relationship-memory records, including bounded reinforcement metadata and linked assistant remember provenance, before choosing whether to reinforce or create. For new trusted evidence that explicitly repeats an existing durable user preference, a search hit is not terminal: follow with memory_reinforce.',
      parameters: memorySearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult({ results: await runtime.memorySearchHybrid((args ?? {}) as never) }); },
    },
    {
      label: 'entity_search', name: 'entity_search',
      description: 'Search first-class canonical entity identities by canonical name, exact/normalized alias, or description before proposing an identity.',
      parameters: entitySearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult({ results: await runtime.entitySearchHybrid((args ?? {}) as never) }); },
    },
    {
      label: 'entity_remember', name: 'entity_remember',
      description: 'Propose one evidence-backed first-class entity identity. Preserve literal aliases, use a perspective-neutral Chinese description, and search aliases first.',
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
      description: 'Propose one schema-version-1 relationship memory bound to trusted transcript evidence, including a new explicit durable user_preference when search finds no same preference. When processing a trusted assistant remember intent, copy its assistant_intent_id; never invent or rewrite feel text.',
      parameters: memoryRememberToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.remember(batchId, args)); },
    },
  ];
}

export const RELATIONSHIP_ALLOWED_CLIENT_TOOLS = ['Read', 'Grep', 'Glob', 'memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember'] as const;
export const FORBIDDEN_MARKDOWN_MEMORY_TOOLS = ['memory', 'memory_insert', 'memory_replace', 'memory_rethink'] as const;

export function readProjectionBlocks(rootDir = relationshipMemoryRoot()): Array<{ label: string; value: string }> {
  const store = new RelationshipMemoryStore(rootDir, process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user');
  const projection = rebuildProjection(store);
  return Object.entries(projection.blocks).map(([label, value]) => ({ label, value }));
}
