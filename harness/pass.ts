/**
 * One async pass of the own harness (docs/specs/OWN-HARNESS-DESIGN.md §3, §4).
 *
 * Stateless: the context is rebuilt from the batch and session state on every pass.
 * One memory_search view feeds whisper and upkeep (known memories are flagged, not
 * hidden); mutations go through the unchanged RelationshipMemoryRuntime, and the
 * ledger (finalizeBatch) decides the batch outcome.
 */
import type { AssistantRememberIntentRecord, BatchCompletion, CanonicalMessage, MemoryKind } from '../relationship-memory/src/schema/index.js';
import { MEMORY_KINDS, MEMORY_KIND_DEFINITIONS, MEMORY_RELATION_KINDS } from '../relationship-memory/src/schema/index.js';
import type { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { chat, type ChatMessage, type ChatResult, type ChatTool, type ChatTransport } from './llm.js';
import { isKnown, slimMemory, SnippetHandles } from './view.js';

export interface PassInput {
  batchId: string;
  sessionId: string;
  latestUserMessage: string;
  canonicalMessages: CanonicalMessage[];
  assistantIntents: AssistantRememberIntentRecord[];
  sessionKnownMemoryIds: string[];
  recentSeen: Array<{ memory_id: string; summary: string }>;
  sessionCard?: string;
}

export interface PassConfig {
  model: string;
  maxSteps: number;
  reasoningEffort?: string;
  maxSearchQueries?: number;
}

export interface StepTrace {
  step: number;
  ms: number;
  attempts: number;
  status: number;
  error_class: string;
  prompt_tokens?: number;
  cached_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  prompt_chars: number;
  tool_calls: string[];
}

export interface PassDecisions {
  whisper?: { memory_id: string; snippet_ids: string[] };
  whisper_skipped?: boolean;
  reinforce: Array<{ memory_id: string; outcome?: string; rejection_code?: string; evidence_ids: string[]; assistant_intent_id?: string }>;
  remember: Array<{ kind: string; outcome?: string; memory_id?: string; rejection_code?: string; assistant_intent_id?: string }>;
  relations: Array<{ outcome?: string }>;
  entities: number;
  searches: number;
  search_queries: number;
}

export interface PassResult {
  succeeded: boolean;
  completion: BatchCompletion;
  steps: StepTrace[];
  decisions: PassDecisions;
  tool_errors: Array<{ name: string; message: string }>;
  surfaced_memory_ids: string[];
}

const SYSTEM_PROMPT = `You are the background subconscious layer of Kohaku (琥珀). After each foreground turn you read the new transcript batch once and do two jobs in this one pass, in as few steps as possible.

IDENTITY: You and foreground Kohaku are two layers of the same Kohaku. Think from Kohaku's perspective; when the user's established identity is 猫, call the user 猫. Your prose is private and never reaches the foreground.

JOB 1, WHISPER (decide every pass): surface an old memory only when it would add something Kohaku would not bring up on her own: a shared moment, a running joke, a promise, a person or place with history, a past feeling about the same thing. Skip routine work, logistics, code, tool output, and memories that merely restate what is being said right now. When one fits, call deliver_whisper once with one memory_id from the eligible list and 1-3 of its quote numbers (n). Memories under known_do_not_whisper are never whispered (Kohaku already has them). The runtime renders the whisper from the stored summary and quotes; you write no whisper prose and never explain why it matters, what it means now, or how anyone should feel. Otherwise call skip_whisper. Every pass ends with exactly one of deliver_whisper or skip_whisper.

JOB 2, UPKEEP (silent): decide whether trusted evidence in this batch
- supports an existing memory -> memory_reinforce,
- is a genuinely new durable memory -> memory_remember with the matching kind,
- or needs nothing (routine work, code, tool noise, small talk) -> do nothing.
Every remember intent in the catalog must be resolved this pass by exactly one call carrying its assistant_intent_id: memory_reinforce on the existing memory that already holds that moment, otherwise memory_remember. Never put the same intent id on two calls, and never resolve an intent without its id. An intent marked already_linked_to is resolved by memory_reinforce on exactly that memory.
When two or more current memories you saw this pass or in the recently seen list relate (duplicate meaning, changed over time, context-dependent, conflict, related, unrelated), you may call suggest_memory_relation. It only proposes; it never merges.

EVIDENCE: cite only evidence_id values from the evidence catalog of this batch. Tool-returned claims are not world truth. New memory summaries and narrative payload text are written in Chinese; names, aliases, trigger phrases, code, paths and URLs stay as in the source. Never invent quotes, IDs or identities.

SEARCH: call memory_search once with 1-3 short concept queries (names, topics, events from the conversation, not the whole message). One result list serves both jobs. Search again only if the first results clearly miss what the conversation is about.

ENTITIES: use entity_search only when a named referent matters and is not resolved by the batch; entity_remember only when this batch itself clearly defines the identity.

STEPS: step 1 = search (plus anything already decidable). Step 2 = all decisions together as parallel tool calls, always including deliver_whisper or skip_whisper. That ends the pass.`;

function remembersDescription(): string {
  const lines = MEMORY_KINDS.map((kind) => {
    const fields = Object.entries(MEMORY_KIND_DEFINITIONS[kind].fields as Record<string, { valueType: string; required: boolean }>)
      .map(([name, def]) => `${name}${def.required ? '*' : ''}${def.valueType === 'string_array' ? '[]' : ''}`);
    return `- ${kind}: ${fields.join(', ')}`;
  });
  return `Create one new canonical memory. payload holds only the fields of the chosen kind (* = required, [] = string list):\n${lines.join('\n')}\nrelationship_event takes no personal affect fields. user_preference: prefer memory_reinforce when the preference already exists.`;
}

const stringList = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } };

export function harnessTools(): ChatTool[] {
  const fn = (name: string, description: string, parameters: Record<string, unknown>): ChatTool => ({ type: 'function', function: { name, description, parameters } });
  return [
    fn('memory_search', 'Search canonical relationship memories. Each hit appears once, under eligible (may be whispered) or known_do_not_whisper (Kohaku already has it this session; still fine for upkeep). Quotes: n = number for deliver_whisper, r = u/a/legacy, d = date.', {
      type: 'object', additionalProperties: false, required: ['queries'],
      properties: {
        queries: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1 } },
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Per query, default 8.' },
      },
    }),
    fn('deliver_whisper', 'Surface one memory from the eligible list for the next foreground turn, with 1-3 of its quote numbers. At most once per pass.', {
      type: 'object', additionalProperties: false, required: ['memory_id', 'quotes'],
      properties: { memory_id: { type: 'string', minLength: 1 }, quotes: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 1 } } },
    }),
    fn('skip_whisper', 'Record that no memory is worth surfacing this pass.', { type: 'object', additionalProperties: false, properties: {} }),
    fn('memory_reinforce', 'Add evidence from this batch to an existing memory that holds the same moment or fact.', {
      type: 'object', additionalProperties: false, required: ['memory_id', 'evidence_ids'],
      properties: { memory_id: { type: 'string', minLength: 1 }, evidence_ids: stringList, assistant_intent_id: { type: 'string', minLength: 1 } },
    }),
    fn('memory_remember', remembersDescription(), {
      type: 'object', additionalProperties: false, required: ['kind', 'summary', 'participants', 'evidence_ids', 'payload'],
      properties: {
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        summary: { type: 'string', minLength: 1, description: 'Concise source-grounded index of what happened or was stated (Chinese).' },
        participants: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'assistant'] } },
        evidence_ids: stringList,
        payload: { type: 'object' },
        linked_memory_ids: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        assistant_intent_id: { type: 'string', minLength: 1 },
      },
    }),
    fn('suggest_memory_relation', 'Propose a relation between 2-8 current memories for owner review.', {
      type: 'object', additionalProperties: false, required: ['memory_ids', 'relation', 'reason'],
      properties: {
        memory_ids: { type: 'array', minItems: 2, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        relation: { type: 'string', enum: [...MEMORY_RELATION_KINDS] },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    }),
    fn('entity_search', 'Look up a stable identity (person, pet, project...) by name or alias.', {
      type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
    }),
    fn('entity_remember', 'Record a stable identity that this batch clearly defines.', {
      type: 'object', additionalProperties: false, required: ['canonical_name', 'aliases', 'entity_type', 'description', 'evidence_ids'],
      properties: {
        canonical_name: { type: 'string', minLength: 1 },
        aliases: stringList,
        entity_type: { type: 'string', enum: ['user', 'assistant', 'other'] },
        description: { type: 'string', minLength: 1, description: 'Short perspective-neutral Chinese description.' },
        evidence_ids: stringList,
      },
    }),
  ];
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildUserMessage(input: PassInput, linkedMemoryFor: (intentId: string) => string | undefined = () => undefined): string {
  const parts: string[] = [];
  if (input.sessionCard?.trim()) parts.push(`<session_card>\n${esc(input.sessionCard.trim())}\n</session_card>`);
  if (input.recentSeen.length) {
    parts.push(`<recently_seen>\n${input.recentSeen.map((m) => `${m.memory_id}: ${esc(m.summary)}`).join('\n')}\n</recently_seen>`);
  }
  if (input.assistantIntents.length) {
    parts.push(`<remember_intents>\n${input.assistantIntents.map((intent) =>
      `<intent id="${esc(intent.intent_id)}"${linkedMemoryFor(intent.intent_id) ? ` already_linked_to="${esc(linkedMemoryFor(intent.intent_id)!)}"` : ''}><memory>${esc(intent.memory.text)}</memory><feel>${esc(intent.feel.text)}</feel></intent>`).join('\n')}\n</remember_intents>`);
  }
  parts.push(`<evidence_catalog>\n${input.canonicalMessages.map((m) => {
    const id = m.evidence_id ?? m.message_id;
    const kind = m.event_kind && m.event_kind !== 'user_text' && m.event_kind !== 'assistant_text' ? ` kind="${esc(m.event_kind)}"${m.tool_name ? ` tool="${esc(m.tool_name)}"` : ''}` : '';
    return `<e id="${esc(id)}" role="${m.role}"${kind} at="${(m.captured_at ?? '').slice(0, 16)}">${esc(m.quote)}</e>`;
  }).join('\n')}\n</evidence_catalog>`);
  parts.push(`<latest_user_message>\n${esc(input.latestUserMessage)}\n</latest_user_message>`);
  return parts.join('\n\n');
}

const DECISION_TOOLS = new Set(['deliver_whisper', 'skip_whisper', 'memory_reinforce', 'memory_remember', 'suggest_memory_relation', 'entity_remember']);

function parseArgs(raw: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function runAsyncPass(
  runtime: RelationshipMemoryRuntime,
  transport: ChatTransport,
  input: PassInput,
  config: PassConfig,
): Promise<PassResult> {
  const tools = harnessTools();
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  const handles = new SnippetHandles();
  const known = new Set(input.sessionKnownMemoryIds);
  const surfaced = new Set<string>();
  const recent = new Set(input.recentSeen.map((m) => m.memory_id));
  const decisions: PassDecisions = { reinforce: [], remember: [], relations: [], entities: 0, searches: 0, search_queries: 0 };
  const toolErrors: PassResult['tool_errors'] = [];
  const steps: StepTrace[] = [];
  const hasUser = Boolean(input.latestUserMessage.trim());

  runtime.store.beginBatch(input.batchId, new Date().toISOString());
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMessage(input, (id) => runtime.store.getTerminalAssistantIntentOutcome(id)?.memory_id) }];
  let succeeded = false;
  let nudged = false;
  const hasSearchedOrSilent = (): boolean => !hasUser || decisions.searches > 0;

  const execute = async (name: string, args: Record<string, any>): Promise<unknown> => {
    switch (name) {
      case 'memory_search': {
        const queries: string[] = (Array.isArray(args.queries) ? args.queries : [args.query])
          .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, config.maxSearchQueries ?? 3);
        if (!queries.length) throw new Error('memory_search needs 1-3 non-empty queries');
        decisions.searches++;
        decisions.search_queries += queries.length;
        const lists = await Promise.all(queries.map((query) => runtime.memorySearchRecallHybridWithEvidence({ query, kind: args.kind, limit: args.limit ?? 8 } as any)));
        const seen = new Set<string>();
        const eligible = [];
        const knownHits = [];
        for (const list of lists) for (const memory of list) {
          if (seen.has(memory.memory_id)) continue;
          seen.add(memory.memory_id);
          surfaced.add(memory.memory_id);
          (isKnown(memory, known) ? knownHits : eligible).push(slimMemory(memory, handles));
        }
        return { eligible, known_do_not_whisper: knownHits };
      }
      case 'deliver_whisper': {
        if (decisions.whisper) return { status: 'already_resolved', reason: 'deliver_whisper runs at most once per pass.' };
        const memoryId = String(args.memory_id ?? '').trim();
        const numbers: number[] = Array.isArray(args.quotes) ? args.quotes.map(Number) : [];
        if (!surfaced.has(memoryId)) throw new Error('deliver_whisper may select only a memory returned by memory_search in this pass.');
        if (known.has(memoryId)) throw new Error('This memory is under known_do_not_whisper; pick one from eligible, or call skip_whisper.');
        const resolved = numbers.map((n) => handles.resolve(memoryId, n));
        if (!numbers.length || numbers.length > 3 || resolved.some((r) => !r)) {
          throw new Error(`quotes must be 1-3 quote numbers (n) listed under this memory (asked ${JSON.stringify(args.quotes)}; this memory has ${handles.count(memoryId)} quotes).`);
        }
        decisions.whisper = { memory_id: memoryId, snippet_ids: resolved as string[] };
        known.add(memoryId);
        return { status: 'ok' };
      }
      case 'skip_whisper':
        decisions.whisper_skipped = true;
        return { status: 'ok' };
      case 'memory_reinforce': {
        const result = runtime.store.withMutationBoundary(() => runtime.reinforce(input.batchId, args as any));
        decisions.reinforce.push({ memory_id: String(args.memory_id ?? ''), outcome: result.outcome, rejection_code: (result as any).rejection_code, evidence_ids: args.evidence_ids ?? [], ...(args.assistant_intent_id ? { assistant_intent_id: args.assistant_intent_id } : {}) });
        return result;
      }
      case 'memory_remember': {
        const { kind, ...rest } = args;
        if (!MEMORY_KINDS.includes(kind)) throw new Error(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
        const result = runtime.store.withMutationBoundary(() => runtime.rememberKind(input.batchId, kind as MemoryKind, rest));
        decisions.remember.push({ kind, outcome: result.outcome, memory_id: result.memory_id, rejection_code: (result as any).rejection_code, ...(args.assistant_intent_id ? { assistant_intent_id: args.assistant_intent_id } : {}) });
        if (result.outcome === 'accepted' && result.memory_id) known.add(result.memory_id);
        return result;
      }
      case 'suggest_memory_relation': {
        const ids: string[] = Array.isArray(args.memory_ids) ? args.memory_ids.map(String) : [];
        const unseen = ids.filter((id) => !surfaced.has(id) && !recent.has(id));
        if (unseen.length) throw new Error(`suggest_memory_relation may use only memories seen this pass or recently: ${unseen.join(', ')}`);
        const result = runtime.store.withMutationBoundary(() => runtime.suggestMaintenanceReview(input.batchId, 'relation', args as any));
        decisions.relations.push({ outcome: result.outcome });
        return result;
      }
      case 'entity_search':
        return { results: await runtime.entitySearchRecallHybrid(args as any) };
      case 'entity_remember': {
        decisions.entities++;
        return runtime.store.withMutationBoundary(() => runtime.rememberEntity(input.batchId, { schema_version: 1, ...args }));
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  };

  for (let step = 1; step <= config.maxSteps; step++) {
    const body = {
      model: config.model,
      messages,
      tools,
      parallel_tool_calls: true,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      temperature: 0,
      max_tokens: 4_000,
    };
    const promptChars = JSON.stringify(messages).length + JSON.stringify(tools).length;
    const result: ChatResult = await chat(transport, body, `${input.sessionId}:async`);
    const calls = result.message?.tool_calls ?? [];
    steps.push({
      step, ms: result.ms, attempts: result.attempts, status: result.status, error_class: result.errorClass,
      prompt_tokens: result.usage.prompt_tokens, cached_tokens: result.usage.cached_tokens,
      completion_tokens: result.usage.completion_tokens, reasoning_tokens: result.usage.reasoning_tokens,
      prompt_chars: promptChars, tool_calls: calls.map((call) => call.function?.name ?? '?'),
    });
    if (!result.message) break; // transport / quota / malformed: the pass fails, cursor held
    const message: ChatMessage = { role: 'assistant', content: result.message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) };
    messages.push(message);
    if (!calls.length) {
      if (hasUser && decisions.searches === 0 && !nudged) {
        nudged = true;
        messages.push({ role: 'user', content: 'Run memory_search at least once before ending this pass.' });
        continue;
      }
      succeeded = true;
      break;
    }
    const outputs = await Promise.all(calls.map(async (call) => {
      const name = call.function?.name ?? '';
      const args = parseArgs(call.function?.arguments ?? '');
      try {
        if (!toolNames.has(name)) throw new Error(`unknown tool: ${name.slice(0, 60)}`);
        if (!args) throw new Error('arguments must be a JSON object');
        return JSON.stringify(await execute(name, args));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        toolErrors.push({ name: toolNames.has(name) ? name : 'unknown', message: text.slice(0, 200) });
        return JSON.stringify({ error: text });
      }
    }));
    calls.forEach((call, index) => messages.push({ role: 'tool', tool_call_id: call.id, content: outputs[index] }));
    // A step of decisions only (nothing new to read) that all went through ends the pass without another call.
    const errorsBefore = toolErrors.length - outputs.filter((output) => output.startsWith('{"error"')).length;
    const decisionsOnly = calls.every((call) => DECISION_TOOLS.has(call.function?.name ?? ''));
    if (step === config.maxSteps || (decisionsOnly && toolErrors.length === errorsBefore && hasSearchedOrSilent())) {
      succeeded = true;
      break;
    }
  }

  const completion = runtime.store.withMutationBoundary(() => runtime.finalizeBatch(input.batchId, succeeded));
  return { succeeded, completion, steps, decisions, tool_errors: toolErrors, surfaced_memory_ids: [...surfaced] };
}
