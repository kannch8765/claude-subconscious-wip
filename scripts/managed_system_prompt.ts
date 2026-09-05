import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export type BundledManagedPromptRole = 'live' | 'backfill';

export const BUNDLED_MANAGED_AGENT_FILES: Record<BundledManagedPromptRole, string> = {
  live: path.join(REPO_ROOT, 'Subconscious.af'),
  backfill: path.join(REPO_ROOT, 'SubconsciousBackfill.af'),
};

export const BUNDLED_MANAGED_SYSTEM_PROMPTS: Record<BundledManagedPromptRole, string> = {
  live: path.join(REPO_ROOT, 'config', 'live-system.md'),
  backfill: path.join(REPO_ROOT, 'config', 'backfill-system.md'),
};

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function bundledPromptRoleForAgentFile(agentFile: string): BundledManagedPromptRole | null {
  if (samePath(agentFile, BUNDLED_MANAGED_AGENT_FILES.live)) return 'live';
  if (samePath(agentFile, BUNDLED_MANAGED_AGENT_FILES.backfill)) return 'backfill';
  return null;
}

export function readManagedSystemPromptFile(promptFile: string): string {
  let prompt: string;
  try {
    prompt = fs.readFileSync(promptFile, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read managed system prompt ${path.basename(promptFile)}: ${error}`);
  }
  if (prompt.trim().length === 0) {
    throw new Error(`Managed system prompt ${path.basename(promptFile)} must not be empty or whitespace-only`);
  }
  return prompt;
}

export function readBundledManagedSystemPrompt(role: BundledManagedPromptRole): string {
  return readManagedSystemPromptFile(BUNDLED_MANAGED_SYSTEM_PROMPTS[role]);
}

export function readBundledManagedSystemPromptForAgentFile(agentFile: string): string | null {
  const role = bundledPromptRoleForAgentFile(agentFile);
  return role ? readBundledManagedSystemPrompt(role) : null;
}
