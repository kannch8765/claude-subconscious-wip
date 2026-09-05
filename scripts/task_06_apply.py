from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path.cwd()

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)

def regex_once(text: str, pattern: str, new: str, label: str, flags=re.S) -> str:
    text2, count = re.subn(pattern, new, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one regex match, found {count}')
    return text2

# 1. Canonical per-kind payload definition: validator + tool schema share this one table.
p='relationship-memory/src/schema/index.ts'; s=read(p)
new_defs=r'''export type MemoryPayloadValueType = 'string' | 'string_array';

export interface MemoryPayloadFieldDefinition {
  valueType: MemoryPayloadValueType;
  required: boolean;
  requireNonEmptyArray?: boolean;
  description?: string;
}

export interface MemoryKindDefinition {
  fields: Record<string, MemoryPayloadFieldDefinition>;
}

/**
 * Single schema-version-1 source of truth for per-kind payload structure.
 * Canonical validation and model-facing kind-specific create tools both derive
 * their allowed fields, value types, and requiredness from this definition.
 */
export const MEMORY_KIND_DEFINITIONS = {
  personal_experience: {
    fields: {
      title: { valueType: 'string', required: true },
      experience: { valueType: 'string', required: true },
      time_text: { valueType: 'string', required: false },
      places: { valueType: 'string_array', required: false },
      themes: { valueType: 'string_array', required: false },
      emotional_tone: {
        valueType: 'string', required: false,
        description: 'Optional historical affect only when trusted evidence directly expresses or unambiguously demonstrates it; keep it perspective-neutral and do not project it onto present Kohaku.',
      },
      why_memorable: {
        valueType: 'string', required: false,
        description: 'Optional source-supported historical reason only. Omit when the evidence does not explicitly support why the event was memorable; never invent present-day significance.',
      },
      recall_triggers: { valueType: 'string_array', required: false },
    },
  },
  shared_experience: {
    fields: {
      title: { valueType: 'string', required: true },
      event: { valueType: 'string', required: true },
      shared_meaning: {
        valueType: 'string', required: true,
        description: 'Required minimal factual relationship description. Prefer an evidence-backed restatement of what was shared or explicitly said; do not infer feelings, fulfillment, or relationship conclusions.',
      },
      symbols: { valueType: 'string_array', required: false },
      recall_triggers: { valueType: 'string_array', required: false },
    },
  },
  relationship_event: {
    fields: {
      event: { valueType: 'string', required: true },
      meaning: {
        valueType: 'string', required: true,
        description: 'Required minimal factual relationship-event description. Use only source-supported meaning; when no stronger meaning is explicit, keep this as a factual restatement rather than an interpretation.',
      },
      prior_context: { valueType: 'string', required: false },
      resulting_change: {
        valueType: 'string', required: false,
        description: 'Optional historical change only when trusted evidence explicitly establishes it; do not infer that a wish was fulfilled, a bond deepened, or a present state changed.',
      },
    },
  },
  inside_joke: {
    fields: {
      name: { valueType: 'string', required: true },
      meaning: { valueType: 'string', required: true },
      trigger_phrases: { valueType: 'string_array', required: true, requireNonEmptyArray: true },
      origin: { valueType: 'string', required: false },
      callbacks: { valueType: 'string_array', required: false },
      tone: { valueType: 'string', required: false },
    },
  },
  user_preference: {
    fields: {
      topic: { valueType: 'string', required: true },
      preference: { valueType: 'string', required: true },
      context: { valueType: 'string', required: false },
      reason: { valueType: 'string', required: false },
      recall_triggers: { valueType: 'string_array', required: false },
    },
  },
} satisfies Record<MemoryKind, MemoryKindDefinition>;'''
s=regex_once(s, r"const payloadKeys = \{.*?\} satisfies Record<MemoryKind, \{ required: string\[\]; optional: string\[\]; arrays: string\[\]; nonEmptyArrays\?: string\[\] \}>;", new_defs, 'replace payloadKeys')
old_validator=r'''  const keys = payloadKeys[kind];
  const allowed = new Set([...keys.required, ...keys.optional]);
  for (const key of Object.keys(input.payload)) {
    if (!allowed.has(key)) return { ok: false, code: 'unknown_payload_field', reason: `Unknown ${kind} payload field: ${key}` };
  }

  const payload: Record<string, unknown> = {};
  for (const key of keys.required) {
    if (keys.arrays.includes(key)) {
      const cleaned = cleanStringArray(input.payload[key], keys.nonEmptyArrays?.includes(key));
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a valid non-empty unique string array.` };
      payload[key] = cleaned;
    } else {
      const cleaned = cleanString(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a non-empty string.` };
      payload[key] = cleaned;
    }
  }
  for (const key of keys.optional) {
    if (!(key in input.payload)) continue;
    if (input.payload[key] === null) return { ok: false, code: 'invalid_optional_null', reason: `${kind}.${key} must be omitted rather than null.` };
    if (keys.arrays.includes(key)) {
      const cleaned = cleanStringArray(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a unique non-empty string array.` };
      payload[key] = cleaned;
    } else {
      const cleaned = cleanString(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a non-empty string.` };
      payload[key] = cleaned;
    }
  }
'''
new_validator=r'''  const definition = MEMORY_KIND_DEFINITIONS[kind];
  const fieldDefinitions = definition.fields as Record<string, MemoryPayloadFieldDefinition>;
  const allowed = new Set(Object.keys(fieldDefinitions));
  for (const key of Object.keys(input.payload)) {
    if (!allowed.has(key)) return { ok: false, code: 'unknown_payload_field', reason: `Unknown ${kind} payload field: ${key}` };
  }

  const payload: Record<string, unknown> = {};
  const requiredFields = Object.entries(fieldDefinitions).filter(([, rule]) => rule.required);
  for (const [key, rule] of requiredFields) {
    if (rule.valueType === 'string_array') {
      const cleaned = cleanStringArray(input.payload[key], rule.requireNonEmptyArray ?? false);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a valid non-empty unique string array.` };
      payload[key] = cleaned;
    } else {
      const cleaned = cleanString(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a non-empty string.` };
      payload[key] = cleaned;
    }
  }

  const optionalFields = Object.entries(fieldDefinitions).filter(([, rule]) => !rule.required);
  for (const [key, rule] of optionalFields) {
    if (!(key in input.payload)) continue;
    if (input.payload[key] === null) return { ok: false, code: 'invalid_optional_null', reason: `${kind}.${key} must be omitted rather than null.` };
    if (rule.valueType === 'string_array') {
      const cleaned = cleanStringArray(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a unique non-empty string array.` };
      payload[key] = cleaned;
    } else {
      const cleaned = cleanString(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a non-empty string.` };
      payload[key] = cleaned;
    }
  }
'''
s=replace_once(s, old_validator, new_validator, 'derive validator fields')
write(p,s)

# 2. Thin kind-specific tool schemas + fixed-kind dispatcher.
p='relationship-memory/src/tools/index.ts'; s=read(p)
s=replace_once(s, "import { normalizeEntityAlias, validateEntityIdentityProposal, validateProposal } from '../schema/index.js';", "import { MEMORY_KINDS, MEMORY_KIND_DEFINITIONS, normalizeEntityAlias, validateEntityIdentityProposal, validateProposal, type MemoryPayloadFieldDefinition } from '../schema/index.js';", 'tools schema import')
needle="""export interface RememberResult {
  outcome: RememberOutcome['outcome'];
  memory_id?: string;
  entity_id?: string;
  rejection_code?: string;
  reason?: string;
}
"""
s=replace_once(s, needle, needle+"""
export type MemoryRememberToolName = `memory_remember_${MemoryKind}`;

export function memoryRememberToolName(kind: MemoryKind): MemoryRememberToolName {
  return `memory_remember_${kind}`;
}

export const MEMORY_REMEMBER_TOOL_NAMES = MEMORY_KINDS.map(memoryRememberToolName) as readonly MemoryRememberToolName[];
""", 'tool names')
s=replace_once(s, "  remember(batchId: string, rawProposal: unknown): RememberResult {\n", """  rememberKind(batchId: string, kind: MemoryKind, rawInput: unknown): RememberResult {
    const input = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? rawInput as Record<string, unknown>
      : {};
    return this.remember(batchId, {
      ...input,
      schema_version: 1,
      kind,
    });
  }

  remember(batchId: string, rawProposal: unknown): RememberResult {
""", 'fixed kind dispatcher')
new_schema=r'''export function memoryRememberKindToolSchema(kind: MemoryKind): Record<string, unknown> {
  const stringSchema = (): Record<string, unknown> => ({ type: 'string', minLength: 1 });
  const stringArraySchema = (requireNonEmpty = false): Record<string, unknown> => ({
    type: 'array',
    ...(requireNonEmpty ? { minItems: 1 } : {}),
    uniqueItems: true,
    items: stringSchema(),
  });
  const fieldDefinitions = MEMORY_KIND_DEFINITIONS[kind].fields as Record<string, MemoryPayloadFieldDefinition>;
  const payloadProperties = Object.fromEntries(Object.entries(fieldDefinitions).map(([name, definition]) => [
    name,
    {
      ...(definition.valueType === 'string_array'
        ? stringArraySchema(definition.requireNonEmptyArray ?? false)
        : stringSchema()),
      ...(definition.description ? { description: definition.description } : {}),
    },
  ]));
  const payloadRequired = Object.entries(fieldDefinitions)
    .filter(([, definition]) => definition.required)
    .map(([name]) => name);

  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'participants', 'evidence_ids', 'payload'],
    properties: {
      summary: {
        ...stringSchema(),
        description: 'Concise source-grounded historical event or stable-fact index. State what happened or what was explicitly stated; do not infer present feelings, motives, fulfillment, or relationship conclusions.',
      },
      participants: {
        type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
        items: { type: 'string', enum: ['user', 'assistant'] },
      },
      evidence_ids: {
        type: 'array', minItems: 1, uniqueItems: true, items: stringSchema(),
        description: 'Exact evidence_id values copied from the trusted current-batch transcript-event evidence catalog.',
      },
      linked_memory_ids: stringArraySchema(),
      assistant_intent_id: {
        ...stringSchema(),
        description: 'Optional trusted assistant remember-intent ID copied exactly from the current-batch assistant intent catalog. Never supply feel text here.',
      },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: payloadRequired,
        description: `Payload for ${kind}. Only the declared fields are accepted. For model-authored new writes, summary and narrative semantic prose must be Chinese; literal names, aliases, trigger tokens, code, provider names, paths, URLs, and trusted evidence stay source-faithful.`,
        properties: payloadProperties,
      },
    },
  };
}
'''
s=regex_once(s, r"export function memoryRememberToolSchema\(\): Record<string, unknown> \{.*?\n\}\n(?=\nexport function entitySearchToolSchema)", new_schema.rstrip('\n'), 'replace unified memory schema')
write(p,s)

# 3. Catalog/adapter generates five tools; sync permission remains explicit.
p='relationship-memory/src/adapter/index.ts'; s=read(p)
s=replace_once(s, "import type { AssistantRememberIntentRecord, CanonicalMessage, ParticipantRole, TranscriptEvidenceKind } from '../schema/index.js';", "import { MEMORY_KINDS, type AssistantRememberIntentRecord, type CanonicalMessage, type MemoryKind, type ParticipantRole, type TranscriptEvidenceKind } from '../schema/index.js';", 'adapter schema imports')
s=replace_once(s, "import { entityRememberToolSchema, entitySearchToolSchema, memoryRememberToolSchema, memoryReinforceToolSchema, memorySearchToolSchema, RelationshipMemoryRuntime } from '../tools/index.js';", "import { MEMORY_REMEMBER_TOOL_NAMES, entityRememberToolSchema, entitySearchToolSchema, memoryRememberKindToolSchema, memoryRememberToolName, memoryReinforceToolSchema, memorySearchToolSchema, RelationshipMemoryRuntime, type MemoryRememberToolName } from '../tools/index.js';", 'adapter tools imports')
s=replace_once(s, "  name: 'memory_search' | 'memory_remember' | 'memory_reinforce' | 'entity_search' | 'entity_remember';", "  name: 'memory_search' | MemoryRememberToolName | 'memory_reinforce' | 'entity_search' | 'entity_remember';", 'adapter tool name union')
needle='export function buildRelationshipTools(\n'
desc="""const MEMORY_REMEMBER_KIND_DESCRIPTIONS: Record<MemoryKind, string> = {
  personal_experience: 'Create one personal_experience for a source-grounded historical episode involving the user or assistant. Use only this kind\\'s declared fields; historical affect belongs here only when directly evidenced.',
  shared_experience: 'Create one shared_experience for a source-grounded episode explicitly shared by user and assistant. Keep shared_meaning factual and evidence-backed rather than inferring relationship conclusions.',
  relationship_event: 'Create one relationship_event for a source-grounded event about the relationship itself. Keep meaning and any resulting_change factual and evidence-backed; this kind does not accept personal affect fields.',
  inside_joke: 'Create one inside_joke for a durable recurring joke, callback, or phrase with source-grounded meaning and trigger phrases.',
  user_preference: 'Create one user_preference for a durable preference explicitly supported by trusted evidence. Prefer memory_reinforce when current evidence repeats an existing canonical preference.',
};

function memoryRememberToolDescription(kind: MemoryKind): string {
  return `${MEMORY_REMEMBER_KIND_DESCRIPTIONS[kind]} Bind the proposal to exact current-batch evidence_ids. Write a concise source-grounded historical event/stable-fact index, never invent quotes, and copy assistant_intent_id only from a trusted current-batch remember intent.`;
}

"""
s=replace_once(s, needle, desc+needle, 'adapter descriptions')
old_tool="""    {
      label: 'memory_remember', name: 'memory_remember',
      description: 'Propose one schema-version-1 relationship memory bound to trusted transcript evidence. Write a source-grounded historical event/stable-fact index, not a relationship essay: summarize what happened or what was explicitly stated, and do not infer feelings, motives, fulfillment, present-day meaning, or relationship conclusions. Historical affect may be represented only when directly evidenced. Never invent quotes. When processing a trusted assistant remember intent, copy its assistant_intent_id; never invent or rewrite feel text.',
      parameters: memoryRememberToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(runtime.remember(batchId, args)); },
    },
"""
new_tool="""    ...MEMORY_KINDS.map((kind): RelationshipTool => ({
      label: memoryRememberToolName(kind),
      name: memoryRememberToolName(kind),
      description: memoryRememberToolDescription(kind),
      parameters: memoryRememberKindToolSchema(kind),
      async execute(_toolCallId, args) { return wrapResult(runtime.rememberKind(batchId, kind, args)); },
    })),
"""
s=replace_once(s, old_tool, new_tool, 'adapter tool registration')
old_consts="""export const RELATIONSHIP_ALLOWED_BUILTIN_TOOLS = [] as const;
export const RELATIONSHIP_EXTERNAL_TOOLS = ['memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember'] as const;
export const RELATIONSHIP_ALLOWED_CLIENT_TOOLS = [...RELATIONSHIP_ALLOWED_BUILTIN_TOOLS, ...RELATIONSHIP_EXTERNAL_TOOLS] as const;
"""
new_consts="""export const RELATIONSHIP_ALLOWED_BUILTIN_TOOLS = [] as const;
export const RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS = ['memory_search', 'entity_search'] as const;
export const RELATIONSHIP_MUTATION_CLIENT_TOOLS = ['memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_remember'] as const;
export const RELATIONSHIP_EXTERNAL_TOOLS = ['memory_search', 'memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_search', 'entity_remember'] as const;
export const RELATIONSHIP_ALLOWED_CLIENT_TOOLS = [...RELATIONSHIP_ALLOWED_BUILTIN_TOOLS, ...RELATIONSHIP_EXTERNAL_TOOLS] as const;
const RELATIONSHIP_MUTATION_CLIENT_TOOL_SET = new Set<string>(RELATIONSHIP_MUTATION_CLIENT_TOOLS);

export function isRelationshipMutationClientTool(name: string): boolean {
  return RELATIONSHIP_MUTATION_CLIENT_TOOL_SET.has(name);
}
"""
s=replace_once(s, old_consts, new_consts, 'adapter inventory')
write(p,s)

# 4. Backfill + live native lanes share generated catalog and mutation classifier.
p='scripts/relationship_observer_runner.ts'; s=read(p)
s=replace_once(s, '  createRuntime,\n  relationshipMemoryRoot,', '  createRuntime,\n  isRelationshipMutationClientTool,\n  relationshipMemoryRoot,', 'observer import mutation helper')
s=replace_once(s, "      if (!['memory_remember', 'memory_reinforce', 'entity_remember'].includes(tool.name)) return tool;", "      if (!isRelationshipMutationClientTool(tool.name)) return tool;", 'observer mutation classifier')
write(p,s)

p='scripts/send_worker_native.ts'; s=read(p)
s=replace_once(s, '  createRuntime,\n  relationshipMemoryRoot,', '  createRuntime,\n  isRelationshipMutationClientTool,\n  RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS,\n  relationshipMemoryRoot,', 'live import permissions')
s=replace_once(s, """    const baseRelationshipTools = buildRelationshipTools(runtime, payload.batchId);
    const modeRelationshipTools = isSync
      ? baseRelationshipTools.filter((tool) => ['memory_search', 'entity_search'].includes(tool.name))
      : baseRelationshipTools;
""", """    const baseRelationshipTools = buildRelationshipTools(runtime, payload.batchId);
    const syncAllowedTools = new Set<string>(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS);
    const modeRelationshipTools = isSync
      ? baseRelationshipTools.filter((tool) => syncAllowedTools.has(tool.name))
      : baseRelationshipTools;
""", 'live explicit sync allowlist')
s=replace_once(s, "      if (!['memory_remember', 'memory_reinforce', 'entity_remember'].includes(tool.name)) return tool;", "      if (!isRelationshipMutationClientTool(tool.name)) return tool;", 'live mutation classifier')
s=replace_once(s, "  cleanupCompleted?: typeof cleanupCompletedSyncResources;\n}", "  cleanupCompleted?: typeof cleanupCompletedSyncResources;\n  openStdioMcp?: typeof openStdioMcpToolsFromEnvironment;\n}", 'live test dependency injection')
s=replace_once(s, "      const stdioMcp = await openStdioMcpToolsFromEnvironment(log);", "      const stdioMcp = await (dependencies.openStdioMcp ?? openStdioMcpToolsFromEnvironment)(log);", 'live injected mcp opener')
write(p,s)

# 5. Authoritative editable prompts + envelopes.
p='config/backfill-system.md'; s=read(p)
paras=s.split('\n\n')
if not paras[1].startswith('Relationship memory has five schema-version-1 kinds:'):
    raise RuntimeError('backfill system second paragraph drifted')
paras[1]="""Relationship memory has five schema-version-1 kinds: personal_experience, shared_experience, relationship_event, inside_joke, and user_preference. New canonical memories are created through five kind-specific tools: memory_remember_personal_experience, memory_remember_shared_experience, memory_remember_relationship_event, memory_remember_inside_joke, and memory_remember_user_preference. Each tool fixes the kind and exposes only that kind's payload fields; choose the matching tool rather than supplying a kind yourself. Explicit durable user preferences belong in user_preference. A trusted statement that explicitly states a durable preference requires a canonical semantic action regardless of source language: search first, then either call memory_reinforce on the same existing stable preference with the current trusted evidence, or call memory_remember_user_preference when no same preference exists. A search hit alone is not terminal for new evidence, and no_memory_required is not valid for an explicit durable preference statement. Do not infer preferences merely from repeated episodes, and do not force dated one-off events into user_preference. First-class stable identities use entity_search and entity_remember rather than a memory kind: search canonical names/aliases first, preserve literal aliases such as GPT, ChatGPT, Claude, and Claude Code, and describe identities in perspective-neutral Chinese rather than fragile second-person wording. Ordinary transcript evidence remains observer-originated: decide whether a relationship memory or identity is warranted and use memory_search / entity_search before choosing an action when related canonical state may exist. If the trusted passage is another evidence instance of the same underlying episode/event or stable preference, use memory_reinforce with the existing memory_id and trusted current-batch evidence IDs. If it is a genuinely distinct episode/event, create it with the matching kind-specific memory tool; use linked_memory_ids when distinct memories are meaningfully related. Lexical or topical similarity alone is never enough to classify two events as the same. Trusted assistant_remember_intent_catalog entries are different: Kohaku has already decided that the memory should be retained. For every trusted current-batch assistant intent, search/canonicalize it and call the matching kind-specific memory tool with that exact assistant_intent_id; do not drop it merely as unimportant, do not invent an intent ID, and never rewrite or supply authoritative feel text. The backend-owned intent ledger preserves the exact original memory.text and feel.text. Never invent quotes or canonical IDs. If a kind-specific memory creation tool permanently rejects a proposal for a real schema/trust/evidence reason, you may correct the semantic proposal and try again; retryable_failed means the batch is not safely complete."""
write(p,'\n\n'.join(paras))

p='config/live-system.md'; s=read(p)
needle="You also have trusted relationship-memory client tools for durable experiences, relationship events, inside jokes, stable user preferences, and identities. Use them when a transcript contains genuinely durable relationship meaning, but keep this secondary to your live Subconscious role: maintain working context, preferences, pending work, and useful guidance for the next Claude Code turn. Do not turn ordinary transcript processing into a filing report, and do not narrate memory bookkeeping unless it is itself useful guidance. Canonical relationship memory remains separate from your editable guidance/context blocks."
s=replace_once(s, needle, needle+" New canonical memories use five kind-specific client tools: memory_remember_personal_experience, memory_remember_shared_experience, memory_remember_relationship_event, memory_remember_inside_joke, and memory_remember_user_preference. Each fixes its kind and exposes only that kind's payload fields; choose the matching tool from the evidence rather than supplying a kind yourself. Use memory_reinforce instead when new trusted evidence supports the same existing canonical memory.", 'live prompt tool guidance')
write(p,s)

p='scripts/send_messages_to_letta.ts'; s=read(p)
s=replace_once(s, '- Perform memory_reinforce / memory_remember / entity operations as needed. This work is private maintenance.', '- Perform memory_reinforce / the matching kind-specific memory creation tool / entity operations as needed. This work is private maintenance.', 'live envelope wording')
write(p,s)

p='relationship-memory/src/backfill/index.ts'; s=read(p)
s=replace_once(s, 'Reinforce the same underlying episode/event with memory_reinforce; create genuinely distinct episodes with memory_remember and linked_memory_ids when related.', 'Reinforce the same underlying episode/event with memory_reinforce; create genuinely distinct episodes with the matching kind-specific memory creation tool and linked_memory_ids when related.', 'backfill envelope wording')
write(p,s)

# 6. Keep bundled AgentFiles/bootstrap snapshots aligned with #79 editable Markdown.
new_tg="""AVAILABLE TOOLS:

== Letta Persistent Working Memory ==
1. memory - Manage persistent working-memory blocks (create, str_replace, insert, delete, rename)
2. memory_rethink - Rewrite an entire working-memory block when structural reorganization is needed
3. memory_replace - Replace precise text inside a working-memory block
4. memory_insert - Insert text at a specific line in a working-memory block

== Letta Conversation History ==
5. conversation_search - Search past messages to this persistent Subconscious across sessions

== Native Relationship Client Tools ==
6. memory_search - Search canonical relationship memories; on each live pass with a real user message, I choose and execute at least one semantic query from <latest_user_message> plus current-batch context
7. memory_reinforce - Bind trusted current-batch evidence to an existing durable relationship memory
8. memory_remember_personal_experience - Create a new personal_experience using only that kind's payload fields
9. memory_remember_shared_experience - Create a new shared_experience using only that kind's payload fields
10. memory_remember_relationship_event - Create a new relationship_event using only that kind's payload fields
11. memory_remember_inside_joke - Create a new inside_joke using only that kind's payload fields
12. memory_remember_user_preference - Create a new user_preference using only that kind's payload fields
13. entity_search - Search canonical people/place/entity identities and aliases
14. entity_remember - Create an evidence-backed canonical entity identity
15. deliver_whisper - Select 1-3 source-faithful snippets from one searched memory so foreground Kohaku can see a historical moment; transcript snippets render as 猫/当时琥珀 quotes, legacy-memory fallback renders explicitly as 旧记忆记录

BOUNDARY:
- Live execution uses the native @letta-ai/letta-client conversations API.
- There are no Read, Grep, Glob, Bash, Edit, Write, or Letta Code SDK client tools in live Subconscious.
- Do not assume filesystem access merely because older Subconscious history or prompts mention it.
- Filesystem/code investigation belongs to foreground Kohaku.
- Relationship-memory maintenance is private. Only deliver_whisper may surface remembered relationship context to foreground Kohaku.
- LETTA_MODE=whisper/full controls foreground context injection only; it does not change this tool inventory or transport.

USAGE PATTERNS:
- Working-memory update -> memory_replace / memory_insert / memory_rethink
- Past Subcon context -> conversation_search
- Missing identity grounding -> entity_search with purpose=foreground_grounding only when the named referent matters and current trusted context is insufficient; then use the grounded identity to guide episodic memory_search. Alias/dedupe or entity maintenance lookup -> purpose=maintenance. The live transport auto-preserves identity only when the pass resolves exactly one distinct concise foreground-grounding entity; maintenance searches or multiple distinct foreground identities do not auto-inject identity
- Relationship association -> generate and call a semantic memory_search query myself; after seeing results, follow with another query when genuinely useful
- Durable relationship evidence -> memory_reinforce for the same canonical memory, otherwise choose exactly one matching memory_remember_<kind> tool for a genuinely new memory
- Useful next-turn memory -> select the fewest quote_snippets that let the historical moment stand on its own; retrieval supplies the association, so do not narrate its present meaning"""
for af,md in [('Subconscious.af','config/live-system.md'),('SubconsciousBackfill.af','config/backfill-system.md')]:
    ap=ROOT/af; d=json.loads(ap.read_text()); agent=d['agents'][0]
    old_system=agent['system']; new_system=read(md).rstrip('\n')
    text=agent['messages'][0]['content'][0]['text']
    if not text.startswith(old_system): raise RuntimeError(f'{af}: bootstrap does not start with agent.system')
    text=new_system+text[len(old_system):]
    agent['system']=new_system
    if af=='Subconscious.af':
        block=next(b for b in d['blocks'] if b.get('label')=='tool_guidelines')
        old_tg=block['value']
        if old_tg not in text: raise RuntimeError('live compiled bootstrap lacks tool_guidelines snapshot')
        text=text.replace(old_tg,new_tg,1); block['value']=new_tg
    agent['messages'][0]['content'][0]['text']=text
    ap.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')

# 7. Update existing regressions for generated catalog and add strict schema/dispatcher coverage.
p='relationship-memory/tests/relationship-memory.test.ts'; s=read(p)
s=replace_once(s, '  makeBatchId,\n  memoryRememberToolSchema,', '  makeBatchId,\n  MEMORY_KINDS,\n  MEMORY_KIND_DEFINITIONS,\n  MEMORY_REMEMBER_TOOL_NAMES,\n  memoryRememberKindToolSchema,', 'test schema imports')
s=replace_once(s, '  RELATIONSHIP_ALLOWED_CLIENT_TOOLS,\n  RELATIONSHIP_DISALLOWED_CLIENT_TOOLS,', '  RELATIONSHIP_ALLOWED_CLIENT_TOOLS,\n  RELATIONSHIP_DISALLOWED_CLIENT_TOOLS,\n  RELATIONSHIP_MUTATION_CLIENT_TOOLS,\n  RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS,', 'test inventory imports')
joke_end="""function joke() {
  return {
    schema_version: 1,
    kind: 'inside_joke',
    summary: 'A fictional tea-kettle callback',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['msg-assistant-1'],
    payload: { name: 'Tea-kettle weather', meaning: 'A playful callback for an overdramatic forecast.', trigger_phrases: ['tea-kettle weather'], callbacks: ['boiling forecast'] },
  };
}
"""
s=replace_once(s,joke_end,joke_end+"""
function preference() {
  return {
    schema_version: 1,
    kind: 'user_preference',
    summary: 'The user prefers quiet cafes',
    participants: ['user'],
    evidence_message_ids: ['msg-user-1'],
    payload: { topic: 'cafes', preference: 'The user prefers quiet cafes.', context: 'When choosing somewhere to sit.' },
  };
}

function memoryToolInput(proposal: Record<string, any>): Record<string, unknown> {
  const { schema_version: _schemaVersion, kind: _kind, evidence_message_ids: evidenceMessageIds, ...rest } = proposal;
  return { ...rest, evidence_ids: evidenceMessageIds };
}
""",'test helpers')
s=s.replace("it('accepts all four authorized kinds', () => {", "it('accepts all five authorized kinds', () => {",1)
s=replace_once(s,"    expect(validateProposal(relationshipNoLink).ok).toBe(true);\n    expect(validateProposal(joke()).ok).toBe(true);", "    expect(validateProposal(relationshipNoLink).ok).toBe(true);\n    expect(validateProposal(joke()).ok).toBe(true);\n    expect(validateProposal(preference()).ok).toBe(true);", 'test five kinds')
start=s.index("describe('observer contract correction', () => {")
end=s.index("\ndescribe('adopted SDK/configuration boundary'", start)
new_desc="""describe('observer contract correction', () => {
  it('derives every kind-specific model schema from the canonical kind definitions', () => {
    for (const kind of MEMORY_KINDS) {
      const schema = memoryRememberKindToolSchema(kind) as any;
      const definition = MEMORY_KIND_DEFINITIONS[kind];
      const expectedFields = Object.keys(definition.fields);
      const expectedRequired = Object.entries(definition.fields).filter(([, field]) => field.required).map(([name]) => name);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(['summary', 'participants', 'evidence_ids', 'payload']);
      expect(Object.keys(schema.properties).sort()).toEqual(['assistant_intent_id', 'evidence_ids', 'linked_memory_ids', 'participants', 'payload', 'summary']);
      expect(schema.properties).not.toHaveProperty('kind');
      expect(schema.properties).not.toHaveProperty('schema_version');
      expect(schema.properties).not.toHaveProperty('evidence_message_ids');
      expect(schema.properties.payload.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties.payload.properties)).toEqual(expectedFields);
      expect(schema.properties.payload.required).toEqual(expectedRequired);
      for (const [name, field] of Object.entries(definition.fields)) {
        const property = schema.properties.payload.properties[name];
        expect(property.type).toBe(field.valueType === 'string_array' ? 'array' : 'string');
        if (field.requireNonEmptyArray) expect(property.minItems).toBe(1);
      }
    }
    const personalSchema = memoryRememberKindToolSchema('personal_experience') as any;
    const relationshipSchema = memoryRememberKindToolSchema('relationship_event') as any;
    expect(personalSchema.properties.payload.properties).toHaveProperty('emotional_tone');
    expect(personalSchema.properties.payload.properties).toHaveProperty('why_memorable');
    expect(relationshipSchema.properties.payload.properties).not.toHaveProperty('emotional_tone');
    expect(relationshipSchema.properties.payload.properties).not.toHaveProperty('why_memorable');
  });

  it('keeps validator behavior aligned and rejects cross-kind or malformed payloads without canonical memory/evidence mutation', () => {
    const proposals = [personal(), (() => { const value = shared('unused'); delete (value as any).linked_memory_ids; return value; })(), (() => { const value = relationship('unused'); delete (value as any).linked_memory_ids; return value; })(), joke(), preference()];
    expect(proposals.map((proposal) => proposal.kind)).toEqual(MEMORY_KINDS);
    for (const proposal of proposals) expect(validateProposal(proposal).ok).toBe(true);
    const rt = runtime(); rt.store.beginBatch('kind-rejects', '2026-01-01T00:00:00.000Z');
    const base = memoryToolInput(relationship('unused')); delete (base as any).linked_memory_ids;
    expect(rt.rememberKind('kind-rejects', 'relationship_event', { ...base, payload: { event: 'A supported event.', meaning: 'A supported meaning.', emotional_tone: 'wrong kind' } })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unknown_payload_field' }));
    expect(rt.rememberKind('kind-rejects', 'relationship_event', { ...base, payload: { event: 'A supported event.' } })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_payload_field' }));
    expect(rt.rememberKind('kind-rejects', 'relationship_event', { ...base, payload: { event: 'A supported event.', meaning: 'A supported meaning.', prior_context: null } })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_optional_null' }));
    expect(rt.rememberKind('kind-rejects', 'relationship_event', { ...base, payload: { event: ['wrong type'], meaning: 'A supported meaning.' } })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_payload_field' }));
    expect(rt.store.listMemories()).toHaveLength(0); expect(rt.store.listEvidence()).toHaveLength(0);
  });

  it('dispatches a fixed kind into the existing canonical remember path with equivalent idempotency', () => {
    const input = memoryToolInput(personal());
    const rt = runtime(); rt.store.beginBatch('kind-equivalence', '2026-01-01T00:00:00.000Z');
    const first = rt.rememberKind('kind-equivalence', 'personal_experience', input);
    const duplicate = rt.rememberKind('kind-equivalence', 'personal_experience', { ...input, kind: 'relationship_event', schema_version: 99 });
    expect(first).toEqual(expect.objectContaining({ outcome: 'accepted' }));
    expect(duplicate).toEqual(expect.objectContaining({ outcome: 'duplicate', memory_id: first.memory_id }));
    expect(rt.store.listMemories()).toHaveLength(1);
    const canonicalRt = runtime(); canonicalRt.store.beginBatch('kind-equivalence', '2026-01-01T00:00:00.000Z');
    const canonical = canonicalRt.remember('kind-equivalence', { ...input, schema_version: 1, kind: 'personal_experience' });
    expect(canonical).toEqual(expect.objectContaining({ outcome: 'accepted', memory_id: first.memory_id }));
    expect(canonicalRt.store.listMemories()[0]).toEqual(rt.store.listMemories()[0]);
  });

  it('appends exact current-batch canonical evidence IDs, roles, and safely escaped quotes', () => {
    const canonical = [{ ...messages[0], message_id: 'msg-&-"-1', quote: '<gift> & "shared"' }, messages[1]];
    const observerMessage = appendCanonicalEvidenceCatalog('<claude_code_session_update>fixture</claude_code_session_update>', canonical);
    expect(observerMessage).toContain('<relationship_memory_evidence_semantics>');
    expect(observerMessage).toContain('<relationship_memory_evidence_catalog trusted="transcript_provenance_only">');
    expect(observerMessage).toContain('message_id="msg-&amp;-&quot;-1" role="user"');
    expect(observerMessage).toContain('&lt;gift&gt; &amp; &quot;shared&quot;');
    expect(observerMessage).toContain(`message_id="${messages[1].message_id}" role="assistant"`);
    expect(observerMessage).not.toContain(messages[2].message_id);
  });

  it('uses the same canonical messages for observer choices and trusted evidence authority', () => {
    const canonical = messages.slice(0, 2);
    const observerMessage = appendCanonicalEvidenceCatalog('fixture', canonical);
    const store = new RelationshipMemoryStore(tempDir(), 'subject-fixture');
    const rt = new RelationshipMemoryRuntime(store, new Map(canonical.map((message) => [message.message_id, message])), () => '2026-01-02T00:00:00.000Z');
    store.beginBatch('same-authority', '2026-01-01T00:00:00.000Z');
    expect(observerMessage).toContain(messages[0].message_id);
    expect(rt.remember('same-authority', personal()).outcome).toBe('accepted');
    expect(rt.store.listEvidence()[0]).toEqual(expect.objectContaining({ message_id: messages[0].message_id, role: messages[0].role, quote: messages[0].quote }));
    expect(observerMessage).not.toContain(messages[2].message_id);
    expect(rt.remember('same-authority', personal({ summary: 'Out-of-batch evidence must fail', evidence_message_ids: [messages[2].message_id] }))).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unresolvable_evidence' }));
  });
});
"""
s=s[:start]+new_desc+s[end:]
s=s.replace("expect(tools.map((t) => t.name)).toEqual(['memory_search', 'entity_search', 'entity_remember', 'memory_reinforce', 'memory_remember']);", "expect(tools.map((t) => t.name)).toEqual(['memory_search', 'entity_search', 'entity_remember', 'memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES]);\n    expect(tools.some((tool) => tool.name === ('memory_remember' as any))).toBe(false);",1)
s=s.replace("expect(RELATIONSHIP_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember']);", "expect(RELATIONSHIP_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_search', 'entity_remember']);\n    expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'entity_search']);\n    expect(RELATIONSHIP_MUTATION_CLIENT_TOOLS).toEqual(['memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_remember']);",1)
s=s.replace("      'memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember',", "      'memory_search', 'memory_reinforce', ...MEMORY_REMEMBER_TOOL_NAMES, 'entity_search', 'entity_remember',",1)
s=s.replace("const remembered = await tools.find((tool) => tool.name === 'memory_remember')!.execute('call-1', personal());", "const remembered = await tools.find((tool) => tool.name === 'memory_remember_personal_experience')!.execute('call-1', memoryToolInput(personal()));",1)
s=s.replace("expect(agent.system).toContain('memory_remember');", "expect(agent.system).toContain('memory_remember_personal_experience');\n    expect(agent.system).toContain('memory_remember_user_preference');",1)
write(p,s)

p='scripts/relationship_observer_runner.test.ts'; s=read(p)
s=replace_once(s, "import { runRelationshipObserverBatch } from './relationship_observer_runner.js';", "import { runRelationshipObserverBatch } from './relationship_observer_runner.js';\nimport { MEMORY_REMEMBER_TOOL_NAMES } from '../relationship-memory/src/tools/index.js';", 'observer test import')
old="""    expect(client.bodies[0].client_tools.map((tool: any) => tool.name).sort()).toEqual([
      'entity_remember', 'entity_search', 'memory_reinforce', 'memory_remember', 'memory_search',
    ].sort());
"""
new="""    expect(client.bodies[0].client_tools.map((tool: any) => tool.name).sort()).toEqual([
      'entity_remember', 'entity_search', 'memory_reinforce', 'memory_search', ...MEMORY_REMEMBER_TOOL_NAMES,
    ].sort());
    expect(client.bodies[0].client_tools.some((tool: any) => tool.name === 'memory_remember')).toBe(false);
    const relationshipEvent = client.bodies[0].client_tools.find((tool: any) => tool.name === 'memory_remember_relationship_event');
    const personalExperience = client.bodies[0].client_tools.find((tool: any) => tool.name === 'memory_remember_personal_experience');
    expect(Object.keys(relationshipEvent.parameters.properties.payload.properties)).toEqual(['event', 'meaning', 'prior_context', 'resulting_change']);
    expect(relationshipEvent.parameters.properties.payload.required).toEqual(['event', 'meaning']);
    expect(relationshipEvent.parameters.properties.payload.properties).not.toHaveProperty('emotional_tone');
    expect(personalExperience.parameters.properties.payload.properties).toHaveProperty('emotional_tone');
    expect(personalExperience.parameters.properties.payload.properties).toHaveProperty('why_memorable');
"""
s=replace_once(s,old,new,'observer native schema expectations')
s=replace_once(s,"""    expect(client.bodies[1].messages).toEqual([{
      type: 'tool_return',
""","""    expect(client.bodies[1].client_tools.map((tool: any) => tool.name).sort()).toEqual(client.bodies[0].client_tools.map((tool: any) => tool.name).sort());
    expect(client.bodies[1].messages).toEqual([{
      type: 'tool_return',
""",'observer continuation refresh')
write(p,s)

p='scripts/live_async_memory_surfacing.test.ts'; s=read(p)
s=replace_once(s,"import * as path from 'path';\nimport { describe, expect, it } from 'vitest';", "import * as path from 'path';\nimport * as os from 'os';\nimport { afterEach, describe, expect, it } from 'vitest';\nimport { MEMORY_REMEMBER_TOOL_NAMES } from '../relationship-memory/src/tools/index.js';\nimport { sendViaNativeClient } from './send_worker_native.js';",'live test imports')
s=replace_once(s,"describe('live async relationship-memory surfacing contract', () => {\n", """const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_DIR;
  delete process.env.LETTA_API_KEY;
});

describe('live async relationship-memory surfacing contract', () => {
""",'live temp setup')
s=replace_once(s,"    expect(worker).toContain('memory_reinforce');\n    expect(worker).toContain('memory_remember');", "    expect(worker).toContain('isRelationshipMutationClientTool(tool.name)');\n    expect(worker).toContain('RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS');",'live source expectations')
needle="  it('keeps live delivery on the native Letta client-tool conversation loop', () => {\n"
newtest="""  it('sends the five kind-specific create schemas on the final async native client-tool surface', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-memory-tools-')); roots.push(root);
    process.env.RELATIONSHIP_MEMORY_DIR = root; process.env.LETTA_API_KEY = 'test-only';
    let capturedTools: any[] = [];
    const completion = await sendViaNativeClient({
      agentId: 'agent-test', conversationId: 'conversation-test', sessionId: 'session-test',
      message: '<claude_code_session_update>test</claude_code_session_update>', cwd: root,
      batchId: 'batch-live-tool-surface', canonicalMessages: [], assistantIntents: [], latestUserMessage: '',
    }, {
      createClient: () => ({}),
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
      runConversation: async (input: any) => { capturedTools = input.tools; return { response: { stop_reason: { stop_reason: 'end_turn' } }, clientToolFailure: false } as any; },
    });
    expect(completion).toBe('completed');
    const names = capturedTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...MEMORY_REMEMBER_TOOL_NAMES, 'memory_search', 'memory_reinforce', 'entity_search', 'entity_remember', 'deliver_whisper']));
    expect(names).not.toContain('memory_remember');
    const eventTool = capturedTools.find((tool) => tool.name === 'memory_remember_relationship_event');
    expect(Object.keys(eventTool.parameters.properties.payload.properties)).toEqual(['event', 'meaning', 'prior_context', 'resulting_change']);
    expect(eventTool.parameters.properties.payload.properties).not.toHaveProperty('emotional_tone');
  });

"""
s=replace_once(s,needle,newtest+needle,'live actual tool surface test')
s=replace_once(s,"    expect(blocks.get('tool_guidelines')).toContain('I choose and execute at least one semantic query');", "    expect(blocks.get('tool_guidelines')).toContain('I choose and execute at least one semantic query');\n    for (const name of MEMORY_REMEMBER_TOOL_NAMES) expect(blocks.get('tool_guidelines')).toContain(name);",'live agentfile inventory test')
write(p,s)

p='scripts/sync_subcon_mode.test.ts'; s=read(p)
s=replace_once(s,"import { describe, expect, it } from 'vitest';", "import { describe, expect, it } from 'vitest';\nimport { MEMORY_REMEMBER_TOOL_NAMES } from '../relationship-memory/src/tools/index.js';\nimport { RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS } from '../relationship-memory/src/adapter/index.js';",'sync imports')
s=replace_once(s,"    expect(worker).toContain(\"baseRelationshipTools.filter((tool) => ['memory_search', 'entity_search'].includes(tool.name))\");", "    expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'entity_search']);\n    for (const name of MEMORY_REMEMBER_TOOL_NAMES) expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).not.toContain(name as any);\n    expect(worker).toContain('baseRelationshipTools.filter((tool) => syncAllowedTools.has(tool.name))');",'sync allowlist test')
s=replace_once(s,"    expect(worker).toContain(\"['memory_remember', 'memory_reinforce', 'entity_remember']\");", "    expect(worker).toContain('isRelationshipMutationClientTool(tool.name)');",'sync mutation test')
write(p,s)

p='scripts/relationship_memory_backfill_runner.test.ts'; s=read(p)
s=replace_once(s,"import { describe, expect, it } from 'vitest';\nimport { parseRelationshipMemoryBackfillArgs } from './relationship_memory_backfill_runner.js';", "import { describe, expect, it } from 'vitest';\nimport * as fs from 'node:fs';\nimport * as path from 'node:path';\nimport { backfillStateNeedsFreshConversation, type BackfillState } from '../relationship-memory/src/backfill/index.js';\nimport { parseRelationshipMemoryBackfillArgs } from './relationship_memory_backfill_runner.js';",'backfill test imports')
needle="  it('lets both legacy entry modules be imported without starting a CLI run', async () => {\n"
newtest="""  it('reuses clean paused checkpoints but rotates checkpointed retryable batches through the existing recovery boundary', () => {
    const clean: BackfillState = { schema_version: 1, backfill_session_id: 'session', conversation_id: 'conversation-old', agent_id: 'agent-old', sources: {} };
    const retryable: BackfillState = { ...clean, sources: { '/tmp/source.jsonl': { generation: 0, committed_offset: 123, integrity_chunks: [], blocked: { kind: 'retryable_batch', offset: 123 } } } };
    expect(backfillStateNeedsFreshConversation(clean)).toBe(false);
    expect(backfillStateNeedsFreshConversation(retryable)).toBe(true);
    const runner = fs.readFileSync(path.join(process.cwd(), 'scripts/relationship_memory_backfill_runner.ts'), 'utf8');
    expect(runner).toContain('if (!state.conversation_id || retryingBlockedBatch)');
    expect(runner).toContain('Rotated observer conversation before retrying a checkpointed retryable batch');
  });

"""
s=replace_once(s,needle,newtest+needle,'backfill migration test')
write(p,s)

# 8. Structural acceptance before npm: no old standalone tool, AgentFile and MD snapshots match.
names=[f'memory_remember_{k}' for k in ('personal_experience','shared_experience','relationship_event','inside_joke','user_preference')]
for af,md in [('Subconscious.af','config/live-system.md'),('SubconsciousBackfill.af','config/backfill-system.md')]:
    d=json.loads(read(af)); agent=d['agents'][0]; expected=read(md).rstrip('\n')
    assert agent['system']==expected and agent['messages'][0]['content'][0]['text'].startswith(expected)
live=json.loads(read('Subconscious.af')); tg=next(b['value'] for b in live['blocks'] if b.get('label')=='tool_guidelines')
assert all(name in tg for name in names)
assert not re.search(r'\bmemory_remember\b(?!_)',tg)
assert 'export function memoryRememberToolSchema' not in read('relationship-memory/src/tools/index.ts')
assert "name: 'memory_remember'" not in read('relationship-memory/src/adapter/index.ts')
print('task-06 apply: structural checks passed')
