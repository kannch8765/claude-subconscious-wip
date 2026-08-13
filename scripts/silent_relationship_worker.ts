#!/usr/bin/env npx tsx
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { appendTrustedRelationshipCatalog, buildRelationshipTools, createRuntime, relationshipMemoryRoot, RELATIONSHIP_ALLOWED_CLIENT_TOOLS, RELATIONSHIP_DISALLOWED_CLIENT_TOOLS } from '../relationship-memory/src/adapter/index.js';
import { stableJson } from '../relationship-memory/src/store/index.js';
import { cursorShouldAdvance } from '../relationship-memory/src/tools/index.js';
import { buildLettaApiUrl } from './letta_api_url.js';

interface Payload { agentId: string; conversationId: string; sessionId: string; message: string; stateFile: string; newLastProcessedIndex: number; cwd: string; batchId: string; canonicalMessages: CanonicalMessage[]; assistantIntents: AssistantRememberIntentRecord[]; }
const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const logFile = path.join(os.tmpdir(), `letta-claude-sync-${uid}`, 'silent_relationship_worker.log');
function log(message: string) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`); } catch {} }
async function cleanup(apiKey: string, conversationId: string) { try { await fetch(buildLettaApiUrl(`/conversations/${conversationId}`), { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } }); } catch {} }

async function run(payload: Payload): Promise<'completed'|'retryable_failure'> {
  const apiKey = process.env.LETTA_API_KEY; if (!apiKey) throw new Error('LETTA_API_KEY is not set');
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  const runtime = createRuntime(payload.canonicalMessages, subjectId, relationshipMemoryRoot(), payload.assistantIntents ?? []);
  const existing = [...runtime.store.listBatches()].reverse().find((item) => item.batch_id === payload.batchId);
  if (existing?.status === 'completed') return 'completed';
  runtime.store.beginBatch(payload.batchId, new Date().toISOString());
  let ok = true; let session: any;
  try {
    const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');
    const tools = buildRelationshipTools(runtime, payload.batchId, jsonResult).map((tool) => {
      if (!['memory_remember','memory_reinforce','entity_remember'].includes(tool.name)) return tool;
      const execute = tool.execute.bind(tool);
      return { ...tool, async execute(id: string, args: unknown) { return runtime.store.withMutationBoundary(() => execute(id, args)); } };
    });
    for (const intent of payload.assistantIntents ?? []) { const stored = runtime.store.getAssistantIntent(intent.intent_id); if (!stored || stableJson(stored) !== stableJson(intent)) throw new Error(`assistant intent mismatch: ${intent.intent_id}`); }
    session = resumeSession(payload.conversationId, { allowedTools: [...RELATIONSHIP_ALLOWED_CLIENT_TOOLS], disallowedTools: [...RELATIONSHIP_DISALLOWED_CLIENT_TOOLS], tools, permissionMode: 'bypassPermissions', cwd: payload.cwd, skillSources: [], systemInfoReminder: false, sleeptime: { trigger: 'off' }, memfsStartup: 'skip' });
    await session.send(appendTrustedRelationshipCatalog(payload.message, payload.canonicalMessages, payload.assistantIntents ?? []));
    for await (const msg of session.stream()) { if ((msg as any).type === 'tool_call') log(`tool ${(msg as any).toolName}`); if ((msg as any).type === 'error') ok = false; }
  } catch (error) { ok = false; log(error instanceof Error ? error.message : String(error)); }
  finally { try { session?.close(); } catch {} await cleanup(apiKey, payload.conversationId); }
  return runtime.store.withMutationBoundary(() => runtime.finalizeBatch(payload.batchId, ok));
}

const file = process.argv[2]; if (!file) process.exit(1);
(async () => {
  const payload: Payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  let completion: 'completed'|'retryable_failure' = 'retryable_failure';
  try { completion = await run(payload); } catch (error) { log(error instanceof Error ? error.message : String(error)); }
  if (cursorShouldAdvance(completion)) { const state = JSON.parse(fs.readFileSync(payload.stateFile, 'utf8')); state.lastProcessedIndex = payload.newLastProcessedIndex; fs.writeFileSync(payload.stateFile, JSON.stringify(state, null, 2)); }
  try { fs.unlinkSync(file); } catch {}
  process.exit(completion === 'completed' ? 0 : 1);
})();
