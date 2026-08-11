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
const DEFAULT_AGENT_FILE = path.join(__dirname, '..', 'Subconscious.af');
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
interface AgentDetails { id: string; name?: string; system?: string; tags?: string[]; }

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
async function reconcileDedicatedAgent(apiKey: string, agentId: string): Promise<void> {
  const agent = await fetchAgent(apiKey, agentId);
  const tags = Array.isArray(agent.tags) ? agent.tags : [];
  const missingTags = REQUIRED_TAGS.filter((tag) => !tags.includes(tag));
  if (missingTags.length) {
    await patchAgent(apiKey, agentId, { tags: [...tags, ...missingTags] }, 'Failed to reconcile dedicated backfill agent tags');
  }
  const canonicalSystem = getCanonicalManagedSystemPrompt();
  await reconcileManagedAgentConfiguration(apiKey, agentId);
  const verified = await fetchAgent(apiKey, agentId);
  if (!Array.isArray(verified.tags) || !verified.tags.includes(BACKFILL_PURPOSE_TAG)) {
    throw new Error(`Dedicated backfill agent is missing required purpose tag: ${BACKFILL_PURPOSE_TAG}`);
  }
  if (verified.system !== canonicalSystem) {
    throw new Error('Dedicated backfill agent system prompt does not match canonical Subconscious.af');
  }
}
async function importDedicatedAgent(apiKey: string): Promise<string> {
  const file = fs.readFileSync(DEFAULT_AGENT_FILE);
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'application/json' }), 'Subconscious.af');
  const canonical = getCanonicalManagedAgentConfig();
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

export async function getBackfillAgentId(apiKey: string, log: (message: string) => void = console.log): Promise<string> {
  const liveAgentId = knownLiveAgentId();
  const explicit = process.env.LETTA_BACKFILL_AGENT_ID;
  let agentId: string;
  if (explicit) {
    assertDedicated(explicit, liveAgentId);
    agentId = explicit;
    log(`Using dedicated backfill agent from LETTA_BACKFILL_AGENT_ID: ${agentId}`);
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
  await reconcileDedicatedAgent(apiKey, agentId);
  return agentId;
}
