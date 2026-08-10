import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRecallTools,
  executeRecall,
  RECALL_ALLOWED_CLIENT_TOOLS,
  RECALL_FORBIDDEN_CLIENT_TOOLS,
  type RecallResult,
  type RelationshipMemoryRecallSession,
} from '../relationship-memory/src/recall/index.js';
import { getConfiguredAgentIdReadOnly } from './agent_config.js';
import { buildLettaApiUrl } from './letta_api_url.js';
import { disableLettaCodeAutoUpdater } from './letta_code_runtime_env.js';
import { createConversation } from './conversation_utils.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const LOG_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(LOG_DIR, 'recall_runtime.log');

function log(message: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch { /* logging must never break recall */ }
}

function safeErrorForLog(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function deleteConversation(apiKey: string, conversationId: string): Promise<void> {
  try {
    const response = await fetch(buildLettaApiUrl(`/conversations/${conversationId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      log(`Recall conversation cleanup returned HTTP ${response.status}`);
    }
  } catch (error) {
    log(`Recall conversation cleanup failed: ${safeErrorForLog(error)}`);
  }
}

function recallPrompt(session: RelationshipMemoryRecallSession, query: string): string {
  return `<relationship_memory_recall recall_id="${escapeXml(session.recallId)}">
<query>${escapeXml(query)}</query>
<instructions>
You are in a one-shot, read-only relationship-memory recall mode for the primary Claude Code assistant.
Investigate only with relationship_memory_search, transcript_search, and transcript_read. Canonical relationship memory and direct Claude transcript JSONL are the trusted sources. Do not rely on your own prior conversational context as evidence.
For transcript evidence, use transcript_search first and transcript_read when context is needed before synthesis. Do not invent source_ref values. Call only one tool at a time; wait for each tool result before issuing the next tool call.
You cannot write memory, mutate owner state, advance observer batches, edit files, or inject into Claude by any other channel.
Finish exactly once by calling deliver_recall with this exact recall_id, a concise natural-language answer to the query, and only source_refs that were actually returned by trusted read tools in this recall. If evidence is absent, say so in the answer and deliver with the evidence you actually found (possibly an empty source_refs list).
Do not treat ordinary assistant prose as delivery; deliver_recall is the only terminal channel.
</instructions>
</relationship_memory_recall>`;
}

async function runLettaRecallModel(core: RelationshipMemoryRecallSession, query: string, signal: AbortSignal): Promise<void> {
  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) throw new Error('LETTA_API_KEY is not set');
  const agentId = getConfiguredAgentIdReadOnly();
  disableLettaCodeAutoUpdater();
  const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');
  const conversationId = await createConversation(apiKey, agentId, log);
  let sdkSession: any = null;
  let deliveryResolve!: () => void;
  const delivered = new Promise<void>((resolve) => { deliveryResolve = resolve; });
  let abortResolve!: () => void;
  const aborted = new Promise<void>((resolve) => { abortResolve = resolve; });
  const onAbort = () => {
    try { sdkSession?.close(); } catch { /* best effort */ }
    abortResolve();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const tools = buildRecallTools(core, jsonResult).map((tool) => {
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        async execute(toolCallId: string, args: unknown) {
          log(`Recall ${core.recallId} trusted tool execute: ${tool.name}`);
          const result = await execute(toolCallId, args);
          if (tool.name === 'deliver_recall') {
            deliveryResolve();
            setImmediate(() => { try { sdkSession?.close(); } catch { /* best effort */ } });
          }
          return result;
        },
      };
    });
    const sessionOptions: Record<string, unknown> = {
      allowedTools: [...RECALL_ALLOWED_CLIENT_TOOLS],
      disallowedTools: [...RECALL_FORBIDDEN_CLIENT_TOOLS],
      tools,
      permissionMode: 'bypassPermissions',
      cwd: process.cwd(),
      skillSources: [],
      systemInfoReminder: false,
      sleeptime: { trigger: 'off' },
      memfsStartup: 'skip',
    };
    log(`Starting recall ${core.recallId} in isolated conversation ${conversationId}`);
    sdkSession = resumeSession(conversationId, sessionOptions);
    await sdkSession.send(recallPrompt(core, query));

    const drain = (async () => {
      for await (const msg of sdkSession.stream()) {
        if ((msg as any).type === 'tool_call' && (msg as any).toolName) log(`Recall ${core.recallId} stream tool: ${(msg as any).toolName}`);
        if ((msg as any).type === 'error') throw new Error((msg as any).message || 'Letta SDK recall stream error');
      }
    })();
    const winner = await Promise.race([
      drain.then(() => 'stream' as const),
      delivered.then(() => 'delivered' as const),
      aborted.then(() => 'aborted' as const),
    ]);
    if (winner === 'aborted') throw new Error('Recall aborted');
    if (winner === 'stream' && !core.delivery) throw new Error('Recall stream ended without deliver_recall');
    log(`Recall ${core.recallId} terminal delivery received`);
    void drain.catch((error) => log(`Recall ${core.recallId} drain after terminal: ${safeErrorForLog(error)}`));
  } catch (error) {
    log(`Recall ${core.recallId} model/transport failure: ${safeErrorForLog(error)}`);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { sdkSession?.close(); } catch { /* best effort */ }
    await deleteConversation(apiKey, conversationId);
  }
}

function parseTimeoutMs(): number {
  const raw = Number.parseInt(process.env.RELATIONSHIP_MEMORY_RECALL_TIMEOUT_MS || '90000', 10);
  if (!Number.isFinite(raw) || raw < 100) return 90_000;
  return Math.min(raw, 10 * 60_000);
}

export async function recallFromEnvironment(query: string, signal?: AbortSignal): Promise<RecallResult> {
  const rootDir = process.env.RELATIONSHIP_MEMORY_DIR || path.join(os.homedir(), '.local', 'share', 'relationship-memory');
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  return executeRecall({
    query,
    rootDir,
    subjectId,
    timeoutMs: parseTimeoutMs(),
    signal,
    runModel: runLettaRecallModel,
  });
}
