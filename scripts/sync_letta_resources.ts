import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getCanonicalManagedAgentConfig, getCanonicalManagedAgentSurface, getConfiguredAgentIdReadOnly } from './agent_config.js';
import { buildLettaApiUrl } from './letta_api_url.js';
import { getTempStateDir } from './conversation_utils.js';

const TEMP_STATE_DIR = getTempStateDir();
const DEFERRED_CLEANUP_MIN_AGE_MS = 5 * 60_000;
const DEFERRED_CLEANUP_PREFIX = 'sync-resource-cleanup-';
const NETWORK_TIMEOUT_MS = 2_000;

export interface SyncLettaResources {
  sourceAgentId: string;
  syncAgentId: string;
  syncBlockIds: string[];
  conversationId: string;
}

export interface DeferredSyncResourceCleanup {
  conversation_id: string | null;
  agent_id: string;
  block_ids: string[];
  recorded_at: string;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function boundedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
}

async function fetchManagedAgentSnapshot(apiKey: string, agentId: string): Promise<any> {
  const response = await boundedFetch(buildLettaApiUrl(`/agents/${encodeURIComponent(agentId)}`, { include: 'agent.blocks' }), {
    headers: authHeaders(apiKey),
  });
  if (!response.ok) throw new Error(`Failed to read managed agent for sync snapshot: ${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchSyncAgentSnapshot(apiKey: string, agentId: string): Promise<any> {
  const url = new URL(buildLettaApiUrl(`/agents/${encodeURIComponent(agentId)}`));
  url.searchParams.append('include', 'agent.tools');
  url.searchParams.append('include', 'agent.blocks');
  const response = await boundedFetch(url.toString(), { headers: authHeaders(apiKey) });
  if (!response.ok) throw new Error(`Failed to verify sync agent snapshot: ${response.status} ${await response.text()}`);
  return response.json();
}

async function recoverSyncAgentByName(apiKey: string, name: string): Promise<any | null> {
  const response = await boundedFetch(buildLettaApiUrl('/agents/', { name, limit: 10 }), { headers: authHeaders(apiKey) });
  if (!response.ok) return null;
  const agents = await response.json();
  const matches = (Array.isArray(agents) ? agents : []).filter((agent: any) => agent?.name === name && typeof agent?.id === 'string');
  if (matches.length !== 1) {
    for (const agent of matches) {
      try {
        const snapshot = await fetchSyncAgentSnapshot(apiKey, agent.id);
        const blockIds = (Array.isArray(snapshot?.blocks) ? snapshot.blocks : [])
          .map((block: any) => typeof block?.id === 'string' ? block.id : '')
          .filter(Boolean);
        await cleanupOrDeferSyncAgentResources(apiKey, agent.id, blockIds);
      } catch {
        deferSyncResourceCleanup(null, agent.id, []);
      }
    }
    return null;
  }
  return fetchSyncAgentSnapshot(apiKey, matches[0].id);
}

async function recoverConversationForAgent(apiKey: string, agentId: string): Promise<string | null> {
  const response = await boundedFetch(buildLettaApiUrl('/conversations/', { agent_id: agentId, limit: 10 }), { headers: authHeaders(apiKey) });
  if (!response.ok) return null;
  const conversations = await response.json();
  const matches = (Array.isArray(conversations) ? conversations : []).filter((conversation: any) => conversation?.agent_id === agentId && typeof conversation?.id === 'string');
  if (matches.length !== 1) {
    for (const conversation of matches) await deleteSyncConversation(apiKey, conversation.id);
    return null;
  }
  return matches[0].id;
}

export async function createToolStrippedSyncAgent(apiKey: string, syncKey: string): Promise<{ sourceAgentId: string; syncAgentId: string; syncBlockIds: string[] }> {
  const sourceAgentId = getConfiguredAgentIdReadOnly();
  const canonical = getCanonicalManagedAgentConfig();
  const surface = getCanonicalManagedAgentSurface();
  const live = await fetchManagedAgentSnapshot(apiKey, sourceAgentId);
  const liveBlocks = new Map<string, any>((Array.isArray(live?.blocks) ? live.blocks : []).map((block: any) => [String(block?.label ?? ''), block]));
  const memoryBlocks = surface.blocks.map((block) => {
    const current = liveBlocks.get(block.label);
    return {
      label: block.label,
      value: typeof current?.value === 'string' ? current.value : block.value,
      limit: typeof current?.limit === 'number' && current.limit > 0 ? current.limit : block.limit,
      ...(block.description ? { description: block.description } : {}),
      read_only: block.readOnly,
    };
  });
  if (!syncKey.trim()) throw new Error('syncKey is required for tool-stripped sync agent creation');
  const syncName = `Subconscious Sync ${syncKey}`;
  const body = {
    name: syncName,
    description: 'Ephemeral tool-stripped sibling for one synchronous relationship-memory foreground recall.',
    system: canonical.system,
    agent_type: 'letta_v1_agent',
    memory_blocks: memoryBlocks,
    tools: [],
    tool_ids: [],
    tool_rules: [],
    include_base_tools: false,
    include_multi_agent_tools: false,
    include_base_tool_rules: false,
    model: canonical.model,
    embedding: canonical.embedding,
    context_window_limit: canonical.contextWindowLimit,
    model_settings: {
      ...(live?.model_settings && typeof live.model_settings === 'object' && !Array.isArray(live.model_settings) ? live.model_settings : {}),
      provider_type: canonical.modelSettingsProviderType,
      parallel_tool_calls: canonical.parallelToolCalls,
    },
    enable_sleeptime: false,
    timezone: 'UTC',
    hidden: true,
  };
  let created: any;
  try {
    const response = await boundedFetch(buildLettaApiUrl('/agents/'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Failed to create tool-stripped sync agent: ${response.status} ${await response.text()}`);
    created = await response.json();
  } catch (error) {
    // A timeout can happen after Letta committed the POST. The deterministic
    // per-turn name lets us recover that exact sibling instead of leaking an
    // unknown agent or blindly creating a duplicate.
    const recovered = await recoverSyncAgentByName(apiKey, syncName);
    if (!recovered) throw error;
    created = recovered;
  }
  const syncAgentId = typeof created?.id === 'string' ? created.id : '';
  if (!syncAgentId) throw new Error('Letta did not return an id for the tool-stripped sync agent');
  let verified = created;
  if (!Array.isArray(verified?.tools) || !Array.isArray(verified?.blocks)) {
    try { verified = await fetchSyncAgentSnapshot(apiKey, syncAgentId); }
    catch (error) {
      // We know the agent id but not its newly-created block ids. Preserve an
      // agent-only cleanup receipt; the reaper will re-fetch the snapshot before
      // deleting the agent so the blocks remain discoverable.
      deferSyncResourceCleanup(null, syncAgentId, []);
      throw error;
    }
  }
  const attachedTools = Array.isArray(verified?.tools) ? verified.tools : [];
  const verifiedBlocks = Array.isArray(verified?.blocks) ? verified.blocks : [];
  const syncBlockIds = [...new Set(verifiedBlocks
    .map((block: any) => typeof block?.id === 'string' ? block.id : '')
    .filter(Boolean))];
  const expectedLabels = [...memoryBlocks.map((block) => block.label)].sort();
  const actualLabels = [...new Set(verifiedBlocks.map((block: any) => String(block?.label ?? '')).filter(Boolean))].sort();
  if (attachedTools.length !== 0 || syncBlockIds.length !== memoryBlocks.length || JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) {
    await cleanupOrDeferSyncAgentResources(apiKey, syncAgentId, syncBlockIds);
    if (attachedTools.length !== 0) throw new Error(`Tool-stripped sync agent unexpectedly has ${attachedTools.length} server tools`);
    throw new Error(`Tool-stripped sync agent returned an invalid block snapshot: ids=${syncBlockIds.length}, labels=${actualLabels.join(',')}`);
  }
  return { sourceAgentId, syncAgentId, syncBlockIds };
}

export async function createSyncConversation(apiKey: string, syncAgentId: string): Promise<string> {
  try {
    const response = await boundedFetch(buildLettaApiUrl('/conversations/', { agent_id: syncAgentId }), {
      method: 'POST',
      headers: authHeaders(apiKey),
    });
    if (!response.ok) throw new Error(`Failed to create sync conversation: ${response.status} ${await response.text()}`);
    const created = await response.json();
    if (typeof created?.id !== 'string' || !created.id) throw new Error('Letta did not return an id for the sync conversation');
    return created.id;
  } catch (error) {
    // The sibling agent is unique to this exact sync turn, so a committed POST
    // with a lost response can be recovered unambiguously by agent_id.
    const recovered = await recoverConversationForAgent(apiKey, syncAgentId);
    if (recovered) return recovered;
    throw error;
  }
}

export async function cancelSyncConversation(apiKey: string, conversationId: string): Promise<number | null> {
  try {
    const response = await boundedFetch(buildLettaApiUrl(`/conversations/${encodeURIComponent(conversationId)}/cancel`), {
      method: 'POST', headers: authHeaders(apiKey),
    });
    if (!response.ok) await response.text();
    return response.status;
  } catch {
    return null;
  }
}

export async function deleteSyncConversation(apiKey: string, conversationId: string): Promise<boolean> {
  try {
    const response = await boundedFetch(buildLettaApiUrl(`/conversations/${encodeURIComponent(conversationId)}`), {
      method: 'DELETE', headers: authHeaders(apiKey),
    });
    if (!response.ok && response.status !== 404) await response.text();
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function deleteSyncAgent(apiKey: string, agentId: string): Promise<boolean> {
  try {
    const response = await boundedFetch(buildLettaApiUrl(`/agents/${encodeURIComponent(agentId)}`), {
      method: 'DELETE', headers: authHeaders(apiKey),
    });
    if (!response.ok && response.status !== 404) await response.text();
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function deleteSyncBlock(apiKey: string, blockId: string): Promise<boolean> {
  try {
    const response = await boundedFetch(buildLettaApiUrl(`/blocks/${encodeURIComponent(blockId)}`), {
      method: 'DELETE', headers: authHeaders(apiKey),
    });
    if (!response.ok && response.status !== 404) await response.text();
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function deleteSyncBlocks(apiKey: string, blockIds: readonly string[]): Promise<boolean> {
  const unique = [...new Set(blockIds)].filter(Boolean);
  const results = await Promise.all(unique.map((blockId) => deleteSyncBlock(apiKey, blockId)));
  return results.every(Boolean);
}

export async function cleanupOrDeferSyncAgentResources(
  apiKey: string,
  agentId: string,
  blockIds: readonly string[],
): Promise<void> {
  const agentDeleted = await deleteSyncAgent(apiKey, agentId);
  const blocksDeleted = agentDeleted ? await deleteSyncBlocks(apiKey, blockIds) : false;
  if (!agentDeleted || !blocksDeleted) deferSyncResourceCleanup(null, agentId, blockIds);
}

function cleanupFile(conversationId: string | null, agentId: string): string {
  const digest = crypto.createHash('sha256').update(`${conversationId ?? ''}\0${agentId}`).digest('hex').slice(0, 24);
  return path.join(TEMP_STATE_DIR, `${DEFERRED_CLEANUP_PREFIX}${digest}.json`);
}

export function deferSyncResourceCleanup(conversationId: string | null, agentId: string, blockIds: readonly string[]): void {
  fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });
  const file = cleanupFile(conversationId, agentId);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const record: DeferredSyncResourceCleanup = { conversation_id: conversationId, agent_id: agentId, block_ids: [...new Set(blockIds)].filter(Boolean), recorded_at: new Date().toISOString() };
  fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try { fs.renameSync(temp, file); }
  catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    if (!fs.existsSync(file)) throw error;
  }
}

export async function cleanupCompletedSyncResources(
  apiKey: string,
  conversationId: string,
  agentId: string,
  blockIds: readonly string[],
): Promise<void> {
  const conversationDeleted = await deleteSyncConversation(apiKey, conversationId);
  const agentDeleted = conversationDeleted ? await deleteSyncAgent(apiKey, agentId) : false;
  const blocksDeleted = agentDeleted ? await deleteSyncBlocks(apiKey, blockIds) : false;
  if (!conversationDeleted || !agentDeleted || !blocksDeleted) deferSyncResourceCleanup(conversationId, agentId, blockIds);
}

export async function cancelAndDeferSyncResources(
  apiKey: string,
  conversationId: string,
  agentId: string,
  blockIds: readonly string[],
): Promise<void> {
  await cancelSyncConversation(apiKey, conversationId);
  deferSyncResourceCleanup(conversationId, agentId, blockIds);
}

export async function reapDeferredSyncResources(apiKey: string): Promise<void> {
  if (!fs.existsSync(TEMP_STATE_DIR)) return;
  const now = Date.now();
  const files = fs.readdirSync(TEMP_STATE_DIR)
    .filter((name) => name.startsWith(DEFERRED_CLEANUP_PREFIX) && name.endsWith('.json'))
    .sort()
    .slice(0, 1);
  for (const name of files) {
    const file = path.join(TEMP_STATE_DIR, name);
    let record: DeferredSyncResourceCleanup;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) as DeferredSyncResourceCleanup; }
    catch { continue; }
    const recordedAt = Date.parse(record.recorded_at);
    if (!record.agent_id || !Array.isArray(record.block_ids) || !Number.isFinite(recordedAt) || now - recordedAt < DEFERRED_CLEANUP_MIN_AGE_MS) continue;
    let blockIds = record.block_ids;
    if (blockIds.length === 0) {
      try {
        const agent = await fetchSyncAgentSnapshot(apiKey, record.agent_id);
        blockIds = (Array.isArray(agent?.blocks) ? agent.blocks : [])
          .map((block: any) => typeof block?.id === 'string' ? block.id : '')
          .filter(Boolean);
      } catch {
        continue;
      }
    }
    if (record.conversation_id) {
      const cancelStatus = await cancelSyncConversation(apiKey, record.conversation_id);
      if (cancelStatus === 200) {
        deferSyncResourceCleanup(record.conversation_id, record.agent_id, blockIds);
        continue;
      }
      if (cancelStatus === null) continue;
      if (cancelStatus !== 404 && cancelStatus !== 409) continue;
      const conversationDeleted = cancelStatus === 404 || await deleteSyncConversation(apiKey, record.conversation_id);
      if (!conversationDeleted) continue;
    }
    if (!await deleteSyncAgent(apiKey, record.agent_id)) continue;
    if (await deleteSyncBlocks(apiKey, blockIds)) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

export function deferredSyncCleanupPrefix(): string {
  return DEFERRED_CLEANUP_PREFIX;
}
