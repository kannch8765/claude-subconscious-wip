#!/usr/bin/env npx tsx
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { getAgentId } from './agent_config.js';
import { buildLettaApiUrl } from './letta_api_url.js';
import { mirrorSubconVisibility } from './subcon_visibility_mirror.js';
import { createConversation, getDurableStateDir, getMode } from './conversation_utils.js';
import { buildRelationshipTools, createRuntime } from '../relationship-memory/src/adapter/index.js';
import { createSemanticRetrieverFromEnvironment } from '../relationship-memory/src/retrieval/index.js';
import { disableLettaCodeAutoUpdater } from './letta_code_runtime_env.js';

interface HookInput { session_id?: string; cwd?: string; prompt?: string; }
interface CachedSearch { prompt: string; searched_at: string; results: Array<Record<string, unknown>>; }

function esc(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function bookkeeping(value: string): boolean { return /(?:\bmem_[a-z0-9]+\b|\btranscript_ev_[a-z0-9]+\b|\breinforce\b|memory_(?:remember|reinforce)|已(?:写入|reinforce|存档)|无需(?:单独)?建档)/iu.test(value); }
function searchCacheFile(cwd: string, sessionId: string): string {
  const key = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return path.join(getDurableStateDir(cwd), `prompt-memory-search-${key}.json`);
}
function semanticReady(rootDir: string): boolean {
  try {
    const retriever = createSemanticRetrieverFromEnvironment(rootDir) as any;
    if (!retriever?.provider?.fingerprint || !retriever?.indexFile) return false;
    const index = JSON.parse(fs.readFileSync(retriever.indexFile, 'utf8'));
    return index?.schema_version === 1
      && index?.provider_fingerprint === retriever.provider.fingerprint
      && index?.documents
      && Object.keys(index.documents).length > 0;
  } catch { return false; }
}
async function deleteConversation(apiKey: string, conversationId: string): Promise<void> {
  try { await fetch(buildLettaApiUrl(`/conversations/${conversationId}`), { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } }); } catch {}
}
function legacyFullMode(raw: string): never {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wrapper = path.join(here, '..', 'hooks', 'silent-npx.cjs');
  const child = spawnSync(process.execPath, [wrapper, 'tsx', path.join(here, 'sync_letta_memory.ts')], { input: raw, env: process.env, encoding: 'utf8' });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exit(child.status ?? 0);
}

const raw = await new Promise<string>((resolve) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => resolve(data)); });
const mode = getMode();
if (mode === 'full') legacyFullMode(raw);
if (mode === 'off') process.exit(0);
let input: HookInput = {};
try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const prompt = input.prompt?.trim() || '';
if (!prompt || !input.session_id || !input.cwd) process.exit(0);
const apiKey = process.env.LETTA_API_KEY;
const rootDir = process.env.RELATIONSHIP_MEMORY_DIR?.trim();
const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID?.trim();
if (!apiKey || !rootDir || !subjectId || !semanticReady(rootDir)) process.exit(0);

const searchedAt = new Date().toISOString();
const runtime = createRuntime([], subjectId, rootDir);
const found = new Map<string, Record<string, unknown>>();
const seen = new Set<string>();
let searches = 0;
let finalWhisper = '';
let session: any;
let conversationId = '';
let resolveDelivered!: () => void;
const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
try {
  disableLettaCodeAutoUpdater();
  const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');
  const agentId = await getAgentId(apiKey);
  conversationId = await createConversation(apiKey, agentId);
  const search = buildRelationshipTools(runtime, `prompt-${Date.now()}`).find((tool) => tool.name === 'memory_search');
  if (!search) process.exit(0);
  const searchTool = { ...search, async execute(id: string, args: unknown) {
    searches += 1;
    if (searches > 2) throw new Error('too many prompt memory searches');
    const query = args && typeof args === 'object' && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
    if (searches === 1 && (typeof query.query !== 'string' || query.query.trim() !== prompt)) throw new Error('first search must use full current prompt');
    if (searches === 1) query.limit = Math.min(typeof query.limit === 'number' ? query.limit : 6, 6);
    const result = await search.execute(id, query) as { results?: any[] };
    for (const item of result.results ?? []) {
      if (!item?.memory_id) continue;
      seen.add(item.memory_id);
      found.set(item.memory_id, { memory_id: item.memory_id, kind: item.kind, summary: item.summary, payload: item.payload, observed_at: item.observed_at });
    }
    return jsonResult(result);
  }};
  const deliver = { label: 'deliver_subcon_whisper', name: 'deliver_subcon_whisper', description: 'Deliver only prompt-relevant remembered context, or silence.', parameters: { type: 'object', additionalProperties: false, required: ['relevant','source_memory_ids'], properties: { relevant: { type: 'boolean' }, whisper: { type: 'string', maxLength: 1200 }, source_memory_ids: { type: 'array', maxItems: 6, uniqueItems: true, items: { type: 'string' } } } }, async execute(_id: string, args: any) {
    const ids = Array.isArray(args?.source_memory_ids) ? args.source_memory_ids.filter((v: unknown): v is string => typeof v === 'string') : [];
    if (!searches || ids.some((id: string) => !seen.has(id))) throw new Error('invalid prompt recall delivery');
    if (args?.relevant === true) {
      const text = typeof args?.whisper === 'string' ? args.whisper.trim() : '';
      if (!text || !ids.length || bookkeeping(text)) throw new Error('invalid prompt recall whisper');
      finalWhisper = text;
    }
    resolveDelivered(); setImmediate(() => { try { session?.close(); } catch {} }); return jsonResult({ status: 'ok' });
  }};
  session = resumeSession(conversationId, { allowedTools: ['memory_search','deliver_subcon_whisper'], disallowedTools: ['memory_remember','memory_reinforce','entity_search','entity_remember','memory','memory_insert','memory_replace','memory_rethink','Read','Grep','Glob','Bash','Write','Edit','web_search','fetch_webpage'], tools: [searchTool, deliver], permissionMode: 'bypassPermissions', cwd: input.cwd, skillSources: [], systemInfoReminder: false, sleeptime: { trigger: 'off' }, memfsStartup: 'skip' });
  await session.send(`<subconscious_prompt_retrieval>\n<current_user_prompt>${esc(prompt)}</current_user_prompt>\n<instructions>Your first tool call MUST be memory_search with query exactly equal to the full current_user_prompt above, limit at most 6. Do not keyword-extract first. From returned memories, surface only context genuinely useful for foreground Kohaku's answer: shared experience, feeling, preference, inside joke, identity, or relationship continuity. Speak in first-person Kohaku. Never mention search/storage mechanics, IDs, reinforce/remember/create/dedupe decisions, or whether anything deserves storage. If nothing is useful, deliver relevant=false. Finish exactly once with deliver_subcon_whisper.</instructions>\n</subconscious_prompt_retrieval>`);
  const drain = (async () => { for await (const msg of session.stream()) if ((msg as any).type === 'error') throw new Error((msg as any).message || 'prompt recall stream error'); })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Number.parseInt(process.env.SUBCON_PROMPT_RETRIEVAL_TIMEOUT_MS || '6500', 10) || 6500); });
  const winner = await Promise.race([delivered.then(() => 'delivered' as const), drain.then(() => 'stream' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (winner !== 'delivered') finalWhisper = '';
  void drain.catch(() => {});
} catch { finalWhisper = ''; }
finally { try { session?.close(); } catch {} if (conversationId) await deleteConversation(apiKey, conversationId); }

const cache: CachedSearch = { prompt, searched_at: searchedAt, results: [...found.values()] };
try { const file = searchCacheFile(input.cwd, input.session_id); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache), { mode: 0o600 }); } catch {}
if (finalWhisper) {
  const payload = `<letta_message from="Subconscious" timestamp="${searchedAt}">\n${esc(finalWhisper)}\n</letta_message>`;
  mirrorSubconVisibility({ sessionId: input.session_id, phase: 'user_prompt', payload });
  process.stdout.write(`${payload}\n`);
}
