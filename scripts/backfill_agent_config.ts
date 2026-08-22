/**
 * Dedicated historical backfill Letta agent resolver.
 *
 * This intentionally does not reuse the live LETTA_AGENT_ID selection path and
 * never scans/adopts arbitrary origin-tagged agents. The dedicated identity is
 * explicit or persisted in its own config file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getCanonicalManagedAgentConfig,
  getCanonicalManagedSystemPrompt,
  getConfigPath,
  isValidAgentId,
  reconcileManagedAgentConfiguration,
} from './agent_config.js';
import { buildLettaApiUrl } from './letta_api_url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_AGENT_FILE = path.join(__dirname, '..', 'SubconsciousBackfill.af');
const DEFAULT_CONFIG_FILE = path.join(
  process.env.HOME || '~',
  '.letta',
  'claude-subconscious',
  'backfill-config.json',
);

const REQUIRED_TAGS = [
  'git-memory-enabled',
  'origin:claude-subconcious',
  'purpose:relationship-memory-backfill',
] as const;

export const BACKFILL_PURPOSE_TAG = REQUIRED_TAGS[2];

interface BackfillConfig { agentId?: string; importedAt?: string; }
interface AgentDetails {
  id: string;
  name?: string;
  system?: string;
  tags?: string[];
  model?: string | null;
  embedding?: string | null;
  llm_config?: { handle?: string; context_window?: number; parallel_tool_calls?: boolean };
  embedding_config?: { handle?: string } | null;
  model_settings?: { parallel_tool_calls?: boolean } | null;
}

export interface BackfillAgentResolveOptions {
  agentId?: string;
  reconcileCanonicalPrompt?: boolean;
}

export const VERIFIED_BACKFILL_RUNTIME = {
  model: 'openai-proxy/x-preview-f-free',
  providerType: 'openai',
  embedding: 'local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768',
  contextWindow: 400_000,
  parallelToolCalls: true,
} as const;

// Compatibility aliases for the older 093AR operator harness. New code should
// use the provider-neutral verified backfill names above.
export const LEGACY_FILL_VERIFIED_RUNTIME = VERIFIED_BACKFILL_RUNTIME;

function configFile(): string {
  return process.env.LETTA_BACKFILL_CONFIG_FILE || DEFAULT_CONFIG_FILE;
}
function readJsonFile<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}
function readBackfillConfig(): BackfillConfig { return readJsonFile<BackfillConfig>(configFile()) ?? {}; }
function saveBackfillConfig(config: BackfillConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}
function knownLiveAgentId(): string | undefined {
  const env = process.env.LETTA_AGENT_ID;
  if (env) {
    if (!isValidAgentId(env)) throw new Error(`Invalid LETTA_AGENT_ID format: "${env}"`);
    return env;
  }
  const config = readJsonFile<{ agentId?: string }>(getConfigPath());
  return config?.agentId && isValidAgentId(config.agentId) ? config.agentId : undefined;
}
function assertDedicated(agentId: string, liveAgentId: string | undefined): void {
  if (!isValidAgentId(agentId)) throw new Error(`Invalid LETTA_BACKFILL_AGENT_ID format: "${agentId}"`);
  if (liveAgentId && agentId === liveAgentId) {
    throw new Error(`Dedicated backfill agent must differ from live Subconscious agent: ${agentId}`);
  }
}
async function fetchAgent(apiKey: string, agentId: string): Promise<AgentDetails> {
  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Failed to read dedicated backfill agent: ${response.status} ${await response.text()}`);
  return response.json() as Promise<AgentDetails>;
}
async function patchAgent(apiKey: string, agentId: string, body: Record<string, unknown>, reason: string): Promise<void> {
  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${reason}: ${response.status} ${await response.text()}`);
}
async function reconcileDedicatedAgent(apiKey: string, agentId: string, reconcileCanonicalPrompt = true): Promise<void> {
  const agent = await fetchAgent(apiKey, agentId);
  const tags = Array.isArray(agent.tags) ? agent.tags : [];
  const missingTags = REQUIRED_TAGS.filter((tag) => !tags.includes(tag));
  if (missingTags.length) {
    await patchAgent(apiKey, agentId, { tags: [...tags, ...missingTags] }, 'Failed to reconcile dedicated backfill agent tags');
  }
  const canonicalSystem = reconcileCanonicalPrompt ? getCanonicalManagedSystemPrompt(DEFAULT_AGENT_FILE) : undefined;
  if (reconcileCanonicalPrompt) {
    await reconcileManagedAgentConfiguration(apiKey, agentId, () => {}, DEFAULT_AGENT_FILE);
  }
  const verified = await fetchAgent(apiKey, agentId);
  if (!Array.isArray(verified.tags) || !verified.tags.includes(BACKFILL_PURPOSE_TAG)) {
    throw new Error(`Dedicated backfill agent is missing required purpose tag: ${BACKFILL_PURPOSE_TAG}`);
  }
  if (canonicalSystem !== undefined && verified.system !== canonicalSystem) {
    throw new Error('Dedicated backfill agent system prompt does not match canonical SubconsciousBackfill.af');
  }
}

export async function configureVerifiedBackfillRuntime(
  apiKey: string,
  agentId: string,
  log: (message: string) => void = console.log,
): Promise<void> {
  const profile = VERIFIED_BACKFILL_RUNTIME;
  await patchAgent(apiKey, agentId, {
    model: profile.model,
    embedding: profile.embedding,
    context_window_limit: profile.contextWindow,
    model_settings: { provider_type: profile.providerType, parallel_tool_calls: profile.parallelToolCalls },
  }, 'Failed to apply verified backfill runtime');

  let verified: AgentDetails | undefined;
  let mismatch = 'runtime state not yet visible';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    verified = await fetchAgent(apiKey, agentId);
    const modelHandle = verified.model ?? verified.llm_config?.handle;
    const embeddingHandle = verified.embedding ?? verified.embedding_config?.handle;
    const contextWindow = verified.llm_config?.context_window;
    const parallel = verified.model_settings?.parallel_tool_calls ?? verified.llm_config?.parallel_tool_calls;
    if (
      modelHandle === profile.model
      && embeddingHandle === profile.embedding
      && contextWindow === profile.contextWindow
      && parallel === profile.parallelToolCalls
    ) {
      log(`Verified backfill runtime on ${agentId}: ${profile.model}, ${profile.embedding}, context=${profile.contextWindow}, parallel_tool_calls=${profile.parallelToolCalls}`);
      return;
    }
    mismatch = `model=${modelHandle ?? 'missing'}, embedding=${embeddingHandle ?? 'missing'}, context=${contextWindow ?? 'missing'}, parallel_tool_calls=${String(parallel)}`;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Verified backfill runtime mismatch after PATCH: ${mismatch}`);
}
export const configureVerifiedLegacyFillRuntime = configureVerifiedBackfillRuntime;

async function importDedicatedAgent(apiKey: string): Promise<string> {
  const file = fs.readFileSync(DEFAULT_AGENT_FILE);
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'application/json' }), 'SubconsciousBackfill.af');
  const canonical = getCanonicalManagedAgentConfig(DEFAULT_AGENT_FILE);
  form.append('model', process.env.LETTA_MODEL || canonical.model);
  form.append('embedding', canonical.embedding);
  const response = await fetch(buildLettaApiUrl('/agents/import'), {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!response.ok) throw new Error(`Failed to import dedicated backfill agent: ${response.status} ${await response.text()}`);
  const result = await response.json() as { agent_ids?: string[] };
  const agentId = result.agent_ids?.[0];
  if (!agentId || !isValidAgentId(agentId)) throw new Error('Dedicated backfill import succeeded but returned no valid agent ID');
  await patchAgent(apiKey, agentId, { name: 'Subconscious Relationship Memory Backfill' }, 'Failed to name dedicated backfill agent');
  return agentId;
}

export async function getBackfillAgentId(apiKey: string, log: (message: string) => void = console.log, options: BackfillAgentResolveOptions = {}): Promise<string> {
  const liveAgentId = knownLiveAgentId();
  const explicit = options.agentId ?? process.env.LETTA_BACKFILL_AGENT_ID;
  let agentId: string;
  if (explicit) {
    assertDedicated(explicit, liveAgentId);
    agentId = explicit;
    log(options.agentId
      ? `Using explicit dedicated backfill agent: ${agentId}`
      : `Using dedicated backfill agent from LETTA_BACKFILL_AGENT_ID: ${agentId}`);
  } else {
    const config = readBackfillConfig();
    if (config.agentId) {
      assertDedicated(config.agentId, liveAgentId);
      agentId = config.agentId;
      log(`Using saved dedicated backfill agent: ${agentId}`);
    } else {
      agentId = await importDedicatedAgent(apiKey);
      assertDedicated(agentId, liveAgentId);
      saveBackfillConfig({ agentId, importedAt: new Date().toISOString() });
      log(`Provisioned dedicated backfill agent: ${agentId}`);
    }
  }
  await reconcileDedicatedAgent(apiKey, agentId, options.reconcileCanonicalPrompt ?? true);
  return agentId;
}
