/**
 * Agent configuration for live Subconscious plus the dedicated historical
 * relationship-memory backfill observer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildLettaApiUrl } from './letta_api_url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_DIR = path.join(process.env.HOME || '~', '.letta', 'claude-subconscious');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_BACKFILL_CONFIG_FILE = path.join(CONFIG_DIR, 'backfill-config.json');
const DEFAULT_AGENT_FILE = path.join(__dirname, '..', 'Subconscious.af');

const REQUIRED_AGENT_TAGS = ['git-memory-enabled', 'origin:claude-subconcious'];
export const BACKFILL_PURPOSE_TAG = 'purpose:relationship-memory-backfill';

const PREFERRED_MODELS = [
  'letta/auto',
  'anthropic/claude-sonnet-4-5',
  'openai/gpt-4.1-mini',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-5.2',
  'google_ai/gemini-3-flash',
  'google_ai/gemini-2.5-flash',
  'minimax/MiniMax-M2.7',
];

interface Config {
  agentId?: string;
  importedAt?: string;
  model?: string;
}

interface BackfillConfig {
  agentId?: string;
  importedAt?: string;
}

interface LettaModel {
  model: string;
  name: string;
  provider_type: string;
  handle?: string;
  display_name?: string;
}

interface LlmConfig {
  model?: string;
  handle?: string;
  provider_name?: string;
  model_endpoint_type?: string;
  model_endpoint?: string;
  provider_category?: string;
  context_window?: number;
  max_tokens?: number;
  temperature?: number;
  enable_reasoner?: boolean;
  max_reasoning_tokens?: number;
  [key: string]: unknown;
}

interface AgentDetails {
  id: string;
  name: string;
  system?: string;
  tags?: string[];
  llm_config?: LlmConfig;
}

const AGENT_ID_REGEX = /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_REGEX.test(agentId);
}

function invalidAgentIdMessage(variable: string, agentId: string): string {
  return [
    `Invalid ${variable} format: "${agentId}"`,
    '',
    'The agent ID must be a UUID with the "agent-" prefix.',
    'Expected format: agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    'Example: agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  ].join('\n');
}

function readConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config; }
  catch { return {}; }
}

function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function backfillConfigFile(): string {
  return process.env.LETTA_BACKFILL_CONFIG_FILE || DEFAULT_BACKFILL_CONFIG_FILE;
}

function readBackfillConfig(): BackfillConfig {
  const file = backfillConfigFile();
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as BackfillConfig; }
  catch { return {}; }
}

function saveBackfillConfig(config: BackfillConfig): void {
  const file = backfillConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}

function agentTemplate(): { name: string; system: string } {
  const raw = JSON.parse(fs.readFileSync(DEFAULT_AGENT_FILE, 'utf8')) as {
    agents?: Array<{ name?: unknown; system?: unknown }>;
  };
  if (!Array.isArray(raw.agents) || raw.agents.length !== 1) {
    throw new Error('Canonical Subconscious.af must contain exactly one agent');
  }
  const agent = raw.agents[0];
  if (typeof agent.system !== 'string' || !agent.system) {
    throw new Error('Canonical Subconscious.af must contain exactly one agent with a non-empty system prompt');
  }
  return {
    name: typeof agent.name === 'string' && agent.name ? agent.name : 'Subconscious',
    system: agent.system,
  };
}

export function getCanonicalManagedSystemPrompt(): string {
  return agentTemplate().system;
}

async function getAgentDetails(apiKey: string, agentId: string): Promise<AgentDetails> {
  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`Failed to get agent details: ${response.status}`);
  return response.json() as Promise<AgentDetails>;
}

async function ensureTags(
  apiKey: string,
  agentId: string,
  required: string[],
  log: (message: string) => void,
): Promise<void> {
  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    log(`Warning: Could not fetch agent tags: ${response.status}`);
    return;
  }
  const agent = await response.json() as AgentDetails;
  const existing = Array.isArray(agent.tags) ? agent.tags : [];
  const missing = required.filter((tag) => !existing.includes(tag));
  if (!missing.length) return;

  const patch = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags: [...existing, ...missing] }),
  });
  if (!patch.ok) log(`Warning: Could not update agent tags: ${patch.status}`);
}

async function reconcileManagedAgentSystem(
  apiKey: string,
  agentId: string,
  log: (message: string) => void,
): Promise<void> {
  const canonical = getCanonicalManagedSystemPrompt();
  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to read managed agent before system reconciliation: ${response.status} ${await response.text()}`);
  }
  const agent = await response.json() as AgentDetails;
  if (agent.system === canonical) {
    log('Managed Subconscious system prompt already matches canonical Subconscious.af');
    return;
  }

  const patch = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ system: canonical }),
  });
  if (!patch.ok) {
    throw new Error(`Failed to reconcile managed Subconscious system prompt: ${patch.status} ${await patch.text()}`);
  }
  log('Reconciled managed Subconscious system prompt from canonical Subconscious.af');
}

async function isManagedEnvAgent(apiKey: string, agentId: string): Promise<boolean> {
  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return false;
  const agent = await response.json() as AgentDetails;
  return Array.isArray(agent.tags) && agent.tags.includes('origin:claude-subconcious');
}

export function findModel(models: LettaModel[], modelHandle: string): LettaModel | null {
  const normalized = modelHandle.toLowerCase();
  return models.find((model) => {
    const handle = model.handle?.toLowerCase() || `${model.provider_type}/${model.model}`.toLowerCase();
    return handle === normalized
      || model.model?.toLowerCase() === normalized
      || `${model.provider_type}/${model.name}`.toLowerCase() === normalized;
  }) || null;
}

export function buildLlmConfig(
  modelHandle: string,
  models: LettaModel[],
  currentConfig: LlmConfig | undefined,
): LlmConfig {
  const slash = modelHandle.indexOf('/');
  const providerName = slash > 0 ? modelHandle.slice(0, slash) : undefined;
  const modelName = slash > 0 ? modelHandle.slice(slash + 1) : modelHandle;
  const info = findModel(models, modelHandle);
  const config: LlmConfig = {
    ...(currentConfig || {}),
    model: modelName,
    handle: modelHandle,
    provider_name: providerName || info?.provider_type || currentConfig?.provider_name,
    model_endpoint_type: info?.provider_type || currentConfig?.model_endpoint_type,
  };
  const envWindow = process.env.LETTA_CONTEXT_WINDOW;
  if (envWindow) {
    const parsed = Number.parseInt(envWindow, 10);
    if (Number.isFinite(parsed) && parsed > 0) config.context_window = parsed;
  }
  return config;
}

async function ensureModelAvailable(
  apiKey: string,
  agentId: string,
  log: (message: string) => void,
): Promise<string | null> {
  try {
    const [modelsResponse, agent] = await Promise.all([
      fetch(buildLettaApiUrl('/models/'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      getAgentDetails(apiKey, agentId),
    ]);
    if (!modelsResponse.ok) throw new Error(`Failed to list models: ${modelsResponse.status}`);
    const models = await modelsResponse.json() as LettaModel[];
    const current = agent.llm_config?.handle
      || (agent.llm_config?.provider_name && agent.llm_config?.model
        ? `${agent.llm_config.provider_name}/${agent.llm_config.model}`
        : agent.llm_config?.model);
    const requested = process.env.LETTA_MODEL;
    let selected: string | undefined;
    if (requested && findModel(models, requested)) selected = requested;
    else if (current && findModel(models, current)) return null;
    else selected = PREFERRED_MODELS.find((candidate) => !!findModel(models, candidate))
      || models[0]?.handle
      || (models[0] ? `${models[0].provider_type}/${models[0].model}` : undefined);
    if (!selected) return null;

    const llm = buildLlmConfig(selected, models, agent.llm_config);
    const body: Record<string, unknown> = { model: selected };
    if (typeof llm.context_window === 'number') body.context_window_limit = llm.context_window;
    const patch = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!patch.ok) throw new Error(`Failed to update agent model: ${patch.status} ${await patch.text()}`);
    return selected;
  } catch (error) {
    log(`Warning: Could not verify model availability: ${error}`);
    return null;
  }
}

async function importAgent(
  apiKey: string,
  name: string,
  tags: string[],
  log: (message: string) => void,
): Promise<string> {
  const file = fs.readFileSync(DEFAULT_AGENT_FILE);
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'application/json' }), 'Subconscious.af');
  const response = await fetch(buildLettaApiUrl('/agents/import'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Failed to import agent: ${response.status} ${await response.text()}`);
  const result = await response.json() as { agent_ids?: string[] };
  const agentId = result.agent_ids?.[0];
  if (!agentId) throw new Error('Import succeeded but no agent ID returned');

  const rename = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!rename.ok) log(`Warning: Could not rename agent: ${rename.status}`);
  await ensureTags(apiKey, agentId, tags, log);
  return agentId;
}

function getKnownLiveAgentIdReadOnly(): string | undefined {
  const env = process.env.LETTA_AGENT_ID;
  if (env) {
    if (!isValidAgentId(env)) throw new Error(invalidAgentIdMessage('LETTA_AGENT_ID', env));
    return env;
  }
  const config = readConfig();
  return config.agentId && isValidAgentId(config.agentId) ? config.agentId : undefined;
}

export function getConfiguredAgentIdReadOnly(): string {
  const id = getKnownLiveAgentIdReadOnly();
  if (id) return id;
  throw new Error('No existing Letta agent is configured for read-only recall. Set LETTA_AGENT_ID or initialize Subconscious first.');
}

export async function getAgentId(
  apiKey: string,
  log: (message: string) => void = console.log,
): Promise<string> {
  const env = process.env.LETTA_AGENT_ID;
  if (env) {
    if (!isValidAgentId(env)) throw new Error(invalidAgentIdMessage('LETTA_AGENT_ID', env));
    log(`Using agent ID from LETTA_AGENT_ID: ${env}`);
    if (await isManagedEnvAgent(apiKey, env)) {
      log('LETTA_AGENT_ID is an origin-tagged managed Subconscious agent; reconciling system prompt only');
      await reconcileManagedAgentSystem(apiKey, env, log);
    } else {
      log('Using ordinary external LETTA_AGENT_ID; skipping all Subconscious-managed mutation');
    }
    return env;
  }

  let config = readConfig();
  let agentId = config.agentId;
  if (!agentId || !isValidAgentId(agentId)) {
    agentId = await importAgent(apiKey, agentTemplate().name, REQUIRED_AGENT_TAGS, log);
    config = { agentId, importedAt: new Date().toISOString() };
    saveConfig(config);
  }

  await ensureTags(apiKey, agentId, REQUIRED_AGENT_TAGS, log);
  await reconcileManagedAgentSystem(apiKey, agentId, log);
  const model = await ensureModelAvailable(apiKey, agentId, log);
  if (model && config.model !== model) saveConfig({ ...config, model });
  return agentId;
}

async function verifyDedicatedBackfillAgent(
  apiKey: string,
  agentId: string,
  liveAgentId: string | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (liveAgentId && liveAgentId === agentId) {
    throw new Error(`Dedicated backfill agent must differ from live Subconscious agent: ${agentId}`);
  }

  const required = [...REQUIRED_AGENT_TAGS, BACKFILL_PURPOSE_TAG];
  await ensureTags(apiKey, agentId, required, log);
  await reconcileManagedAgentSystem(apiKey, agentId, log);

  const response = await fetch(buildLettaApiUrl(`/agents/${agentId}`), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to verify dedicated backfill agent identity: ${response.status} ${await response.text()}`);
  }
  const agent = await response.json() as AgentDetails;
  if (!Array.isArray(agent.tags) || !agent.tags.includes(BACKFILL_PURPOSE_TAG)) {
    throw new Error(`Dedicated backfill agent is missing required purpose tag: ${BACKFILL_PURPOSE_TAG}`);
  }
}

/**
 * Dedicated historical resolver. It never reads LETTA_AGENT_ID as its own
 * selection source, never scans the global agent inventory, and stores its
 * managed identity separately from the live Subconscious config.
 */
export async function getBackfillAgentId(
  apiKey: string,
  log: (message: string) => void = console.log,
): Promise<string> {
  const liveAgentId = getKnownLiveAgentIdReadOnly();
  const env = process.env.LETTA_BACKFILL_AGENT_ID;
  let agentId: string;

  if (env) {
    if (!isValidAgentId(env)) throw new Error(invalidAgentIdMessage('LETTA_BACKFILL_AGENT_ID', env));
    agentId = env;
    log(`Using dedicated backfill agent from LETTA_BACKFILL_AGENT_ID: ${agentId}`);
  } else {
    const config = readBackfillConfig();
    if (config.agentId) {
      if (!isValidAgentId(config.agentId)) {
        throw new Error(`Saved dedicated backfill agent ID has invalid format: ${config.agentId}`);
      }
      agentId = config.agentId;
      log(`Using saved dedicated backfill agent ID: ${agentId}`);
    } else {
      const template = agentTemplate();
      agentId = await importAgent(
        apiKey,
        `${template.name} Relationship Memory Backfill`,
        [...REQUIRED_AGENT_TAGS, BACKFILL_PURPOSE_TAG],
        log,
      );
      if (liveAgentId && liveAgentId === agentId) {
        throw new Error(`Provisioned backfill agent unexpectedly equals live Subconscious agent: ${agentId}`);
      }
      saveBackfillConfig({ agentId, importedAt: new Date().toISOString() });
      log(`Provisioned and saved dedicated backfill agent: ${agentId}`);
    }
  }

  await verifyDedicatedBackfillAgent(apiKey, agentId, liveAgentId, log);
  return agentId;
}

export function needsImport(): boolean {
  if (process.env.LETTA_AGENT_ID) return false;
  return !readConfig().agentId;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
