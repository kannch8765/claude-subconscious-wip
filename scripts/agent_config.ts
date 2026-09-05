/**
 * Agent Configuration Utility
 * 
 * Resolves agent ID from (in order):
 * 1. LETTA_AGENT_ID environment variable
 * 2. Saved config file (~/.letta/claude-subconscious/config.json)
 * 3. Auto-import from bundled Subconscious.af
 * 
 * Model configuration:
 * - Managed saved/imported agents reconcile to canonical Subconscious.af runtime policy
 * - Model availability discovery is diagnostic for managed agents and must not override that authority
 * - Legacy auto-selection remains available only when a caller explicitly allows fallback
 * - LETTA_MODEL environment variable remains an explicit operator override
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildLettaApiUrl } from './letta_api_url.js';
import { readBundledManagedSystemPromptForAgentFile, readManagedSystemPromptFile } from './managed_system_prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(process.env.HOME || '~', '.letta', 'claude-subconscious');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_AGENT_FILE = path.join(__dirname, '..', 'Subconscious.af');

// Preferred models in order of preference for auto-selection
// Tilted towards quality - Subconscious needs good instruction following and tool use
const PREFERRED_MODELS = [
  'letta/auto',                   // Letta Cloud auto-routing
  'anthropic/claude-sonnet-4-5', // Best for agents per Anthropic
  'openai/gpt-4.1-mini',         // Good balance, 1M context, cheap
  'anthropic/claude-haiku-4-5',  // Fast Claude option
  'openai/gpt-5.2',              // Flagship fallback
  'google_ai/gemini-3-flash',    // Google's balanced option
  'google_ai/gemini-2.5-flash',  // Fallback
  'minimax/MiniMax-M2.7',        // MiniMax flagship, 1M context
];

interface Config {
  agentId?: string;
  importedAt?: string;
  model?: string; // Track which model was configured
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
  model?: string | null;
  embedding?: string | null;
  embedding_config?: { handle?: string; embedding_model?: string; embedding_endpoint_type?: string } | null;
  context_window_limit?: number | null;
  model_settings?: { provider_type?: string; parallel_tool_calls?: boolean; [key: string]: unknown } | null;
  llm_config?: LlmConfig;
}

export interface CanonicalManagedAgentConfig {
  system: string;
  model: string;
  embedding: string;
  contextWindowLimit: number;
  modelSettingsProviderType: string;
  parallelToolCalls: boolean;
}

export interface CanonicalManagedAgentSurface {
  blocks: Array<{
    label: string;
    value: string;
    limit: number;
    description?: string;
    readOnly: boolean;
  }>;
  toolNames: string[];
}

/**
 * Regex for validating Letta agent ID format
 * Format: agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (UUID v4 with 'agent-' prefix)
 */
const AGENT_ID_REGEX = /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate agent ID format
 * 
 * @param agentId - The agent ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_REGEX.test(agentId);
}

/**
 * Get a helpful error message for invalid agent ID format
 */
function getInvalidAgentIdMessage(agentId: string): string {
  const lines = [
    `Invalid LETTA_AGENT_ID format: "${agentId}"`,
    '',
    'The agent ID must be a UUID with the "agent-" prefix.',
    'Expected format: agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    'Example: agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    '',
    'Common mistakes:',
    '  - Using the agent\'s friendly name (e.g., "Memo") instead of the UUID',
    '  - Missing the "agent-" prefix',
    '',
    'To find your agent ID:',
    '  1. Go to https://app.letta.com',
    '  2. Select your agent',
    '  3. Copy the ID from the URL or agent settings',
  ];
  return lines.join('\n');
}

/**
 * Read saved config
 */
function readConfig(): Config {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save config
 */
function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get original agent name from .af file
 */
function getAgentNameFromFile(): string {
  try {
    const content = JSON.parse(fs.readFileSync(DEFAULT_AGENT_FILE, 'utf-8'));
    // .af files have agents array with name property
    if (content.agents && content.agents.length > 0 && content.agents[0].name) {
      return content.agents[0].name;
    }
  } catch {
    // Fall back to filename
  }
  return path.basename(DEFAULT_AGENT_FILE, '.af');
}

/**
 * Rename an agent
 */
const REQUIRED_AGENT_TAGS = ['git-memory-enabled', 'origin:claude-subconcious'];

/**
 * Ensure required tags are present on an agent.
 * - git-memory-enabled: triggers git-backed memory filesystem
 * - origin:claude-subconcious: identifies agent origin for tracking
 */
async function ensureRequiredAgentTags(apiKey: string, agentId: string, log: (msg: string) => void = console.log): Promise<void> {
  // First GET the agent to read current tags
  const getUrl = buildLettaApiUrl(`/agents/${agentId}`);
  const getResponse = await fetch(getUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!getResponse.ok) {
    log(`Warning: Could not fetch agent tags: ${getResponse.status}`);
    return;
  }

  const agent = await getResponse.json();
  const existingTags = agent.tags || [];
  const missingTags = REQUIRED_AGENT_TAGS.filter(tag => !existingTags.includes(tag));

  if (missingTags.length === 0) return;

  const patchUrl = buildLettaApiUrl(`/agents/${agentId}`);
  const response = await fetch(patchUrl, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags: [...existingTags, ...missingTags] }),
  });

  if (!response.ok) {
    // Non-fatal - agent still works without required tags
    log(`Warning: Could not update agent tags: ${response.status}`);
  }
}

async function renameAgent(apiKey: string, agentId: string, name: string): Promise<void> {
  const url = buildLettaApiUrl(`/agents/${agentId}`);
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    // Non-fatal - agent still works with _copy name
    console.error(`Warning: Could not rename agent: ${response.status}`);
  }
}

/**
 * Read the canonical managed-agent configuration from the bundled .af file.
 *
 * Subconscious.af remains the source of truth for managed runtime structure/settings,
 * while config/live-system.md is the bundled source of truth for the live system prompt. Explicit operator overrides remain supported for model/context below,
 * but imported/saved/owned agents otherwise converge to this configuration.
 */
export function getCanonicalManagedAgentConfig(
  agentFile: string = DEFAULT_AGENT_FILE,
  managedSystemPromptFile?: string,
): CanonicalManagedAgentConfig {
  let content: unknown;
  try {
    content = JSON.parse(fs.readFileSync(agentFile, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to read canonical Subconscious.af: ${error}`);
  }

  const agents = (content as { agents?: Array<Record<string, unknown>> }).agents;
  if (!Array.isArray(agents) || agents.length !== 1) {
    throw new Error('Canonical Subconscious.af must contain exactly one agent');
  }
  const agent = agents[0];
  const managedSystem = managedSystemPromptFile
    ? readManagedSystemPromptFile(managedSystemPromptFile)
    : readBundledManagedSystemPromptForAgentFile(agentFile);
  const system = managedSystem ?? agent.system;
  const modelSettings = agent.model_settings as { provider_type?: unknown; parallel_tool_calls?: unknown } | null | undefined;
  if (
    typeof system !== 'string' || system.trim().length === 0
    || typeof agent.model !== 'string' || agent.model.length === 0
    || typeof agent.embedding !== 'string' || agent.embedding.length === 0
    || typeof agent.context_window_limit !== 'number' || agent.context_window_limit <= 0
    || typeof modelSettings?.provider_type !== 'string' || modelSettings.provider_type.length === 0
    || modelSettings.parallel_tool_calls !== true
  ) {
    throw new Error('Canonical Subconscious.af is missing managed runtime model/embedding/context/model-settings-provider/parallel-tool configuration');
  }

  return {
    system,
    model: agent.model,
    embedding: agent.embedding,
    contextWindowLimit: agent.context_window_limit,
    modelSettingsProviderType: modelSettings.provider_type,
    parallelToolCalls: true,
  };
}

export function getCanonicalManagedAgentSurface(agentFile: string = DEFAULT_AGENT_FILE): CanonicalManagedAgentSurface {
  let content: any;
  try {
    content = JSON.parse(fs.readFileSync(agentFile, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to read managed AgentFile surface from ${path.basename(agentFile)}: ${error}`);
  }
  const agents = content?.agents;
  if (!Array.isArray(agents) || agents.length !== 1) throw new Error(`Managed ${path.basename(agentFile)} must contain exactly one agent`);
  const agent = agents[0];
  const blocks = Array.isArray(content.blocks) ? content.blocks : [];
  const tools = Array.isArray(content.tools) ? content.tools : [];
  const byBlockId = new Map(blocks.map((block: any) => [block.id, block]));
  const byToolId = new Map<string, unknown>(tools.map((tool: any) => [String(tool.id), tool]));
  const desiredBlocks = (Array.isArray(agent.block_ids) ? agent.block_ids : []).map((id: string) => byBlockId.get(id)).filter(Boolean).map((block: any) => ({
    label: String(block.label),
    value: String(block.value ?? ''),
    limit: typeof block.limit === 'number' && block.limit > 0 ? block.limit : 3000,
    ...(typeof block.description === 'string' ? { description: block.description } : {}),
    readOnly: block.read_only === true,
  }));
  const toolNames = (Array.isArray(agent.tool_ids) ? agent.tool_ids : []).map((id: string) => {
    const tool = byToolId.get(id);
    return tool && typeof tool === 'object' && 'name' in tool ? (tool as { name?: unknown }).name : undefined;
  }).filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
  if (desiredBlocks.length !== (agent.block_ids?.length ?? 0) || toolNames.length !== (agent.tool_ids?.length ?? 0)) {
    throw new Error(`Managed ${path.basename(agentFile)} references missing block/tool definitions`);
  }
  return { blocks: desiredBlocks, toolNames };
}

export function getCanonicalManagedSystemPrompt(agentFile: string = DEFAULT_AGENT_FILE, managedSystemPromptFile?: string): string {
  return getCanonicalManagedAgentConfig(agentFile, managedSystemPromptFile).system;
}

function operatorContextWindow(defaultValue: number): number {
  const raw = process.env.LETTA_CONTEXT_WINDOW;
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return !isNaN(parsed) && parsed > 0 ? parsed : defaultValue;
}

function currentEmbeddingHandle(agent: AgentDetails): string | null {
  if (typeof agent.embedding === 'string' && agent.embedding.length > 0) return agent.embedding;
  if (agent.embedding_config?.handle) return agent.embedding_config.handle;
  if (agent.embedding_config?.embedding_endpoint_type && agent.embedding_config?.embedding_model) {
    return `${agent.embedding_config.embedding_endpoint_type}/${agent.embedding_config.embedding_model}`;
  }
  return null;
}

function currentModelSettingsProviderType(agent: AgentDetails): string | null {
  const providerType = agent.model_settings?.provider_type;
  if (typeof providerType === 'string' && providerType.length > 0) return providerType;
  const endpointType = agent.llm_config?.model_endpoint_type;
  if (typeof endpointType === 'string' && endpointType.length > 0) return endpointType;
  return null;
}

async function resolveManagedModelSettingsProviderType(
  apiKey: string,
  desiredModel: string,
  canonical: CanonicalManagedAgentConfig,
): Promise<string> {
  // The canonical model/provider pair is authored together in Subconscious.af.
  if (desiredModel === canonical.model) return canonical.modelSettingsProviderType;

  // A cross-model operator override must obtain its discriminator from Letta's
  // own model metadata. Handle prefixes are provider names, not necessarily the
  // discriminated-union provider_type (for example openai-proxy/* -> openai).
  let models: LettaModel[];
  try {
    models = await listAvailableModels(apiKey);
  } catch (error) {
    throw new Error(`Failed to resolve model_settings.provider_type for LETTA_MODEL="${desiredModel}" from Letta model metadata: ${error}`);
  }
  const model = findModel(models, desiredModel);
  if (!model?.provider_type) {
    throw new Error(`Cannot resolve model_settings.provider_type for LETTA_MODEL="${desiredModel}" from Letta model metadata`);
  }
  return model.provider_type;
}

interface AttachedBlock { id: string; label: string; value?: string; }
interface AttachedTool { id: string; name: string; }
const OBSERVER_ONLY_BLOCK_LABELS = new Set(['shared_language', 'remembered_experiences', 'relationship_context']);
const LIVE_POLICY_BLOCK_LABELS = new Set(['core_directives', 'tool_guidelines']);
const OBSOLETE_LIVE_SERVER_TOOL_NAMES = new Set(['legacy_source_complete', 'web_search', 'fetch_webpage']);

async function fetchJsonArray(apiKey: string, pathname: string, reason: string): Promise<any[]> {
  const response = await fetch(buildLettaApiUrl(pathname), { headers: { 'Authorization': `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`${reason}: ${response.status} ${await response.text()}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error(`${reason}: expected an array response`);
  return value;
}

async function patchEmpty(apiKey: string, pathname: string, reason: string): Promise<void> {
  const response = await fetch(buildLettaApiUrl(pathname), { method: 'PATCH', headers: { 'Authorization': `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`${reason}: ${response.status} ${await response.text()}`);
}

/**
 * Reconcile the live Subconscious working-memory/tool surface without changing
 * the adopted agent identity. Existing desired blocks are preserved verbatim;
 * only missing blocks are created from the AgentFile defaults. Known observer-
 * only projection blocks are detached from this agent, never deleted globally;
 * unrelated operator-added blocks/tools are preserved.
 */
export async function reconcileManagedLiveAgentSurface(
  apiKey: string,
  agentId: string,
  log: (msg: string) => void = console.log,
  agentFile: string = DEFAULT_AGENT_FILE,
): Promise<void> {
  const canonical = getCanonicalManagedAgentSurface(agentFile);
  const desiredLabels = new Set(canonical.blocks.map((block) => block.label));
  const desiredTools = new Set(canonical.toolNames);

  const attachedBlocks = await fetchJsonArray(apiKey, `/agents/${agentId}/core-memory/blocks`, 'Failed to list managed live memory blocks') as AttachedBlock[];
  const attachedByLabel = new Map(attachedBlocks.map((block) => [block.label, block]));

  for (const block of attachedBlocks) {
    if (!desiredLabels.has(block.label) && OBSERVER_ONLY_BLOCK_LABELS.has(block.label)) {
      await patchEmpty(apiKey, `/agents/${agentId}/core-memory/blocks/detach/${block.id}`, `Failed to detach observer-only live block ${block.label}`);
      log(`Detached observer-only live Subconscious block: ${block.label}`);
    }
  }

  for (const block of canonical.blocks) {
    const existing = attachedByLabel.get(block.label);
    if (existing) {
      if (LIVE_POLICY_BLOCK_LABELS.has(block.label) && existing.value !== block.value) {
        const response = await fetch(buildLettaApiUrl(`/agents/${agentId}/core-memory/blocks/${block.label}`), {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: block.value }),
        });
        if (!response.ok) throw new Error(`Failed to reconcile live policy block ${block.label}: ${response.status} ${await response.text()}`);
        log(`Reconciled live Subconscious policy block: ${block.label}`);
      }
      continue;
    }
    const createResponse = await fetch(buildLettaApiUrl('/blocks/'), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: block.label,
        value: block.value,
        limit: block.limit,
        ...(block.description ? { description: block.description } : {}),
        read_only: block.readOnly,
      }),
    });
    if (!createResponse.ok) throw new Error(`Failed to create missing live block ${block.label}: ${createResponse.status} ${await createResponse.text()}`);
    const created = await createResponse.json() as { id?: string };
    if (!created.id) throw new Error(`Failed to create missing live block ${block.label}: response had no block ID`);
    await patchEmpty(apiKey, `/agents/${agentId}/core-memory/blocks/attach/${created.id}`, `Failed to attach restored live block ${block.label}`);
    log(`Restored missing live Subconscious block: ${block.label}`);
  }

  const [attachedTools, globalTools] = await Promise.all([
    fetchJsonArray(apiKey, `/agents/${agentId}/tools`, 'Failed to list managed live tools') as Promise<AttachedTool[]>,
    fetchJsonArray(apiKey, '/tools/', 'Failed to list available Letta tools') as Promise<AttachedTool[]>,
  ]);
  const globalByName = new Map(globalTools.map((tool) => [tool.name, tool]));
  const attachedByName = new Map(attachedTools.map((tool) => [tool.name, tool]));

  for (const tool of attachedTools) {
    if (!desiredTools.has(tool.name) && OBSOLETE_LIVE_SERVER_TOOL_NAMES.has(tool.name)) {
      await patchEmpty(apiKey, `/agents/${agentId}/tools/detach/${tool.id}`, `Failed to detach obsolete live tool ${tool.name}`);
      log(`Detached obsolete live Subconscious tool: ${tool.name}`);
    }
  }
  for (const name of canonical.toolNames) {
    if (attachedByName.has(name)) continue;
    const tool = globalByName.get(name);
    if (!tool?.id) throw new Error(`Required live Subconscious tool is unavailable on Letta server: ${name}`);
    await patchEmpty(apiKey, `/agents/${agentId}/tools/attach/${tool.id}`, `Failed to attach restored live tool ${name}`);
    log(`Restored live Subconscious tool: ${name}`);
  }
}

/**
 * Reconcile one already-established Subconscious-managed agent to canonical
 * runtime policy. Ownership must be decided by the caller before invoking this.
 */
export async function reconcileManagedAgentConfiguration(
  apiKey: string,
  agentId: string,
  log: (msg: string) => void = console.log,
  agentFile: string = DEFAULT_AGENT_FILE,
  canonicalOverride?: CanonicalManagedAgentConfig,
  options: { useOperatorRuntimeOverrides?: boolean } = {},
): Promise<void> {
  const canonical = canonicalOverride ?? getCanonicalManagedAgentConfig(agentFile);
  const useOperatorRuntimeOverrides = options.useOperatorRuntimeOverrides ?? true;
  const desiredModel = useOperatorRuntimeOverrides ? (process.env.LETTA_MODEL || canonical.model) : canonical.model;
  const desiredContextWindow = useOperatorRuntimeOverrides ? operatorContextWindow(canonical.contextWindowLimit) : canonical.contextWindowLimit;
  const url = buildLettaApiUrl(`/agents/${agentId}`);
  const getResponse = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!getResponse.ok) {
    throw new Error(`Failed to read managed agent before configuration reconciliation: ${getResponse.status} ${await getResponse.text()}`);
  }

  const agent = await getResponse.json() as AgentDetails;
  const desiredProviderType = await resolveManagedModelSettingsProviderType(apiKey, desiredModel, canonical);
  const patch: Record<string, unknown> = {};
  const modelWillChange = getAgentModelHandle(agent) !== desiredModel;
  if (agent.system !== canonical.system) patch.system = canonical.system;
  if (modelWillChange) patch.model = desiredModel;
  if (currentEmbeddingHandle(agent) !== canonical.embedding) patch.embedding = canonical.embedding;
  const currentContext = agent.context_window_limit ?? agent.llm_config?.context_window;
  // Letta can reset the effective context window to the new model's default
  // when `model` changes, even if the pre-PATCH context already matched. Carry
  // the desired limit in the same PATCH so model/provider/context converge atomically.
  if (modelWillChange || currentContext !== desiredContextWindow) patch.context_window_limit = desiredContextWindow;
  const currentProviderType = currentModelSettingsProviderType(agent);
  const modelSettingsParallel = agent.model_settings?.parallel_tool_calls;
  const legacyConfigParallel = agent.llm_config?.parallel_tool_calls;
  const parallelIsEffective = modelSettingsParallel === canonical.parallelToolCalls
    && legacyConfigParallel === canonical.parallelToolCalls;
  // Letta 0.16.8 rebuilds effective llm_config when model/context changes. Carry
  // canonical model_settings in the same PATCH even when both parallel flags are
  // already true, otherwise that rebuild can silently drop provider parallelism.
  const effectiveLlmConfigWillRebuild = modelWillChange || currentContext !== desiredContextWindow;
  if (currentProviderType !== desiredProviderType || !parallelIsEffective || effectiveLlmConfigWillRebuild) {
    patch.model_settings = currentProviderType === desiredProviderType
      ? { ...(agent.model_settings ?? {}), provider_type: desiredProviderType, parallel_tool_calls: canonical.parallelToolCalls }
      : { provider_type: desiredProviderType, parallel_tool_calls: canonical.parallelToolCalls };
  }

  if (Object.keys(patch).length === 0) {
    log('Managed Subconscious runtime configuration already matches canonical managed configuration');
    return;
  }

  const patchResponse = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  if (!patchResponse.ok) {
    throw new Error(`Failed to reconcile managed Subconscious runtime configuration: ${patchResponse.status} ${await patchResponse.text()}`);
  }

  if (patch.model_settings) {
    const verifyResponse = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!verifyResponse.ok) {
      throw new Error(`Failed to verify managed Subconscious runtime configuration after reconciliation: ${verifyResponse.status} ${await verifyResponse.text()}`);
    }
    const verified = await verifyResponse.json() as AgentDetails;
    const verifiedModelSettingsParallel = verified.model_settings?.parallel_tool_calls;
    const verifiedLegacyConfigParallel = verified.llm_config?.parallel_tool_calls;
    if (verifiedModelSettingsParallel !== canonical.parallelToolCalls
      || verifiedLegacyConfigParallel !== canonical.parallelToolCalls) {
      throw new Error(
        `Managed Subconscious effective parallel_tool_calls reconciliation failed: model_settings=${String(verifiedModelSettingsParallel)}, llm_config=${String(verifiedLegacyConfigParallel)}, expected=${String(canonical.parallelToolCalls)}`,
      );
    }
  }
  log(`Reconciled managed Subconscious runtime configuration from ${path.basename(agentFile)}: ${Object.keys(patch).join(', ')}`);
}

/**
 * Determine whether an env-selected agent is an existing Subconscious-managed
 * adopted agent without mutating it. The origin tag is an ownership marker for
 * this narrow purpose; this function never scans the global agent inventory.
 */
async function isManagedEnvAgent(
  apiKey: string,
  agentId: string,
  log: (msg: string) => void = console.log,
): Promise<boolean> {
  const url = buildLettaApiUrl(`/agents/${agentId}`);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    log(`Could not verify LETTA_AGENT_ID ownership (${response.status}); treating it as external for managed reconciliation`);
    return false;
  }

  const agent = await response.json() as AgentDetails;
  return Array.isArray(agent.tags) && agent.tags.includes('origin:claude-subconcious');
}

/**
 * List available models from Letta server
 */
async function listAvailableModels(apiKey: string): Promise<LettaModel[]> {
  const url = buildLettaApiUrl('/models/');
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`);
  }

  return response.json();
}

/**
 * Get agent details including current model configuration
 */
async function getAgentDetails(apiKey: string, agentId: string): Promise<AgentDetails> {
  const url = buildLettaApiUrl(`/agents/${agentId}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get agent details: ${response.status}`);
  }

  return response.json();
}

/**
 * Get model handle from agent details
 * The handle format is "provider/model" (e.g., "openai/gpt-4o-mini")
 */
function getAgentModelHandle(agent: AgentDetails): string | null {
  if (typeof agent.model === 'string' && agent.model.length > 0) return agent.model;
  const llmConfig = agent.llm_config;
  if (!llmConfig) return null;
  
  // Try handle first (newer format)
  if (llmConfig.handle) return llmConfig.handle;
  
  // Fall back to constructing from provider and model
  if (llmConfig.provider_name && llmConfig.model) {
    return `${llmConfig.provider_name}/${llmConfig.model}`;
  }
  
  return llmConfig.model || null;
}

/**
 * Check if a model is available on the server
 */
function isModelAvailable(models: LettaModel[], modelHandle: string): boolean {
  return findModel(models, modelHandle) !== null;
}

/**
 * Find a model in the available models list by handle.
 * Returns the matching LettaModel or null.
 */
export function findModel(models: LettaModel[], modelHandle: string): LettaModel | null {
  const normalizedHandle = modelHandle.toLowerCase();

  return models.find(m => {
    const handle = m.handle?.toLowerCase() || `${m.provider_type}/${m.model}`.toLowerCase();
    return handle === normalizedHandle ||
           m.model?.toLowerCase() === normalizedHandle ||
           `${m.provider_type}/${m.name}`.toLowerCase() === normalizedHandle;
  }) || null;
}

/**
 * Select best available model from preferences
 */
function selectBestModel(models: LettaModel[], preferences: string[]): string | null {
  // First, try preferred models in order
  for (const preferred of preferences) {
    if (isModelAvailable(models, preferred)) {
      return preferred;
    }
  }
  
  // Fall back to first available model
  if (models.length > 0) {
    const first = models[0];
    return first.handle || `${first.provider_type}/${first.model}`;
  }
  
  return null;
}

/**
 * Ensure agent's model is available on the server
 * If not, auto-select from available models and update the agent
 * 
 * @returns The model handle that was configured (or null if no change needed)
 */
async function ensureModelAvailable(
  apiKey: string,
  agentId: string,
  log: (msg: string) => void = console.log,
  allowAutoSelection = true,
): Promise<string | null> {
  try {
    // Get available models and agent details in parallel
    const [models, agent] = await Promise.all([
      listAvailableModels(apiKey),
      getAgentDetails(apiKey, agentId),
    ]);
    
    const currentModel = getAgentModelHandle(agent);
    log(`Agent's current model: ${currentModel || 'unknown'}`);
    log(`Available models: ${models.length} found`);
    
    // Check if LETTA_MODEL env var is set
    const envModel = process.env.LETTA_MODEL;
    if (envModel) {
      if (isModelAvailable(models, envModel)) {
        if (currentModel !== envModel) {
          log(`Using LETTA_MODEL override: ${envModel}`);
          await updateAgentModel(apiKey, agentId, envModel, models, agent.llm_config, log);
          return envModel;
        }
        // Model matches, but check if context_window needs updating
        const envCW = process.env.LETTA_CONTEXT_WINDOW;
        if (envCW && agent.llm_config?.context_window !== parseInt(envCW, 10)) {
          log(`Updating context_window to ${envCW} (was ${agent.llm_config?.context_window})`);
          await updateAgentModel(apiKey, agentId, envModel, models, agent.llm_config, log);
          return envModel;
        }
        return null; // Already using desired model and context_window
      } else {
        log(`Warning: LETTA_MODEL="${envModel}" is not available on this server`);
        log(`Available models: ${models.map(m => m.handle || `${m.provider_type}/${m.model}`).slice(0, 10).join(', ')}${models.length > 10 ? '...' : ''}`);
      }
    }

    // Check if current model is available
    if (currentModel && isModelAvailable(models, currentModel)) {
      log(`Agent's model "${currentModel}" is available`);
      return null; // No change needed
    }

    // Model not available. For Subconscious-managed agents, canonical .af /
    // explicit operator configuration is authoritative even when /models is
    // temporarily incomplete or represents the model differently. Availability
    // discovery may warn, but must not silently PATCH the managed agent away
    // from a configuration that was just reconciled successfully.
    log(`Agent's model "${currentModel}" is NOT available on this server`);
    if (!allowAutoSelection) {
      log('Preserving reconciled managed model; availability fallback is disabled for Subconscious-managed agents');
      return null;
    }

    const selectedModel = selectBestModel(models, PREFERRED_MODELS);
    if (!selectedModel) {
      throw new Error('No models available on this server. Please configure your Letta server with at least one LLM provider.');
    }

    log(`Auto-selecting model: ${selectedModel}`);
    console.log(`\n⚠️  Model Update Required`);
    console.log(`   The Subconscious agent's default model (${currentModel}) is not available.`);
    console.log(`   Auto-selecting: ${selectedModel}`);
    console.log(`   To use a different model, set LETTA_MODEL environment variable.\n`);

    await updateAgentModel(apiKey, agentId, selectedModel, models, agent.llm_config, log);
    return selectedModel;
    
  } catch (error) {
    // Log but don't fail - the agent might still work
    log(`Warning: Could not verify model availability: ${error}`);
    return null;
  }
}

/**
 * Build llm_config for a model handle using metadata from the available models
 * list and the agent's current llm_config as a base.
 *
 * This preserves existing settings (context_window, temperature, etc.) while
 * overriding model-identity fields. If LETTA_CONTEXT_WINDOW is set, it takes
 * precedence over the current value.
 */
export function buildLlmConfig(
  modelHandle: string,
  models: LettaModel[],
  currentConfig: LlmConfig | undefined,
): LlmConfig {
  const slashIdx = modelHandle.indexOf('/');
  const providerName = slashIdx > 0 ? modelHandle.substring(0, slashIdx) : undefined;
  const modelName = slashIdx > 0 ? modelHandle.substring(slashIdx + 1) : modelHandle;

  const modelInfo = findModel(models, modelHandle);

  // Spread current config to preserve settings, then override model fields
  const config: LlmConfig = {
    ...(currentConfig || {}),
    model: modelName,
    handle: modelHandle,
    provider_name: providerName || modelInfo?.provider_type || currentConfig?.provider_name,
    model_endpoint_type: modelInfo?.provider_type || currentConfig?.model_endpoint_type,
  };

  // LETTA_CONTEXT_WINDOW env var overrides the current value
  const envContextWindow = process.env.LETTA_CONTEXT_WINDOW;
  if (envContextWindow) {
    const parsed = parseInt(envContextWindow, 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.context_window = parsed;
    }
  }

  return config;
}

/**
 * Update agent's model configuration via the agent PATCH endpoint.
 *
 * Letta deprecated the `llm_config` request body (HTTP 400:
 * "The `llm_config` field is deprecated and no longer accepted. Use the `model`
 * field instead."). The replacement shape is top-level `model` plus
 * `context_window_limit` — the latter explicitly avoids the old footgun where
 * a bare `{ model }` PATCH reset context_window to a server default.
 *
 * buildLlmConfig() is kept for callers that still need the resolved
 * provider/model metadata; we just pull the two server-accepted fields out of
 * it and send those.
 */
async function updateAgentModel(
  apiKey: string,
  agentId: string,
  modelHandle: string,
  models: LettaModel[],
  currentConfig: LlmConfig | undefined,
  log: (msg: string) => void = console.log
): Promise<void> {
  const url = buildLettaApiUrl(`/agents/${agentId}`);

  log(`Updating agent model to: ${modelHandle}`);

  const llmConfig = buildLlmConfig(modelHandle, models, currentConfig);

  const body: Record<string, unknown> = { model: modelHandle };
  if (typeof llmConfig.context_window === 'number') {
    body.context_window_limit = llmConfig.context_window;
    if (llmConfig.context_window !== currentConfig?.context_window) {
      log(`Including context_window: ${llmConfig.context_window}`);
    }
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update agent model: ${response.status} ${errorText}`);
  }

  log(`Agent model updated to: ${modelHandle}`);
}

export function buildManagedAgentImportPayload(
  agentFile: string = DEFAULT_AGENT_FILE,
  canonical: CanonicalManagedAgentConfig = getCanonicalManagedAgentConfig(agentFile),
): string {
  let content: any;
  try {
    content = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read managed AgentFile import payload from ${path.basename(agentFile)}: ${error}`);
  }
  if (!Array.isArray(content?.agents) || content.agents.length !== 1) {
    throw new Error(`Managed ${path.basename(agentFile)} must contain exactly one agent`);
  }
  const agent = content.agents[0];
  const serializedSystem = typeof agent.system === 'string' ? agent.system : '';
  if (!serializedSystem) throw new Error(`Managed ${path.basename(agentFile)} is missing its serialized system snapshot`);

  // Letta AgentFiles also carry a compiled system-role bootstrap message whose
  // text starts with the serialized system prompt. Keep that derived snapshot
  // consistent in the in-memory import payload without rewriting the .af file.
  const messages = Array.isArray(agent.messages) ? agent.messages : [];
  let bootstrapMatches = 0;
  for (const message of messages) {
    if (message?.role !== 'system' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(serializedSystem)) {
        bootstrapMatches += 1;
        part.text = canonical.system + part.text.slice(serializedSystem.length);
      }
    }
  }
  if (bootstrapMatches !== 1) {
    throw new Error(`Managed ${path.basename(agentFile)} must contain exactly one compiled system bootstrap prefix; found ${bootstrapMatches}`);
  }
  content.agents[0] = { ...agent, system: canonical.system };
  return JSON.stringify(content);
}

/**
 * Import agent from .af file
 */
async function importDefaultAgent(apiKey: string, canonical: CanonicalManagedAgentConfig): Promise<string> {
  const url = buildLettaApiUrl('/agents/import');
  
  // Build the upload in memory so bundled managed prompt authority is applied
  // before the remote import. The on-disk .af remains a compatibility snapshot.
  const agentFileContent = buildManagedAgentImportPayload(DEFAULT_AGENT_FILE, canonical);
  
  // Get original name for later rename
  const originalName = getAgentNameFromFile();
  
  // Create form data with the file
  const formData = new FormData();
  const blob = new Blob([agentFileContent], { type: 'application/json' });
  formData.append('file', blob, 'Subconscious.af');
  // Import-time overrides prevent deprecated/stale serialized provider details
  // from blocking creation before the managed post-import reconcile can run.
  formData.append('model', process.env.LETTA_MODEL || canonical.model);
  formData.append('embedding', canonical.embedding);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to import agent: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  
  if (!result.agent_ids || result.agent_ids.length === 0) {
    throw new Error('Import succeeded but no agent ID returned');
  }
  
  const agentId = result.agent_ids[0];
  
  // Rename to original name (removes "_copy" suffix added by import)
  await renameAgent(apiKey, agentId, originalName);
  
  // Ensure required tags are present for memory + origin tracking
  await ensureRequiredAgentTags(apiKey, agentId);
  
  return agentId;
}

export function getConfiguredAgentIdReadOnly(): string {
  const envAgentId = process.env.LETTA_AGENT_ID;
  if (envAgentId) {
    if (!isValidAgentId(envAgentId)) throw new Error(getInvalidAgentIdMessage(envAgentId));
    return envAgentId;
  }
  const config = readConfig();
  if (config.agentId && isValidAgentId(config.agentId)) return config.agentId;
  throw new Error('No existing Letta agent is configured for read-only recall. Set LETTA_AGENT_ID or initialize Subconscious first.');
}

/**
 * Get or create agent ID
 * 
 * Returns the agent ID from env var, saved config, or imports the default agent.
 * After getting the agent, verifies the model is available and auto-selects if not.
 */
export async function getAgentId(apiKey: string, log: (msg: string) => void = console.log): Promise<string> {
  let agentId: string;
  let config = readConfig();
  let agentSource: 'env' | 'saved' | 'imported';
  let canonical: CanonicalManagedAgentConfig | undefined;

  // 1. Check environment variable. Ordinary external env agents intentionally
  // do not load bundled prompt resources at all.
  const envAgentId = process.env.LETTA_AGENT_ID;
  if (envAgentId) {
    if (!isValidAgentId(envAgentId)) {
      const errorMsg = getInvalidAgentIdMessage(envAgentId);
      log(`WARNING: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    log(`Using agent ID from LETTA_AGENT_ID: ${envAgentId}`);
    agentId = envAgentId;
    agentSource = 'env';
  } else {
    // Saved/imported identities are managed by definition. Resolve the bundled
    // prompt before any remote mutation, and reuse this exact snapshot for an
    // import plus the reconciliation that follows.
    canonical = getCanonicalManagedAgentConfig();
    if (config.agentId) {
      if (!isValidAgentId(config.agentId)) {
        log(`WARNING: Saved agent ID has invalid format: ${config.agentId}`);
        log('Ignoring invalid saved config and attempting to import default agent...');
        agentId = await importAndSaveAgent(apiKey, log, canonical);
        config = readConfig();
        agentSource = 'imported';
      } else {
        log(`Using saved agent ID: ${config.agentId}`);
        agentId = config.agentId;
        agentSource = 'saved';
      }
    } else {
      agentId = await importAndSaveAgent(apiKey, log, canonical);
      config = readConfig();
      agentSource = 'imported';
    }
  }

  if (agentSource !== 'env') {
    try {
      await ensureRequiredAgentTags(apiKey, agentId, log);
    } catch (error) {
      log(`Warning: Could not ensure required tags: ${error}`);
    }
    await reconcileManagedAgentConfiguration(apiKey, agentId, log, DEFAULT_AGENT_FILE, canonical);
    await reconcileManagedLiveAgentSurface(apiKey, agentId, log);
    try {
      const configuredModel = await ensureModelAvailable(apiKey, agentId, log, false);
      if (configuredModel && config.model !== configuredModel) {
        saveConfig({ ...config, model: configuredModel });
      }
    } catch (error) {
      log(`Warning: Could not verify model availability: ${error}`);
    }
  } else if (await isManagedEnvAgent(apiKey, agentId, log)) {
    canonical = getCanonicalManagedAgentConfig();
    log('LETTA_AGENT_ID is an origin-tagged managed Subconscious agent; reconciling canonical runtime configuration');
    await reconcileManagedAgentConfiguration(apiKey, agentId, log, DEFAULT_AGENT_FILE, canonical);
    await reconcileManagedLiveAgentSurface(apiKey, agentId, log);
  } else {
    log('Using ordinary external LETTA_AGENT_ID; skipping all Subconscious-managed mutation');
  }

  return agentId;
}

/**
 * Import default agent and save to config
 */
async function importAndSaveAgent(
  apiKey: string,
  log: (msg: string) => void,
  canonical: CanonicalManagedAgentConfig,
): Promise<string> {
  log('No agent configured - importing default Subconscious agent...');
  
  if (!fs.existsSync(DEFAULT_AGENT_FILE)) {
    throw new Error(`Default agent file not found: ${DEFAULT_AGENT_FILE}`);
  }
  
  const agentId = await importDefaultAgent(apiKey, canonical);
  log(`Imported agent: ${agentId}`);
  
  // Save for future use
  saveConfig({
    agentId,
    importedAt: new Date().toISOString(),
  });
  log(`Saved agent ID to ${CONFIG_FILE}`);
  
  return agentId;
}

/**
 * Check if we need to import (for quick checks without async)
 */
export function needsImport(): boolean {
  if (process.env.LETTA_AGENT_ID) return false;
  const config = readConfig();
  return !config.agentId;
}

/**
 * Get config file path (for logging/debugging)
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
