export const MEMORY_KINDS = [
  'personal_experience',
  'shared_experience',
  'relationship_event',
  'inside_joke',
  'user_preference',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type ParticipantRole = 'user' | 'assistant';
export type TranscriptEvidenceKind = 'user_text' | 'assistant_text' | 'assistant_tool_use' | 'tool_result';
export type RememberOutcomeKind = 'accepted' | 'duplicate' | 'permanently_rejected' | 'retryable_failed';
export type BatchCompletion = 'completed' | 'retryable_failure';
export type AssistantIntentOutcomeKind = RememberOutcomeKind;
export const ENTITY_TYPES = ['user', 'assistant', 'other'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface CanonicalMessage {
  conversation_id: string;
  message_id: string;
  role: ParticipantRole;
  quote: string;
  captured_at: string;
  /** Stable backend-owned transcript-event identity. Legacy message evidence may omit this. */
  evidence_id?: string;
  event_kind?: TranscriptEvidenceKind;
  block_index?: number;
  tool_name?: string;
  tool_use_id?: string;
}

export interface MemoryProposalV1 {
  schema_version: 1;
  kind: MemoryKind;
  summary: string;
  participants: ParticipantRole[];
  evidence_message_ids: string[];
  payload: Record<string, unknown>;
  linked_memory_ids?: string[];
  assistant_intent_id?: string;
}

export interface EntityIdentityProposalV1 {
  schema_version: 1;
  canonical_name: string;
  aliases: string[];
  entity_type: EntityType;
  description: string;
  evidence_message_ids: string[];
}

export interface EntityIdentityRecord {
  schema_version: 1;
  entity_id: string;
  subject_id: string;
  canonical_name: string;
  aliases: string[];
  entity_type: EntityType;
  description: string;
  observed_at: string;
  created_at: string;
  source_key: string;
}

export interface EntityEvidenceRecord {
  evidence_id: string;
  entity_id: string;
  conversation_id: string;
  message_id: string;
  role: ParticipantRole;
  quote: string;
  captured_at: string;
  source_evidence_id?: string;
  event_kind?: TranscriptEvidenceKind;
  block_index?: number;
  tool_name?: string;
  tool_use_id?: string;
}

export interface EntityOutcome {
  batch_id: string;
  attempt_id?: string;
  source_key: string;
  outcome: RememberOutcomeKind;
  entity_id?: string;
  rejection_code?: string;
  reason?: string;
  recorded_at: string;
}

export interface EntityValidationResult {
  ok: boolean;
  proposal?: EntityIdentityProposalV1;
  code?: string;
  reason?: string;
}

export interface AssistantRememberIntentRecord {
  schema_version: 1;
  intent_id: string;
  subject_id: string;
  session_id: string;
  assistant_message_id: string;
  tool_use_id: string;
  tool_name: string;
  memory: { text: string };
  feel: { text: string };
  captured_at: string;
}

export interface AssistantIntentOutcome {
  intent_id: string;
  batch_id: string;
  attempt_id?: string;
  outcome: AssistantIntentOutcomeKind;
  memory_id?: string;
  rejection_code?: string;
  reason?: string;
  recorded_at: string;
}

export interface CanonicalMemoryRecord {
  schema_version: 1;
  memory_id: string;
  subject_id: string;
  kind: MemoryKind;
  summary: string;
  participants: ParticipantRole[];
  payload: Record<string, unknown>;
  linked_memory_ids?: string[];
  status: 'active';
  observed_at: string;
  created_at: string;
  source_key: string;
  dedupe_key: string;
}

export interface ReinforcementRecord {
  schema_version: 1;
  reinforcement_id: string;
  memory_id: string;
  batch_id: string;
  evidence_ids: string[];
  latest_evidence_at: string;
  recorded_at: string;
}

export interface EvidenceRecord {
  evidence_id: string;
  memory_id: string;
  conversation_id: string;
  message_id: string;
  role: ParticipantRole;
  quote: string;
  captured_at: string;
  source_evidence_id?: string;
  event_kind?: TranscriptEvidenceKind;
  block_index?: number;
  tool_name?: string;
  tool_use_id?: string;
}

export interface RememberOutcome {
  batch_id: string;
  attempt_id?: string;
  source_key: string;
  outcome: RememberOutcomeKind;
  memory_id?: string;
  rejection_code?: string;
  reason?: string;
  recorded_at: string;
}

export interface BatchRecord {
  batch_id: string;
  attempt_id?: string;
  status: 'pending' | BatchCompletion;
  created_at: string;
  finalized_at?: string;
  detail?: 'no_memory_required';
}

export interface ValidationResult {
  ok: boolean;
  proposal?: MemoryProposalV1;
  code?: string;
  reason?: string;
}

const commonKeys = new Set([
  'schema_version', 'kind', 'summary', 'participants', 'evidence_ids', 'evidence_message_ids', 'payload', 'linked_memory_ids', 'assistant_intent_id',
]);
const forbiddenAuthorityKeys = new Set([
  'memory_id', 'subject_id', 'status', 'observed_at', 'created_at', 'conversation_id', 'role', 'quote', 'captured_at',
]);

export type MemoryPayloadValueType = 'string' | 'string_array';

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
} satisfies Record<MemoryKind, MemoryKindDefinition>;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanStringArray(value: unknown, requireNonEmpty = false): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanString(item);
    if (!text || seen.has(text)) return null;
    seen.add(text);
    cleaned.push(text);
  }
  if (requireNonEmpty && cleaned.length === 0) return null;
  return cleaned;
}

export function normalizeEntityAlias(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function containsHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

const semanticProseFields: Record<MemoryKind, string[]> = {
  personal_experience: ['experience', 'emotional_tone', 'why_memorable'],
  shared_experience: ['event', 'shared_meaning'],
  relationship_event: ['event', 'meaning', 'prior_context', 'resulting_change'],
  inside_joke: ['meaning', 'origin', 'tone'],
  user_preference: ['preference', 'context', 'reason'],
};

function validateChineseSemanticProse(kind: MemoryKind, summary: string, payload: Record<string, unknown>): ValidationResult | null {
  if (!containsHan(summary)) return reject('non_chinese_semantic_prose', 'summary must contain Chinese semantic prose for DS-authored canonical writes.');
  for (const field of semanticProseFields[kind]) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim() && !containsHan(value)) {
      return reject('non_chinese_semantic_prose', `${kind}.${field} must contain Chinese semantic prose for DS-authored canonical writes.`);
    }
  }
  return null;
}

function reject(code: string, reason: string): ValidationResult {
  return { ok: false, code, reason };
}

export interface SemanticContentValidationResult {
  ok: boolean;
  content?: OwnerSemanticContent;
  code?: string;
  reason?: string;
}

export function validateSemanticContent(
  input: unknown,
  options: { requireChineseSemanticProse?: boolean } = {},
): SemanticContentValidationResult {
  if (!plainObject(input)) return { ok: false, code: 'invalid_schema', reason: 'Semantic content must be an object.' };
  const allowedFields = new Set(['schema_version', 'kind', 'summary', 'participants', 'payload', 'linked_memory_ids']);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) return { ok: false, code: 'unknown_field', reason: `Unknown semantic content field: ${key}` };
    if (forbiddenAuthorityKeys.has(key)) return { ok: false, code: 'authority_field_forbidden', reason: `Authoritative field is backend-owned: ${key}` };
  }
  if (input.schema_version !== 1) return { ok: false, code: 'invalid_schema_version', reason: 'schema_version must be literal 1.' };
  if (!MEMORY_KINDS.includes(input.kind as MemoryKind)) return { ok: false, code: 'invalid_kind', reason: 'Unsupported relationship-memory kind.' };
  const kind = input.kind as MemoryKind;
  const summary = cleanString(input.summary);
  if (!summary) return { ok: false, code: 'invalid_summary', reason: 'summary must be a non-empty string.' };

  const participants = cleanStringArray(input.participants, true);
  if (!participants || participants.length > 2 || participants.some((r) => r !== 'user' && r !== 'assistant')) {
    return { ok: false, code: 'invalid_participants', reason: 'participants must contain one or two unique roles: user and/or assistant.' };
  }

  let linkedMemoryIds: string[] | undefined;
  if ('linked_memory_ids' in input) {
    const cleaned = cleanStringArray(input.linked_memory_ids);
    if (!cleaned) return { ok: false, code: 'invalid_linked_memory_ids', reason: 'linked_memory_ids must be a unique non-empty string array when present.' };
    linkedMemoryIds = cleaned;
  }

  if (!plainObject(input.payload)) return { ok: false, code: 'invalid_payload', reason: 'payload must be an object.' };
  const definition = MEMORY_KIND_DEFINITIONS[kind];
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

  if (options.requireChineseSemanticProse) {
    const languageFailure = validateChineseSemanticProse(kind, summary, payload);
    if (languageFailure) return languageFailure;
  }

  return {
    ok: true,
    content: {
      kind,
      summary,
      participants: participants as ParticipantRole[],
      payload,
      ...(linkedMemoryIds ? { linked_memory_ids: linkedMemoryIds } : {}),
    },
  };
}

export function validateProposal(input: unknown, options: { requireChineseSemanticProse?: boolean } = {}): ValidationResult {
  if (!plainObject(input)) return reject('invalid_schema', 'Proposal must be an object.');
  for (const key of Object.keys(input)) {
    if (!commonKeys.has(key)) return reject('unknown_field', `Unknown proposal field: ${key}`);
    if (forbiddenAuthorityKeys.has(key)) return reject('authority_field_forbidden', `Authoritative field is backend-owned: ${key}`);
  }

  const semantic = validateSemanticContent({
    schema_version: input.schema_version,
    kind: input.kind,
    summary: input.summary,
    participants: input.participants,
    payload: input.payload,
    ...('linked_memory_ids' in input ? { linked_memory_ids: input.linked_memory_ids } : {}),
  }, options);
  if (!semantic.ok || !semantic.content) return reject(semantic.code ?? 'invalid_schema', semantic.reason ?? 'Invalid semantic content.');

  if ('evidence_ids' in input && 'evidence_message_ids' in input) return reject('ambiguous_evidence_ids', 'Supply evidence_ids or legacy evidence_message_ids, not both.');
  const evidenceIds = cleanStringArray(input.evidence_ids ?? input.evidence_message_ids, true);
  if (!evidenceIds) return reject('invalid_evidence_ids', 'evidence_ids (or legacy evidence_message_ids) must be a non-empty unique string array.');

  let assistantIntentId: string | undefined;
  if ('assistant_intent_id' in input) {
    const cleaned = cleanString(input.assistant_intent_id);
    if (!cleaned) return reject('invalid_assistant_intent_id', 'assistant_intent_id must be a non-empty string when present.');
    assistantIntentId = cleaned;
  }

  return {
    ok: true,
    proposal: {
      schema_version: 1,
      kind: semantic.content.kind,
      summary: semantic.content.summary,
      participants: semantic.content.participants,
      evidence_message_ids: evidenceIds,
      payload: semantic.content.payload,
      ...(semantic.content.linked_memory_ids ? { linked_memory_ids: semantic.content.linked_memory_ids } : {}),
      ...(assistantIntentId ? { assistant_intent_id: assistantIntentId } : {}),
    },
  };
}

export function validateEntityIdentityProposal(
  input: unknown,
  options: { requireChineseSemanticProse?: boolean } = {},
): EntityValidationResult {
  if (!plainObject(input)) return { ok: false, code: 'invalid_schema', reason: 'Entity identity proposal must be an object.' };
  const allowed = new Set(['schema_version', 'canonical_name', 'aliases', 'entity_type', 'description', 'evidence_ids', 'evidence_message_ids']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) return { ok: false, code: 'unknown_field', reason: `Unknown entity identity field: ${key}` };
  if (input.schema_version !== 1) return { ok: false, code: 'invalid_schema_version', reason: 'schema_version must be literal 1.' };
  const canonicalName = cleanString(input.canonical_name);
  if (!canonicalName) return { ok: false, code: 'invalid_canonical_name', reason: 'canonical_name must be a non-empty string.' };
  if (!ENTITY_TYPES.includes(input.entity_type as EntityType)) return { ok: false, code: 'invalid_entity_type', reason: 'entity_type must be user, assistant, or other.' };
  const description = cleanString(input.description);
  if (!description) return { ok: false, code: 'invalid_description', reason: 'description must be a non-empty string.' };
  if (options.requireChineseSemanticProse && !containsHan(description)) {
    return { ok: false, code: 'non_chinese_semantic_prose', reason: 'entity description must contain Chinese semantic prose for DS-authored canonical writes.' };
  }
  const rawAliases = cleanStringArray(input.aliases, true);
  if (!rawAliases) return { ok: false, code: 'invalid_aliases', reason: 'aliases must be a non-empty unique string array.' };
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of [canonicalName, ...rawAliases]) {
    const normalized = normalizeEntityAlias(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(value);
  }
  if ('evidence_ids' in input && 'evidence_message_ids' in input) return { ok: false, code: 'ambiguous_evidence_ids', reason: 'Supply evidence_ids or legacy evidence_message_ids, not both.' };
  const evidenceIds = cleanStringArray(input.evidence_ids ?? input.evidence_message_ids, true);
  if (!evidenceIds) return { ok: false, code: 'invalid_evidence_ids', reason: 'evidence_ids (or legacy evidence_message_ids) must be a non-empty unique string array.' };
  return { ok: true, proposal: { schema_version: 1, canonical_name: canonicalName, aliases, entity_type: input.entity_type as EntityType, description, evidence_message_ids: evidenceIds } };
}

export type OwnerRevisionAction = 'revise' | 'deactivate' | 'restore';

export interface OwnerSemanticContent {
  kind: MemoryKind;
  summary: string;
  participants: ParticipantRole[];
  payload: Record<string, unknown>;
  linked_memory_ids?: string[];
}

export interface OwnerRevisionRecord {
  schema_version: 1;
  revision_id: string;
  subject_id: string;
  memory_id: string;
  action: OwnerRevisionAction;
  recorded_at: string;
  note?: string;
  replacement?: OwnerSemanticContent;
}

export interface EffectiveMemoryRecord extends Omit<CanonicalMemoryRecord, 'status'> {
  status: 'active' | 'inactive';
  owner_corrected: boolean;
  latest_revision_id?: string;
  latest_revision_at?: string;
  reinforcement_count?: number;
  reinforcement_evidence_count?: number;
  reinforcement_evidence_ids?: string[];
  latest_reinforcement_at?: string;
}
