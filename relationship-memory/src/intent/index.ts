import type { TranscriptMessage } from '../../../scripts/transcript_utils.js';
import type { AssistantIntentOutcome, AssistantRememberIntentRecord } from '../schema/index.js';
import { RelationshipMemoryStore, stableId } from '../store/index.js';

export const ASSISTANT_REMEMBER_TOOL_NAME = 'mcp__plugin_claude-subconscious_relationship-memory-intent__remember';
const ACCEPTED_TOOL_NAMES = new Set([
  ASSISTANT_REMEMBER_TOOL_NAME,
  'mcp__plugin_claude-subconscious_relationship_memory_intent__remember',
]);

export interface RememberIntentInput {
  memory: { text: string };
  feel: { text: string };
}

export interface RememberIntentValidation {
  ok: boolean;
  value?: RememberIntentInput;
  code?: 'invalid_schema' | 'invalid_memory' | 'invalid_feel';
  reason?: string;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactTextObject(value: unknown): { text: string } | null {
  if (!plainObject(value) || Object.keys(value).some((key) => key !== 'text')) return null;
  if (typeof value.text !== 'string' || !value.text.trim()) return null;
  return { text: value.text };
}

export function validateRememberIntentInput(input: unknown): RememberIntentValidation {
  if (!plainObject(input) || Object.keys(input).some((key) => key !== 'memory' && key !== 'feel')) {
    return { ok: false, code: 'invalid_schema', reason: 'remember input must contain only memory and feel objects.' };
  }
  const memory = exactTextObject(input.memory);
  if (!memory) return { ok: false, code: 'invalid_memory', reason: 'memory.text must be a non-empty string.' };
  const feel = exactTextObject(input.feel);
  if (!feel) return { ok: false, code: 'invalid_feel', reason: 'feel.text must be a non-empty string.' };
  return { ok: true, value: { memory, feel } };
}

export function isAssistantRememberToolName(name: unknown): name is string {
  return typeof name === 'string' && ACCEPTED_TOOL_NAMES.has(name);
}

export function extractAssistantRememberIntents(
  messages: TranscriptMessage[],
  startIndex: number,
  sessionId: string,
  subjectId: string,
): AssistantRememberIntentRecord[] {
  const result: AssistantRememberIntentRecord[] = [];
  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.type !== 'assistant' || !message.uuid) continue;
    const content = message.message?.content ?? message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.id || !isAssistantRememberToolName(block.name)) continue;
      const validation = validateRememberIntentInput(block.input);
      if (!validation.ok || !validation.value) continue;
      const intentId = stableId('intent', {
        subject_id: subjectId,
        session_id: sessionId,
        assistant_message_id: message.uuid,
        tool_use_id: block.id,
      });
      result.push({
        schema_version: 1,
        intent_id: intentId,
        subject_id: subjectId,
        session_id: sessionId,
        assistant_message_id: message.uuid,
        tool_use_id: block.id,
        tool_name: block.name,
        memory: { text: validation.value.memory.text },
        feel: { text: validation.value.feel.text },
        captured_at: message.timestamp || new Date(0).toISOString(),
      });
    }
  }
  return result;
}

export function persistAssistantRememberIntents(
  store: RelationshipMemoryStore,
  intents: AssistantRememberIntentRecord[],
): AssistantRememberIntentRecord[] {
  for (const intent of intents) store.appendAssistantIntent(intent);
  return intents;
}

/** `deferred` outcomes per intent, counted in one pass over the outcome log. */
export function deferredIntentCounts(outcomes: readonly AssistantIntentOutcome[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.outcome === 'deferred') counts.set(outcome.intent_id, (counts.get(outcome.intent_id) ?? 0) + 1);
  }
  return counts;
}

export interface DeferredAssistantIntent {
  intent: AssistantRememberIntentRecord;
  deferrals: number;
  last_deferred_at: string;
}

/** Intents whose latest outcome is `deferred`: released without a memory and still waiting to be resolved. */
export function listDeferredAssistantIntents(store: RelationshipMemoryStore): DeferredAssistantIntent[] {
  const outcomes = store.listAssistantIntentOutcomes();
  const counts = deferredIntentCounts(outcomes);
  const latest = new Map(outcomes.map((outcome) => [outcome.intent_id, outcome]));
  const result: DeferredAssistantIntent[] = [];
  for (const intent of store.listAssistantIntents()) {
    const outcome = latest.get(intent.intent_id);
    if (outcome?.outcome !== 'deferred') continue;
    latest.delete(intent.intent_id); // first durable copy wins
    result.push({ intent, deferrals: counts.get(intent.intent_id) ?? 0, last_deferred_at: outcome.recorded_at });
  }
  return result.sort((a, b) => a.intent.captured_at.localeCompare(b.intent.captured_at) || a.intent.intent_id.localeCompare(b.intent.intent_id));
}
