import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { extractAllContent, type TranscriptMessage } from '../../../scripts/transcript_utils.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';
import type { AssistantRememberIntentRecord, EffectiveMemoryRecord, MemoryKind } from '../schema/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';
import { createSemanticRetrieverFromEnvironment, hybridScore, lexicalTextScore, semanticText, type SemanticRetriever } from '../retrieval/index.js';

export type RecallSourceKind = 'relationship_memory' | 'entity_identity' | 'transcript_search' | 'transcript_read';
export type RecallStatus = 'ok' | 'timeout' | 'cancelled' | 'failed';

export interface RecallSourceSummary {
  source_ref: string;
  kind: RecallSourceKind;
  memory_id?: string;
  entity_id?: string;
  observed_at?: string;
  transcript_time?: string;
  transcript_role?: 'user' | 'assistant';
  transcript_message_id?: string;
}

export interface RecallResult {
  status: RecallStatus;
  recall_id: string;
  answer?: string;
  source_refs?: string[];
  sources?: RecallSourceSummary[];
  reason?: string;
}

export interface RelationshipMemorySearchInput {
  query?: string;
  kind?: MemoryKind;
  time_start?: string;
  time_end?: string;
  limit?: number;
}

export interface TranscriptSearchInput {
  query?: string;
  time_start?: string;
  time_end?: string;
  limit?: number;
}

export interface TranscriptReadInput {
  source_ref: string;
  before?: number;
  after?: number;
}

export interface DeliverRecallInput {
  recall_id: string;
  answer: string;
  source_refs: string[];
}

interface TranscriptLocator {
  file: string;
  visibleIndex: number;
  messageId?: string;
  timestamp?: string;
  role: 'user' | 'assistant';
}

interface SourceEntry {
  summary: RecallSourceSummary;
  locator?: TranscriptLocator;
}

interface TranscriptCandidate extends TranscriptLocator {
  text: string;
  score: number;
}

export interface RecallTool {
  label: string;
  name: 'relationship_memory_search' | 'transcript_search' | 'transcript_read' | 'deliver_recall';
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, args: unknown): Promise<unknown>;
}

export type RecallResultWrapper = (value: unknown) => unknown;

function cleanText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error('limit must be a positive integer');
  return Math.min(value as number, max);
}

function boundedContext(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('context bounds must be non-negative integers');
  return Math.min(value as number, 5);
}

function tokens(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((token) => token.length > 1);
}

function textScore(haystack: string, query: string | undefined): number {
  if (!query?.trim()) return 1;
  const normalized = haystack.toLowerCase();
  const exact = query.trim().toLowerCase();
  let score = normalized.includes(exact) ? 100 : 0;
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return score;
  let matches = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) {
      matches += 1;
      score += token.length >= 5 ? 4 : 2;
    }
  }
  if (matches === 0) return 0;
  score += Math.round((matches / queryTokens.length) * 20);
  return score;
}

function inTimeWindow(timestamp: string | undefined, start: string | undefined, end: string | undefined): boolean {
  if (!start && !end) return true;
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return false;
  if (start) {
    const lower = Date.parse(start);
    if (!Number.isFinite(lower)) throw new Error('time_start must be an ISO-compatible date/time');
    if (time < lower) return false;
  }
  if (end) {
    const upper = Date.parse(end);
    if (!Number.isFinite(upper)) throw new Error('time_end must be an ISO-compatible date/time');
    if (time > upper) return false;
  }
  return true;
}

function visibleTranscriptMessage(raw: unknown): { role: 'user' | 'assistant'; text: string; timestamp?: string; messageId?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const message = raw as TranscriptMessage;
  if (message.type !== 'user' && message.type !== 'assistant') return null;
  const text = extractAllContent(message).text?.trim();
  if (!text) return null;
  return {
    role: message.type,
    text,
    ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
    ...(typeof message.uuid === 'string' ? { messageId: message.uuid } : {}),
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function transcriptRootsFromEnvironment(): string[] {
  const configured = process.env.RELATIONSHIP_MEMORY_TRANSCRIPT_DIR;
  if (configured) return configured.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  return [path.join(os.homedir(), '.claude', 'projects')];
}

function transcriptFiles(roots: string[]): string[] {
  const maxFiles = Math.max(1, Math.min(Number.parseInt(process.env.RELATIONSHIP_MEMORY_TRANSCRIPT_MAX_FILES || '1000', 10) || 1000, 5000));
  const result: Array<{ file: string; mtime: number }> = [];
  const visit = (entry: string): void => {
    if (result.length >= maxFiles * 2) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(entry); } catch { return; }
    if (stat.isFile()) {
      if (entry.endsWith('.jsonl')) result.push({ file: entry, mtime: stat.mtimeMs });
      return;
    }
    if (!stat.isDirectory()) return;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(entry, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      visit(path.join(entry, child.name));
    }
  };
  for (const root of roots) visit(root);
  return result.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)).slice(0, maxFiles).map((item) => item.file);
}

async function forEachJsonlLine(file: string, visit: (raw: unknown, rawLine: number) => void | Promise<void>): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let rawLine = -1;
  try {
    for await (const line of lines) {
      rawLine += 1;
      if (!line.trim()) continue;
      try { await visit(JSON.parse(line), rawLine); } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export class RelationshipMemoryRecallSession {
  readonly recallId: string;
  readonly store: RelationshipMemoryStore;
  readonly transcriptRoots: string[];
  private readonly sources = new Map<string, SourceEntry>();
  private delivered?: RecallResult;
  private readonly deliveryPromise: Promise<RecallResult>;
  private resolveDelivery!: (result: RecallResult) => void;
  private closedReason?: 'timeout' | 'cancelled' | 'failed';
  private readonly semanticRetriever?: SemanticRetriever;

  constructor(options: {
    recallId?: string;
    rootDir: string;
    subjectId: string;
    transcriptRoots?: string[];
    semanticRetriever?: SemanticRetriever;
  }) {
    this.recallId = options.recallId || `recall_${crypto.randomUUID()}`;
    this.deliveryPromise = new Promise<RecallResult>((resolve) => { this.resolveDelivery = resolve; });
    // ensureRoot=false is important: recall must not create or append store files.
    this.store = new RelationshipMemoryStore(options.rootDir, options.subjectId, undefined, false);
    this.transcriptRoots = options.transcriptRoots ?? transcriptRootsFromEnvironment();
    if (options.semanticRetriever) this.semanticRetriever = options.semanticRetriever;
    else {
      try { this.semanticRetriever = createSemanticRetrieverFromEnvironment(options.rootDir); } catch { this.semanticRetriever = undefined; }
    }
  }

  get isClosed(): boolean { return Boolean(this.delivered || this.closedReason); }
  get delivery(): RecallResult | undefined { return this.delivered; }
  waitForDelivery(): Promise<RecallResult> { return this.deliveryPromise; }

  close(reason: 'timeout' | 'cancelled' | 'failed'): void {
    if (!this.delivered && !this.closedReason) this.closedReason = reason;
  }

  private assertOpen(): void {
    if (this.delivered) throw new Error('Recall already terminally delivered.');
    if (this.closedReason) throw new Error(`Recall is closed: ${this.closedReason}`);
  }

  private register(kind: RecallSourceKind, key: unknown, summary: Omit<RecallSourceSummary, 'source_ref' | 'kind'>, locator?: TranscriptLocator): string {
    this.assertOpen();
    const sourceRef = stableId('recall_src', { recall_id: this.recallId, kind, key });
    this.sources.set(sourceRef, { summary: { source_ref: sourceRef, kind, ...summary }, ...(locator ? { locator } : {}) });
    return sourceRef;
  }

  private linkedAssistantIntents(memoryId: string): AssistantRememberIntentRecord[] {
    const latest = new Map<string, ReturnType<RelationshipMemoryStore['listAssistantIntentOutcomes']>[number]>();
    for (const outcome of this.store.listAssistantIntentOutcomes()) latest.set(outcome.intent_id, outcome);
    const intents: AssistantRememberIntentRecord[] = [];
    for (const [intentId, outcome] of latest) {
      if ((outcome.outcome !== 'accepted' && outcome.outcome !== 'duplicate') || outcome.memory_id !== memoryId) continue;
      const intent = this.store.getAssistantIntent(intentId);
      if (intent) intents.push(intent);
    }
    return intents.sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.intent_id.localeCompare(b.intent_id));
  }

  private relationshipSearchCandidates(input: RelationshipMemorySearchInput): Array<
    { kind: 'memory'; memory: EffectiveMemoryRecord; intents: AssistantRememberIntentRecord[]; text: string; lexicalScore: number }
    | { kind: 'entity'; entity: ReturnType<RelationshipMemoryStore['listEntities']>[number]; text: string; lexicalScore: number }
  > {
    const owner = new RelationshipMemoryOwnerControlPlane(this.store);
    const candidates: Array<
      { kind: 'memory'; memory: EffectiveMemoryRecord; intents: AssistantRememberIntentRecord[]; text: string; lexicalScore: number }
      | { kind: 'entity'; entity: ReturnType<RelationshipMemoryStore['listEntities']>[number]; text: string; lexicalScore: number }
    > = [];
    for (const memory of owner.search({ active: true, ...(input.kind ? { kind: input.kind } : {}) })) {
      if (!inTimeWindow(memory.observed_at, input.time_start, input.time_end)) continue;
      const intents = this.linkedAssistantIntents(memory.memory_id);
      const text = semanticText(memory.kind, memory.summary, memory.participants, memory.payload, intents.map((intent) => [intent.memory.text, intent.feel.text]));
      candidates.push({ kind: 'memory', memory, intents, text, lexicalScore: lexicalTextScore(text, input.query) });
    }
    if (!input.kind) {
      for (const entity of this.store.listEntities()) {
        if (!inTimeWindow(entity.observed_at, input.time_start, input.time_end)) continue;
        const text = semanticText(entity.canonical_name, entity.aliases, entity.entity_type, entity.description);
        candidates.push({ kind: 'entity', entity, text, lexicalScore: lexicalTextScore(text, input.query) });
      }
    }
    return candidates;
  }

  private renderRelationshipSearchResults(
    ranked: Array<
      { kind: 'memory'; memory: EffectiveMemoryRecord; intents: AssistantRememberIntentRecord[]; score: number }
      | { kind: 'entity'; entity: ReturnType<RelationshipMemoryStore['listEntities']>[number]; score: number }
    >,
    limit: number,
  ): { results: unknown[] } {
    ranked.sort((a, b) => b.score - a.score || (b.kind === 'memory' ? b.memory.observed_at : b.entity.observed_at).localeCompare(a.kind === 'memory' ? a.memory.observed_at : a.entity.observed_at));
    return { results: ranked.slice(0, limit).map((item) => {
      if (item.kind === 'entity') {
        const entity = item.entity;
        const sourceRef = this.register('entity_identity', { entity_id: entity.entity_id, source_key: entity.source_key }, { entity_id: entity.entity_id, observed_at: entity.observed_at });
        const evidence = this.store.listEntityEvidence().filter((entry) => entry.entity_id === entity.entity_id);
        return {
          source_ref: sourceRef, record_type: 'entity_identity', entity_id: entity.entity_id, canonical_name: entity.canonical_name, aliases: entity.aliases,
          entity_type: entity.entity_type, description: entity.description, observed_at: entity.observed_at,
          evidence_ids: evidence.map((entry) => entry.evidence_id), evidence_message_ids: evidence.map((entry) => entry.message_id),
        };
      }
      const { memory, intents } = item;
      const sourceRef = this.register('relationship_memory', { memory_id: memory.memory_id, latest_revision_id: memory.latest_revision_id }, { memory_id: memory.memory_id, observed_at: memory.observed_at });
      return { source_ref: sourceRef, record_type: 'relationship_memory', memory_id: memory.memory_id, kind: memory.kind, summary: memory.summary, participants: memory.participants, payload: memory.payload, observed_at: memory.observed_at, owner_corrected: memory.owner_corrected, assistant_intents: intents.map((intent) => ({ intent_id: intent.intent_id, memory: intent.memory.text, feel: intent.feel.text, captured_at: intent.captured_at })) };
    }) };
  }

  relationshipMemorySearch(input: RelationshipMemorySearchInput = {}): { results: unknown[] } {
    this.assertOpen();
    const limit = boundedLimit(input.limit, 8, 20);
    const ranked = this.relationshipSearchCandidates(input)
      .filter((item) => item.lexicalScore > 0)
      .map((item) => item.kind === 'memory'
        ? { kind: 'memory' as const, memory: item.memory, intents: item.intents, score: item.lexicalScore }
        : { kind: 'entity' as const, entity: item.entity, score: item.lexicalScore });
    return this.renderRelationshipSearchResults(ranked, limit);
  }

  async relationshipMemorySearchHybrid(input: RelationshipMemorySearchInput = {}): Promise<{ results: unknown[] }> {
    this.assertOpen();
    const query = input.query?.trim();
    if (!this.semanticRetriever || !query) return this.relationshipMemorySearch(input);
    const limit = boundedLimit(input.limit, 8, 20);
    const candidates = this.relationshipSearchCandidates(input);
    const documents = candidates.map((item) => ({
      id: item.kind === 'memory' ? `memory:${item.memory.memory_id}` : `entity:${item.entity.entity_id}`,
      text: item.text,
    }));
    try {
      const semantic = await this.semanticRetriever.rank(documents, query);
      this.assertOpen();
      const ranked = candidates.map((item, index) => {
        const score = hybridScore(item.lexicalScore, semantic.get(documents[index].id));
        return item.kind === 'memory'
          ? { kind: 'memory' as const, memory: item.memory, intents: item.intents, score }
          : { kind: 'entity' as const, entity: item.entity, score };
      });
      return this.renderRelationshipSearchResults(ranked, limit);
    } catch {
      return this.relationshipMemorySearch(input);
    }
  }

  async transcriptSearch(input: TranscriptSearchInput = {}): Promise<{ results: unknown[] }> {
    this.assertOpen();
    const limit = boundedLimit(input.limit, 10, 20);
    if (!input.query?.trim() && !input.time_start && !input.time_end) {
      throw new Error('transcript_search requires query and/or a time window');
    }
    const candidates: TranscriptCandidate[] = [];
    for (const file of transcriptFiles(this.transcriptRoots)) {
      if (this.isClosed) break;
      let visibleIndex = -1;
      await forEachJsonlLine(file, (raw) => {
        const visible = visibleTranscriptMessage(raw);
        if (!visible) return;
        visibleIndex += 1;
        if (!inTimeWindow(visible.timestamp, input.time_start, input.time_end)) return;
        const score = textScore(visible.text, input.query);
        if (score <= 0) return;
        candidates.push({
          file,
          visibleIndex,
          role: visible.role,
          text: visible.text,
          score,
          ...(visible.timestamp ? { timestamp: visible.timestamp } : {}),
          ...(visible.messageId ? { messageId: visible.messageId } : {}),
        });
        if (candidates.length > 200) {
          candidates.sort((a, b) => b.score - a.score || (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
          candidates.length = 100;
        }
      });
    }
    this.assertOpen();
    candidates.sort((a, b) => b.score - a.score || (b.timestamp ?? '').localeCompare(a.timestamp ?? '') || a.file.localeCompare(b.file) || a.visibleIndex - b.visibleIndex);
    return {
      results: candidates.slice(0, limit).map((candidate) => {
        const locator: TranscriptLocator = {
          file: candidate.file,
          visibleIndex: candidate.visibleIndex,
          role: candidate.role,
          ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}),
          ...(candidate.messageId ? { messageId: candidate.messageId } : {}),
        };
        const sourceRef = this.register('transcript_search', {
          file: candidate.file,
          visible_index: candidate.visibleIndex,
          message_id: candidate.messageId,
          timestamp: candidate.timestamp,
        }, {
          ...(candidate.timestamp ? { transcript_time: candidate.timestamp } : {}),
          transcript_role: candidate.role,
          ...(candidate.messageId ? { transcript_message_id: candidate.messageId } : {}),
        }, locator);
        return {
          source_ref: sourceRef,
          timestamp: candidate.timestamp ?? null,
          role: candidate.role,
          message_id: candidate.messageId ?? null,
          excerpt: truncate(candidate.text, 600),
        };
      }),
    };
  }

  async transcriptRead(input: TranscriptReadInput): Promise<{ source_ref: string; context: unknown[] }> {
    this.assertOpen();
    const sourceRef = cleanText(input?.source_ref, 'source_ref');
    const source = this.sources.get(sourceRef);
    if (!source || source.summary.kind !== 'transcript_search' || !source.locator) {
      throw new Error('transcript_read only accepts a trusted source_ref returned by transcript_search in this recall.');
    }
    const before = boundedContext(input.before, 2);
    const after = boundedContext(input.after, 2);
    const target = source.locator.visibleIndex;
    const context: Array<{ timestamp: string | null; role: 'user' | 'assistant'; message_id: string | null; text: string }> = [];
    let visibleIndex = -1;
    await forEachJsonlLine(source.locator.file, (raw) => {
      const visible = visibleTranscriptMessage(raw);
      if (!visible) return;
      visibleIndex += 1;
      if (visibleIndex < target - before || visibleIndex > target + after) return;
      context.push({
        timestamp: visible.timestamp ?? null,
        role: visible.role,
        message_id: visible.messageId ?? null,
        text: truncate(visible.text, 1600),
      });
    });
    this.assertOpen();
    const readRef = this.register('transcript_read', { parent: sourceRef, before, after, context: context.map((item) => [item.message_id, item.timestamp]) }, {
      ...(source.locator.timestamp ? { transcript_time: source.locator.timestamp } : {}),
      transcript_role: source.locator.role,
      ...(source.locator.messageId ? { transcript_message_id: source.locator.messageId } : {}),
    });
    return { source_ref: readRef, context };
  }

  deliver(input: DeliverRecallInput): RecallResult {
    this.assertOpen();
    if (cleanText(input?.recall_id, 'recall_id') !== this.recallId) throw new Error('deliver_recall recall_id does not match the pending recall.');
    const answer = cleanText(input?.answer, 'answer');
    if (!Array.isArray(input?.source_refs)) throw new Error('source_refs must be an array');
    const sourceRefs = [...new Set(input.source_refs.map((item) => cleanText(item, 'source_ref')))];
    const summaries: RecallSourceSummary[] = [];
    for (const ref of sourceRefs) {
      const source = this.sources.get(ref);
      if (!source) throw new Error(`Unknown or fabricated source_ref: ${ref}`);
      summaries.push(source.summary);
    }
    this.delivered = {
      status: 'ok',
      recall_id: this.recallId,
      answer,
      source_refs: sourceRefs,
      sources: summaries,
    };
    this.resolveDelivery(this.delivered);
    return this.delivered;
  }
}

export function relationshipMemorySearchToolSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference'] },
      time_start: { type: 'string', description: 'Optional ISO-compatible lower time bound.' },
      time_end: { type: 'string', description: 'Optional ISO-compatible upper time bound.' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  };
}

export function transcriptSearchToolSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1 },
      time_start: { type: 'string', description: 'Optional ISO-compatible lower time bound.' },
      time_end: { type: 'string', description: 'Optional ISO-compatible upper time bound.' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  };
}

export function transcriptReadToolSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['source_ref'],
    properties: {
      source_ref: { type: 'string', minLength: 1, description: 'Trusted transcript_search source_ref from this recall.' },
      before: { type: 'integer', minimum: 0, maximum: 5 },
      after: { type: 'integer', minimum: 0, maximum: 5 },
    },
  };
}

export function deliverRecallToolSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['recall_id', 'answer', 'source_refs'],
    properties: {
      recall_id: { type: 'string', minLength: 1 },
      answer: { type: 'string', minLength: 1 },
      source_refs: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    },
  };
}

export function buildRecallTools(session: RelationshipMemoryRecallSession, wrapResult: RecallResultWrapper = (value) => value): RecallTool[] {
  return [
    {
      label: 'relationship_memory_search', name: 'relationship_memory_search',
      description: 'Read-only search over the effective active canonical relationship-memory view, including trusted linked assistant remember memory/feel provenance.',
      parameters: relationshipMemorySearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(await session.relationshipMemorySearchHybrid((args ?? {}) as RelationshipMemorySearchInput)); },
    },
    {
      label: 'transcript_search', name: 'transcript_search',
      description: 'Read-only search over direct Claude Code transcript JSONL. Use query and/or an ISO time window. Results return trusted source handles and bounded excerpts.',
      parameters: transcriptSearchToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(await session.transcriptSearch((args ?? {}) as TranscriptSearchInput)); },
    },
    {
      label: 'transcript_read', name: 'transcript_read',
      description: 'Read bounded visible user/assistant context around one trusted transcript_search hit. Arbitrary files and untrusted handles are rejected.',
      parameters: transcriptReadToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(await session.transcriptRead(args as TranscriptReadInput)); },
    },
    {
      label: 'deliver_recall', name: 'deliver_recall',
      description: 'Terminally deliver the synthesized recall answer for the currently pending recall. Cite only source_ref values returned by trusted read tools in this recall.',
      parameters: deliverRecallToolSchema(),
      async execute(_toolCallId, args) { return wrapResult(session.deliver(args as DeliverRecallInput)); },
    },
  ];
}

export const RECALL_ALLOWED_CLIENT_TOOLS = ['relationship_memory_search', 'transcript_search', 'transcript_read', 'deliver_recall'] as const;
export const RECALL_FORBIDDEN_CLIENT_TOOLS = [
  'memory_remember', 'memory', 'memory_insert', 'memory_replace', 'memory_rethink',
  'owner_revise', 'owner_deactivate', 'owner_restore', 'Write', 'Edit', 'Bash', 'Read', 'Grep', 'Glob',
] as const;

export type RecallModelRunner = (session: RelationshipMemoryRecallSession, query: string, signal: AbortSignal) => Promise<void>;

function boundedFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

export async function executeRecall(options: {
  query: string;
  rootDir: string;
  subjectId: string;
  transcriptRoots?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  runModel: RecallModelRunner;
  recallId?: string;
}): Promise<RecallResult> {
  const query = cleanText(options.query, 'query');
  const timeoutMs = Math.max(100, options.timeoutMs ?? 90_000);
  const session = new RelationshipMemoryRecallSession({
    recallId: options.recallId,
    rootDir: options.rootDir,
    subjectId: options.subjectId,
    transcriptRoots: options.transcriptRoots,
  });
  const controller = new AbortController();
  let externalCancelled = false;
  const onExternalAbort = () => {
    externalCancelled = true;
    session.close('cancelled');
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => {
      session.close('timeout');
      controller.abort(new Error('recall deadline exceeded'));
      resolve('timeout');
    }, timeoutMs);
  });
  let cancelRaceResolve: (() => void) | undefined;
  const cancelled = new Promise<'cancelled'>((resolve) => {
    cancelRaceResolve = () => resolve('cancelled');
    if (options.signal?.aborted) cancelRaceResolve();
    else options.signal?.addEventListener('abort', cancelRaceResolve, { once: true });
  });
  const delivered = session.waitForDelivery().then(() => 'delivered' as const);
  let modelFailureReason = '';
  const model = (async (): Promise<'model_done' | 'model_failed'> => {
    try { await options.runModel(session, query, controller.signal); return 'model_done'; }
    catch (error) { modelFailureReason = boundedFailureReason(error); return 'model_failed'; }
  })();

  try {
    // Successful deliver_recall is itself terminal. Do not keep an accepted
    // delivery inside the deadline while the model runner unwinds or performs
    // best-effort transport cleanup.
    const winner = await Promise.race([delivered, model, timeout, cancelled]);
    // A delivery accepted before a competing timeout/cancel signal is the
    // terminal result, even if that competing promise wins microtask ordering.
    if (session.delivery) return session.delivery;
    if (winner === 'delivered') return session.delivery!;
    if (winner === 'timeout') {
      return { status: 'timeout', recall_id: session.recallId, reason: `Recall exceeded its ${timeoutMs} ms inner deadline.` };
    }
    if (winner === 'cancelled' || externalCancelled) {
      return { status: 'cancelled', recall_id: session.recallId, reason: 'Recall was cancelled before terminal delivery.' };
    }
    if (session.delivery) return session.delivery;
    session.close('failed');
    return {
      status: 'failed',
      recall_id: session.recallId,
      reason: winner === 'model_failed'
        ? `Recall model/Letta transport failed before terminal delivery${modelFailureReason ? `: ${modelFailureReason}` : '.'}`
        : 'Recall model finished without calling deliver_recall.',
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener('abort', onExternalAbort);
    if (cancelRaceResolve) options.signal?.removeEventListener('abort', cancelRaceResolve);
    // The model promise is intentionally not awaited after timeout/cancel. Its tool
    // surface points at the now-closed session, so late delivery cannot escape.
    void model.catch(() => undefined);
  }
}
