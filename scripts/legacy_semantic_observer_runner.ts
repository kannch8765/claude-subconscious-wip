import type { LegacyAssistantMemorySourceRecord } from '../relationship-memory/src/legacy/index.js';
import {
  LEGACY_OBSERVER_CONTRACT,
} from '../relationship-memory/src/legacy/index.js';
import {
  LegacySemanticMutationRuntime,
  LEGACY_MEMORY_PAYLOAD_GUIDE,
  legacyMemoryCreateToolSchema,
  sanitizeLegacySourceForObserver,
  legacyMemoryExistingToolSchema,
  legacySourceCompleteToolSchema,
  type LegacySemanticProcessorResult,
} from '../relationship-memory/src/legacy/semantic.js';
import {
  buildRelationshipTools,
  createRuntime,
  RELATIONSHIP_DISALLOWED_CLIENT_TOOLS,
} from '../relationship-memory/src/adapter/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { disableLettaCodeAutoUpdater } from './letta_code_runtime_env.js';

export interface LegacySemanticObserverInput {
  agentId: string;
  conversationId: string;
  source: LegacyAssistantMemorySourceRecord;
  batchId: string;
  rootDir: string;
  subjectId: string;
  cwd: string;
  log?: (message: string) => void;
}

const LEGACY_ALLOWED_TOOLS = [
  'memory_search',
  'legacy_memory_create',
  'legacy_memory_duplicate_link',
  'legacy_memory_reinforce',
  'legacy_source_complete',
] as const;

const LEGACY_EXTRA_DISALLOWED = ['memory_remember', 'memory_reinforce', 'entity_search', 'entity_remember'] as const;

function sourceMessage(source: LegacyAssistantMemorySourceRecord): string {
  return [
    LEGACY_OBSERVER_CONTRACT,
    '',
    'You are processing exactly one immutable legacy source in this run.',
    'Use memory_search before deciding duplicate/reinforcement versus creation when useful.',
    'Apply a strict relationship-memory relevance gate before mutating: ordinary technical implementation, bug-fix, deployment, configuration, monitoring, or operational-status facts are no_memory_required unless they carry durable preference, identity/role significance, a personally or jointly lived experience with enduring human meaning, a relationship event/change, or inside-joke/shared-language value. Importance or technical detail alone is never sufficient.',
    'Preserve actor/action fidelity literally: assistant-authored provenance does NOT make an unstated actor the assistant. If the source omits who performed an action, keep the canonical prose actorless/neutral. Preserve explicit names as written unless this source itself establishes an identity mapping; never silently map Sol, Sonnet, 晴, ゆう, Claude, GPT, or another named actor onto user/assistant. Also preserve action strength literally: do not upgrade 管理/拥有/位于 into 建立/创建/迁移/提交/实现 or otherwise invent an action absent from the source. Keep actorless/passive status wording actorless: 项目完成/代码已写/测试通过/列为候选 must not become 用户完成/琥珀完成/克宝完成/琥珀提出. An explicit first-person pronoun in this legacy assistant-authored source is an explicit actor; an omitted subject is not.',
    'Use legacy_memory_create once per distinct canonical semantic item; one source may require several calls.',
    'The payload contract is fully specified below. Never make test/probe/placeholder create calls to discover schema fields; every create call mutates canonical memory and must be source-faithful.',
    LEGACY_MEMORY_PAYLOAD_GUIDE,
    'Use legacy_memory_duplicate_link for an already-canonical semantic item that needs provenance but no reinforcement.',
    'Use legacy_memory_reinforce only when this historical source genuinely reinforces the same underlying canonical memory.',
    'When semantic processing is finished, you MUST call legacy_source_complete with completed, or no_memory_required if and only if no canonical provenance was written.',
    'Do not include legacy_source_id in tool arguments; the runtime binds every mutation to this source.',
    '',
    'IMMUTABLE_LEGACY_SOURCE_JSON:',
    JSON.stringify(sanitizeLegacySourceForObserver(source)),
  ].join('\n');
}

export async function runLegacySemanticObserverSource(input: LegacySemanticObserverInput): Promise<LegacySemanticProcessorResult> {
  const log = input.log ?? (() => {});
  const canonicalStore = new RelationshipMemoryStore(input.rootDir, input.subjectId);
  const latest = [...canonicalStore.listBatches()].reverse().find((item) => item.batch_id === input.batchId);
  if (latest?.status === 'completed') {
    return { completion: latest.detail === 'no_memory_required' ? 'no_memory_required' : 'completed' };
  }
  canonicalStore.beginBatch(input.batchId, new Date().toISOString());

  const mutationRuntime = new LegacySemanticMutationRuntime(input.rootDir, input.subjectId, input.source, input.batchId);
  const searchRuntime = createRuntime([], input.subjectId, input.rootDir);
  let session: any = null;
  let sessionSucceeded = true;
  let toolRetryableFailure = false;

  try {
    disableLettaCodeAutoUpdater();
    const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');
    const searchTool = buildRelationshipTools(searchRuntime, input.batchId, jsonResult).find((tool) => tool.name === 'memory_search');
    if (!searchTool) throw new Error('memory_search tool unavailable for legacy semantic observer');

    const wrapMutation = (fn: (args: any) => any) => async (_toolCallId: string, args: unknown) => {
      const result = fn(args);
      if (result?.outcome === 'retryable_failed') toolRetryableFailure = true;
      return jsonResult(result);
    };
    const tools: any[] = [
      searchTool,
      {
        label: 'legacy_memory_create', name: 'legacy_memory_create',
        description: 'Create or dedupe-link one canonical relationship memory derived from the currently bound immutable legacy source. The source identity is backend-bound. For feel/ sources historical_temporality is required.',
        parameters: legacyMemoryCreateToolSchema(input.source),
        execute: wrapMutation((args) => mutationRuntime.createMemory(args)),
      },
      {
        label: 'legacy_memory_duplicate_link', name: 'legacy_memory_duplicate_link',
        description: 'Link the currently bound immutable legacy source to one existing canonical memory that already represents this semantic item; does not create a new memory.',
        parameters: legacyMemoryExistingToolSchema(),
        execute: wrapMutation((args) => mutationRuntime.duplicateLink(typeof args?.memory_id === 'string' ? args.memory_id : '')),
      },
      {
        label: 'legacy_memory_reinforce', name: 'legacy_memory_reinforce',
        description: 'Reinforce one existing canonical memory from the currently bound immutable legacy source and record legacy provenance. Use only for the same underlying semantic memory, not lexical similarity.',
        parameters: legacyMemoryExistingToolSchema(),
        execute: wrapMutation((args) => mutationRuntime.reinforce(typeof args?.memory_id === 'string' ? args.memory_id : '')),
      },
      {
        label: 'legacy_source_complete', name: 'legacy_source_complete',
        description: 'Explicitly finish semantic evaluation of the currently bound legacy source. Use completed only after at least one provenance outcome; use no_memory_required only when none was written.',
        parameters: legacySourceCompleteToolSchema(),
        async execute(_toolCallId: string, args: any) {
          return jsonResult(mutationRuntime.complete(args?.result === 'no_memory_required' ? 'no_memory_required' : 'completed'));
        },
      },
    ];

    const disallowedTools = [...RELATIONSHIP_DISALLOWED_CLIENT_TOOLS, ...LEGACY_EXTRA_DISALLOWED];
    session = (resumeSession as any)(input.conversationId, {
      disallowedTools,
      allowedTools: [...LEGACY_ALLOWED_TOOLS],
      tools,
      permissionMode: 'bypassPermissions',
      cwd: input.cwd,
      skillSources: [],
      systemInfoReminder: false,
      sleeptime: { trigger: 'off' },
      memfsStartup: 'skip',
    });
    const init = await session.initialize();
    const known = new Set<string>([...LEGACY_ALLOWED_TOOLS, ...disallowedTools]);
    const unexpected = [...new Set((Array.isArray(init?.tools) ? init.tools : []).filter((name: string) => !known.has(name)))].sort();
    if (unexpected.length) throw new Error(`Unexpected Letta Code tool inventory for legacy semantic observer: ${unexpected.join(', ')}`);

    log(`Sending legacy semantic source ${input.source.legacy_source_id}`);
    await session.send(sourceMessage(input.source));
    for await (const msg of session.stream()) {
      if (msg.type === 'error') {
        sessionSucceeded = false;
        log(`Legacy semantic observer error: ${(msg as any).message}`);
      }
    }
  } catch (error) {
    sessionSucceeded = false;
    log(`Legacy semantic observer session failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (session) session.close();
  }

  const completion = mutationRuntime.completionState();
  const retryable = !sessionSucceeded || toolRetryableFailure || !completion;
  const now = new Date().toISOString();
  canonicalStore.finalizeBatch({
    batch_id: input.batchId,
    status: retryable ? 'retryable_failure' : 'completed',
    created_at: canonicalStore.listBatches().find((item) => item.batch_id === input.batchId)?.created_at ?? now,
    finalized_at: now,
    ...(!retryable && completion === 'no_memory_required' ? { detail: 'no_memory_required' as const } : {}),
  });
  if (retryable) return { completion: 'retryable_failure', reason: !completion ? 'observer ended without explicit legacy_source_complete' : 'observer/tool session retryable failure' };
  return { completion };
}
