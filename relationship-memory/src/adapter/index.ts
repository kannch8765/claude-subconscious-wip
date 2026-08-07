import * as os from 'os';
import * as path from 'path';
import type { TranscriptMessage } from '../../../scripts/transcript_utils.js';
import { extractAllContent } from '../../../scripts/transcript_utils.js';
import type { CanonicalMessage, ParticipantRole } from '../schema/index.js';
import { RelationshipMemoryStore, stableId } from '../store/index.js';
import { memoryRememberToolSchema, memorySearchToolSchema, RelationshipMemoryRuntime } from '../tools/index.js';
import { rebuildProjection } from '../projection/index.js';

export interface RelationshipTool {
  label: string;
  name: 'memory_search' | 'memory_remember';
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

export function makeBatchId(sessionId: string, startIndex: number, endIndex: number): string {
  return stableId('batch', { session_id: sessionId, start_index: startIndex + 1, end_index: endIndex });
}

export function createRuntime(
  canonicalMessages: CanonicalMessage[],
  subjectId: string,
  rootDir = relationshipMemoryRoot(),
): RelationshipMemoryRuntime {
  const store = new RelationshipMemoryStore(rootDir, subjectId);
  return new RelationshipMemoryRuntime(store, new Map(canonicalMessages.map((m) => [m.message_id, m])));
}

export function buildRelationshipTools(
  runtime: RelationshipMemoryRuntime,
  batchId: string,
  wrapResult: ResultWrapper = (value) => value,
): RelationshipTool[] {
  return [
    {
      label: 'memory_search', name: 'memory_search',
      description: 'Search canonical relationship-memory records before proposing a new record.',
      parameters: memorySearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult({ results: runtime.memorySearch((args ?? {}) as never) }); },
    },
    {
      label: 'memory_remember', name: 'memory_remember',
      description: 'Propose one schema-version-1 relationship memory bound to trusted transcript evidence.',
      parameters: memoryRememberToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.remember(batchId, args)); },
    },
  ];
}

export const RELATIONSHIP_ALLOWED_CLIENT_TOOLS = ['Read', 'Grep', 'Glob', 'memory_search', 'memory_remember'] as const;
export const FORBIDDEN_MARKDOWN_MEMORY_TOOLS = ['memory', 'memory_insert', 'memory_replace', 'memory_rethink'] as const;

export function readProjectionBlocks(rootDir = relationshipMemoryRoot()): Array<{ label: string; value: string }> {
  const store = new RelationshipMemoryStore(rootDir, process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user');
  const projection = rebuildProjection(store);
  return Object.entries(projection.blocks).map(([label, value]) => ({ label, value }));
}
