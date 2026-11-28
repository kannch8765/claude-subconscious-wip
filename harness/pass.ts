/**
 * One async pass of the own harness (docs/specs/OWN-HARNESS-DESIGN.md §3, §4).
 *
 * Stateless: the context is rebuilt from the batch and session state on every pass.
 * One memory_search view feeds whisper and upkeep (known memories are flagged, not
 * hidden); mutations go through the unchanged RelationshipMemoryRuntime, and the
 * ledger (finalizeBatch) decides the batch outcome.
 */
import type { AssistantRememberIntentRecord, BatchCompletion, CanonicalMemoryKind, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { CANONICAL_MEMORY_KINDS, MEMORY_KIND_DEFINITIONS, MEMORY_RELATION_KINDS, WORLD_UPDATE_KIND } from '../relationship-memory/src/schema/index.js';
import type { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { chat, type ChatMessage, type ChatResult, type ChatTool, type ChatTransport } from './llm.js';
import { modelText } from './turn_input.js';
import { isKnown, slimMemory, SnippetHandles } from './view.js';

export interface PassInput {
  batchId: string;
  sessionId: string;
  latestUserMessage: string;
  canonicalMessages: CanonicalMessage[];
  /**
   * The whole session so far, as Kohaku sees it, ending with this pass's new messages. When given it opens the
   * prompt and only ever grows at its end, so a provider's prefix cache covers it from one pass to the next; the
   * new messages are then named by id instead of listed again. Any message in it may be cited as evidence.
   */
  conversation?: CanonicalMessage[];
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
  /** A world_update whisper carries no quotes: the runtime renders its timeline (see whisper.ts). */
  whisper?: { memory_id: string; snippet_ids: string[]; world_update?: true };
  whisper_skipped?: boolean;
  /** deliver_whisper named a session-known memory: treated as skip_whisper, like the production worker's already_known. */
  whisper_known_skip?: boolean;
  reinforce: Array<{ memory_id: string; outcome?: string; rejection_code?: string; evidence_ids: string[]; assistant_intent_id?: string }>;
  remember: Array<{ kind: string; outcome?: string; memory_id?: string; rejection_code?: string; assistant_intent_id?: string }>;
  /** memory_world_update calls: a new revision (head) on an existing world_update anchor. */
  world_updates: Array<{ memory_id: string; outcome?: string; rejection_code?: string }>;
  relations: Array<{ outcome?: string }>;
  entities: number;
  searches: number;
  search_queries: number;
  /** The query texts, for offline analysis (traces stay on the private side). */
  query_texts?: string[];
}

export interface PassResult {
  succeeded: boolean;
  completion: BatchCompletion;
  steps: StepTrace[];
  decisions: PassDecisions;
  /** `message` goes back to the model and may hold its arguments. `code` is fixed; `exception` is the class of an unexpected error. */
  tool_errors: Array<{ name: string; code: ToolErrorCode; exception?: string; message: string }>;
  surfaced_memory_ids: string[];
}

const SYSTEM_PROMPT = `You are the background subconscious layer of Kohaku (琥珀). After each foreground turn you read the new transcript batch once and do two jobs in this one pass, in as few steps as possible.

IDENTITY: You and foreground Kohaku are two layers of the same Kohaku. Think from Kohaku's perspective; when the user's established identity is 猫, call the user 猫. Your prose is private and never reaches the foreground.

JOB 1, WHISPER (decide every pass): surface an old memory only when it would add something Kohaku would not bring up on her own: a shared moment, a running joke, a promise, a person or place with history, a past feeling about the same thing, or a knowledge patch (world_update) when its topic comes up and Kohaku might otherwise use outdated knowledge. Skip routine work, logistics, code, tool output, and memories that merely restate what is being said right now. When one fits, call deliver_whisper once with one memory_id from the eligible list and 1-3 of its quote numbers (n); a world_update needs no quotes (the runtime shows its timeline). Memories under known_do_not_whisper are never whispered (Kohaku already has them); deliver_whisper on one counts as skip_whisper and the pass ends quietly. The runtime renders the whisper from the stored summary and quotes; you write no whisper prose and never explain why it matters, what it means now, or how anyone should feel. Otherwise call skip_whisper. Every pass ends with exactly one of deliver_whisper or skip_whisper.

JOB 2, UPKEEP (silent): decide whether trusted evidence in this batch
- is for the same underlying episode/event or stable preference as an existing memory -> memory_reinforce (lexical similarity alone does not make it the same),
- is a genuinely new durable memory -> memory_remember with the matching kind,
- states a new fact about the outside world (who holds an office, a company event, a product release...), told by the user or shown by a tool result -> include its topic in your search queries; the same fact as a world_update's head -> memory_reinforce with that head's world_revision_id; the fact changed -> memory_world_update; a new topic -> memory_remember with kind world_update,
- or needs nothing (routine work, code, tool noise, small talk) -> do nothing.
Every remember intent in the catalog must be resolved this pass by exactly one call carrying its assistant_intent_id: memory_reinforce on the existing memory that already holds that moment, otherwise memory_remember. Never put the same intent id on two calls, and never resolve an intent without its id. An intent marked already_linked_to is resolved by memory_reinforce on exactly that memory.
When two or more current memories you saw this pass or in the recently seen list relate (duplicate meaning, changed over time, context-dependent, conflict, related, unrelated), you may call suggest_memory_relation. It only proposes; it never merges.

EVIDENCE: cite only evidence_id values from the evidence catalog of this batch, or from <conversation> when it is given. Tool-returned claims are not world truth; a tool result may back a world_update (stored as source tool). New memory summaries and narrative payload text are written in Chinese; names, aliases, trigger phrases, code, paths and URLs stay as in the source. Never invent quotes, IDs or identities.

CONVERSATION: when <conversation> is given, it is the whole session so far, as Kohaku sees it, and <new_messages> names the messages new in this pass. Both jobs are about the new messages, read in the light of the whole conversation.

SEARCH: call memory_search once with 1-3 short concept queries (names, topics, events from the conversation, not the whole message). One result list serves both jobs. Search again only if the first results clearly miss what the conversation is about.

ENTITIES: use entity_search only when a named referent matters and is not resolved by the batch; entity_remember only when this batch itself clearly defines the identity.

STEPS: step 1 = search (plus anything already decidable). Step 2 = all decisions together as parallel tool calls, always including deliver_whisper or skip_whisper. That ends the pass.`;

function remembersDescription(): string {
  const lines = CANONICAL_MEMORY_KINDS.map((kind) => {
    const fields = Object.entries(MEMORY_KIND_DEFINITIONS[kind].fields as Record<string, { valueType: string; required: boolean }>)
      .map(([name, def]) => `${name}${def.required ? '*' : ''}${def.valueType === 'string_array' ? '[]' : ''}`);
    return `- ${kind}: ${fields.join(', ')}`;
  });
  return `Create one new canonical memory. payload holds only the fields of the chosen kind (* = required, [] = string list):\n${lines.join('\n')}\nrelationship_event takes no personal affect fields. user_preference: prefer memory_reinforce when the preference already exists. world_update: a knowledge patch (topic = what it is about, fact = what holds now); as_of (YYYY-MM-DD) = when the fact started to hold, if the evidence says.`;
}

const stringList = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } };

// The intent field exists only when the batch has intents: offered without them, models fill it with evidence ids.
const intentField = { type: 'string', minLength: 1, description: 'Only an intent id from <remember_intents>, never an evidence_id.' };

export function harnessTools(withIntents = true): ChatTool[] {
  const intent = withIntents ? { assistant_intent_id: intentField } : {};
  const fn = (name: string, description: string, parameters: Record<string, unknown>): ChatTool => ({ type: 'function', function: { name, description, parameters } });
  return [
    fn('memory_search', 'Search canonical relationship memories. Each hit appears once, under eligible (may be whispered) or known_do_not_whisper (Kohaku already has it this session; still fine for upkeep). Quotes: n = number for deliver_whisper, r = u/a/legacy, d = date. A world_update hit shows its current head under world.', {
      type: 'object', additionalProperties: false, required: ['queries'],
      properties: {
        queries: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1 } },
        kind: { type: 'string', enum: [...CANONICAL_MEMORY_KINDS] },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Per query, default 8.' },
      },
    }),
    fn('deliver_whisper', 'Surface one memory from the eligible list for the next foreground turn, with 1-3 of its quote numbers (none for a world_update). At most once per pass.', {
      type: 'object', additionalProperties: false, required: ['memory_id'],
      properties: { memory_id: { type: 'string', minLength: 1 }, quotes: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 1 } } },
    }),
    fn('skip_whisper', 'Record that no memory is worth surfacing this pass.', { type: 'object', additionalProperties: false, properties: {} }),
    fn('memory_reinforce', 'Reinforce one existing canonical memory with trusted current-batch evidence for the same underlying episode/event or stable preference. Explicit repeated durable-preference evidence should be bound here rather than treated as nothing to store. When a trusted assistant remember intent asks to keep a moment this memory already holds, pass its assistant_intent_id here. Do not use lexical similarity alone to decide sameness.', {
      type: 'object', additionalProperties: false, required: ['memory_id', 'evidence_ids'],
      properties: {
        memory_id: { type: 'string', minLength: 1 },
        evidence_ids: stringList,
        world_revision_id: { type: 'string', minLength: 1, description: 'world_update only: the revision_id of the head shown under world.' },
        ...intent,
      },
    }),
    fn('memory_remember', remembersDescription(), {
      type: 'object', additionalProperties: false, required: ['kind', 'summary', 'participants', 'evidence_ids', 'payload'],
      properties: {
        kind: { type: 'string', enum: [...CANONICAL_MEMORY_KINDS] },
        summary: { type: 'string', minLength: 1, description: 'Concise source-grounded index of what happened or was stated (Chinese).' },
        participants: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'assistant'] } },
        evidence_ids: stringList,
        payload: { type: 'object' },
        linked_memory_ids: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'world_update only, optional.' },
        ...intent,
      },
    }),
    fn('memory_world_update', 'Record that the fact of an existing world_update changed: the new fact becomes its head, the old one stays in its timeline.', {
      type: 'object', additionalProperties: false, required: ['memory_id', 'fact', 'evidence_ids'],
      properties: {
        memory_id: { type: 'string', minLength: 1 },
        fact: { type: 'string', minLength: 1, description: 'The new fact as stated (Chinese; names as in the source).' },
        as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'When the new fact started to hold, if the evidence says.' },
        evidence_ids: stringList,
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

function evidenceLine(m: CanonicalMessage): string {
  const id = m.evidence_id ?? m.message_id;
  const kind = m.event_kind && m.event_kind !== 'user_text' && m.event_kind !== 'assistant_text' ? ` kind="${esc(m.event_kind)}"${m.tool_name ? ` tool="${esc(m.tool_name)}"` : ''}` : '';
  return `<e id="${esc(id)}" role="${m.role}"${kind} at="${(m.captured_at ?? '').slice(0, 16)}">${esc(modelText(m.quote))}</e>`;
}

export function buildUserMessage(input: PassInput, linkedMemoryFor: (intentId: string) => string | undefined = () => undefined): string {
  const parts: string[] = [];
  // Stable first: everything before the end of the conversation is the same bytes as in the previous pass.
  if (input.conversation) parts.push(`<conversation>\n${input.conversation.map(evidenceLine).join('\n')}\n</conversation>`);
  if (input.sessionCard?.trim()) parts.push(`<session_card>\n${esc(input.sessionCard.trim())}\n</session_card>`);
  if (input.recentSeen.length) {
    parts.push(`<recently_seen>\n${input.recentSeen.map((m) => `${m.memory_id}: ${esc(m.summary)}`).join('\n')}\n</recently_seen>`);
  }
  if (input.assistantIntents.length) {
    parts.push(`<remember_intents>\n${input.assistantIntents.map((intent) =>
      `<intent id="${esc(intent.intent_id)}"${linkedMemoryFor(intent.intent_id) ? ` already_linked_to="${esc(linkedMemoryFor(intent.intent_id)!)}"` : ''}><memory>${esc(intent.memory.text)}</memory><feel>${esc(intent.feel.text)}</feel></intent>`).join('\n')}\n</remember_intents>`);
  }
  if (input.conversation) parts.push(`<new_messages>${input.canonicalMessages.map((m) => esc(m.evidence_id ?? m.message_id)).join(' ')}</new_messages>`);
  else parts.push(`<evidence_catalog>\n${input.canonicalMessages.map(evidenceLine).join('\n')}\n</evidence_catalog>`);
  parts.push(`<latest_user_message>\n${esc(modelText(input.latestUserMessage))}\n</latest_user_message>`);
  return parts.join('\n\n');
}

export const TOOL_ERROR_CODES = ['unknown_tool', 'invalid_arguments', 'invalid_queries', 'not_surfaced', 'known_memory', 'invalid_quotes', 'invalid_kind', 'unseen_memory', 'exception'] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** A tool call the harness refuses, with a fixed code next to the message for the model. */
class ToolCallError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) { super(message); }
}

/** The class of an unexpected error, best-effort: reading it must never cost the model its tool result. */
function exceptionClass(error: unknown): string | undefined {
  try {
    const name = error instanceof Error ? error.constructor?.name : typeof error;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

const DECISION_TOOLS = new Set(['deliver_whisper', 'skip_whisper', 'memory_reinforce', 'memory_remember', 'memory_world_update', 'suggest_memory_relation', 'entity_remember']);

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
  const tools = harnessTools(input.assistantIntents.length > 0);
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  const handles = new SnippetHandles();
  const known = new Set(input.sessionKnownMemoryIds);
  const surfaced = new Set<string>();
  const worldIds = new Set<string>();
  const recent = new Set(input.recentSeen.map((m) => m.memory_id));
  const decisions: PassDecisions = { reinforce: [], remember: [], world_updates: [], relations: [], entities: 0, searches: 0, search_queries: 0 };
  const toolErrors: PassResult['tool_errors'] = [];
  const steps: StepTrace[] = [];
  const hasUser = Boolean(input.latestUserMessage.trim());

  runtime.store.beginBatch(input.batchId, new Date().toISOString());
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMessage(input, (id) => runtime.store.getTerminalAssistantIntentOutcome(id)?.memory_id) }];
  let succeeded = false;
  let nudged = false;
  const hasSearchedOrSilent = (): boolean => !hasUser || decisions.searches > 0;
  // One completion rule for every exit: the pass searched (when there is a user message) and its last step had no
  // failed tool call.
  const complete = (lastStepFailed: boolean): boolean => hasSearchedOrSilent() && !lastStepFailed;

  const execute = async (name: string, args: Record<string, any>): Promise<unknown> => {
    switch (name) {
      case 'memory_search': {
        const queries: string[] = (Array.isArray(args.queries) ? args.queries : [args.query])
          .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, config.maxSearchQueries ?? 3);
        if (!queries.length) throw new ToolCallError('invalid_queries', 'memory_search needs 1-3 non-empty queries');
        const lists = await Promise.all(queries.map((query) => runtime.memorySearchRecallHybridWithEvidence({ query, kind: args.kind, limit: args.limit ?? 8 } as any)));
        // Counted only once the search has run.
        decisions.searches++;
        decisions.search_queries += queries.length;
        (decisions.query_texts ??= []).push(...queries.map(String));
        const seen = new Set<string>();
        const eligible = [];
        const knownHits = [];
        for (const list of lists) for (const memory of list) {
          if (seen.has(memory.memory_id)) continue;
          seen.add(memory.memory_id);
          surfaced.add(memory.memory_id);
          if (memory.kind === WORLD_UPDATE_KIND) worldIds.add(memory.memory_id);
          (isKnown(memory, known) ? knownHits : eligible).push(slimMemory(memory, handles));
        }
        return { eligible, known_do_not_whisper: knownHits };
      }
      case 'deliver_whisper': {
        if (decisions.whisper || decisions.whisper_known_skip) return { status: 'already_resolved', reason: 'deliver_whisper runs at most once per pass.' };
        const memoryId = String(args.memory_id ?? '').trim();
        const numbers: number[] = Array.isArray(args.quotes) ? args.quotes.map(Number) : [];
        if (!surfaced.has(memoryId)) throw new ToolCallError('not_surfaced', 'deliver_whisper may select only a memory returned by memory_search in this pass.');
        if (known.has(memoryId)) {
          decisions.whisper_skipped = true;
          decisions.whisper_known_skip = true;
          return { status: 'skipped', reason: 'Kohaku already has this memory this session; counted as skip_whisper.' };
        }
        if (worldIds.has(memoryId)) {
          decisions.whisper = { memory_id: memoryId, snippet_ids: [], world_update: true };
          known.add(memoryId);
          return { status: 'ok' };
        }
        const resolved = numbers.map((n) => handles.resolve(memoryId, n));
        if (!numbers.length || numbers.length > 3 || resolved.some((r) => !r)) {
          throw new ToolCallError('invalid_quotes', `quotes must be 1-3 quote numbers (n) listed under this memory (asked ${JSON.stringify(args.quotes)}; this memory has ${handles.count(memoryId)} quotes).`);
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
        if (!CANONICAL_MEMORY_KINDS.includes(kind)) throw new ToolCallError('invalid_kind', `kind must be one of ${CANONICAL_MEMORY_KINDS.join(', ')}`);
        const result = runtime.store.withMutationBoundary(() => runtime.rememberKind(input.batchId, kind as CanonicalMemoryKind, rest));
        decisions.remember.push({ kind, outcome: result.outcome, memory_id: result.memory_id, rejection_code: (result as any).rejection_code, ...(args.assistant_intent_id ? { assistant_intent_id: args.assistant_intent_id } : {}) });
        if (result.outcome === 'accepted' && result.memory_id) known.add(result.memory_id);
        return result;
      }
      case 'memory_world_update': {
        const memoryId = String(args.memory_id ?? '').trim();
        const result = runtime.worldUpdate(input.batchId, { memory_id: memoryId, fact: args.fact, evidence_ids: args.evidence_ids, ...(args.as_of === undefined ? {} : { as_of: args.as_of }) });
        decisions.world_updates.push({ memory_id: memoryId, outcome: result.outcome, rejection_code: (result as any).rejection_code });
        // Kohaku just heard the new fact: not whispered back to her this session.
        if (result.outcome === 'accepted') known.add(result.memory_id ?? memoryId);
        return result;
      }
      case 'suggest_memory_relation': {
        const ids: string[] = Array.isArray(args.memory_ids) ? args.memory_ids.map(String) : [];
        const unseen = ids.filter((id) => !surfaced.has(id) && !recent.has(id));
        if (unseen.length) throw new ToolCallError('unseen_memory', `suggest_memory_relation may use only memories seen this pass or recently: ${unseen.join(', ')}`);
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
        throw new ToolCallError('unknown_tool', `unknown tool: ${name}`);
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
      prompt_chars: promptChars, tool_calls: calls.map((call) => (toolNames.has(call.function?.name ?? '') ? call.function!.name : 'unknown')),
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
      succeeded = complete(false);
      break;
    }
    const outputs = await Promise.all(calls.map(async (call) => {
      const name = call.function?.name ?? '';
      const args = parseArgs(call.function?.arguments ?? '');
      try {
        if (!toolNames.has(name)) throw new ToolCallError('unknown_tool', `unknown tool: ${name.slice(0, 60)}`);
        if (!args) throw new ToolCallError('invalid_arguments', 'arguments must be a JSON object');
        return JSON.stringify(await execute(name, args));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const code = error instanceof ToolCallError ? error.code : 'exception';
        const exception = code === 'exception' ? exceptionClass(error) : undefined;
        toolErrors.push({ name: toolNames.has(name) ? name : 'unknown', code, ...(exception ? { exception } : {}), message: text.slice(0, 200) });
        return JSON.stringify({ error: text });
      }
    }));
    calls.forEach((call, index) => messages.push({ role: 'tool', tool_call_id: call.id, content: outputs[index] }));
    // A step of decisions only (nothing new to read) that all went through ends the pass without another call.
    const errorsBefore = toolErrors.length - outputs.filter((output) => output.startsWith('{"error"')).length;
    const decisionsOnly = calls.every((call) => DECISION_TOOLS.has(call.function?.name ?? ''));
    const stepFailed = toolErrors.length !== errorsBefore;
    if (step === config.maxSteps || (decisionsOnly && !stepFailed && hasSearchedOrSilent())) {
      succeeded = complete(stepFailed);
      break;
    }
  }

  const completion = runtime.store.withMutationBoundary(() => runtime.finalizeBatch(input.batchId, succeeded));
  return { succeeded, completion, steps, decisions, tool_errors: toolErrors, surfaced_memory_ids: [...surfaced] };
}
