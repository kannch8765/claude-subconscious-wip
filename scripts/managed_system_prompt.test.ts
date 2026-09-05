import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BUNDLED_MANAGED_AGENT_FILES,
  BUNDLED_MANAGED_SYSTEM_PROMPTS,
  readBundledManagedSystemPrompt,
  readManagedSystemPromptFile,
} from './managed_system_prompt.js';
import {
  buildManagedAgentImportPayload,
  getCanonicalManagedAgentConfig,
} from './agent_config.js';

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

describe('bundled managed system prompts', () => {
  it('loads by module-relative path even after cwd changes', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'subcon-prompt-cwd-'));
    process.chdir(elsewhere);
    const live = fs.readFileSync(BUNDLED_MANAGED_SYSTEM_PROMPTS.live, 'utf8');
    const backfill = fs.readFileSync(BUNDLED_MANAGED_SYSTEM_PROMPTS.backfill, 'utf8');
    expect(readBundledManagedSystemPrompt('live')).toBe(live);
    expect(readBundledManagedSystemPrompt('backfill')).toBe(backfill);
  });

  it('preserves authored whitespace, rejects blank content, and observes later edits without a permanent cache', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcon-prompt-edit-'));
    const file = path.join(dir, 'system.md');
    fs.writeFileSync(file, '  first prompt\n\n', 'utf8');
    expect(readManagedSystemPromptFile(file)).toBe('  first prompt\n\n');
    fs.writeFileSync(file, 'second prompt\n', 'utf8');
    expect(readManagedSystemPromptFile(file)).toBe('second prompt\n');
    fs.writeFileSync(file, ' \n\t\n', 'utf8');
    expect(() => readManagedSystemPromptFile(file)).toThrow('must not be empty or whitespace-only');
    expect(() => readManagedSystemPromptFile(path.join(dir, 'missing.md'))).toThrow('Failed to read managed system prompt');
  });

  it('uses an edited prompt snapshot for both canonical reconciliation data and the import payload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcon-prompt-payload-'));
    const customAf = path.join(dir, 'Custom.af');
    const promptFile = path.join(dir, 'system.md');
    fs.copyFileSync(BUNDLED_MANAGED_AGENT_FILES.live, customAf);
    fs.writeFileSync(promptFile, 'edited managed prompt\nwith exact tail\n', 'utf8');

    const canonical = getCanonicalManagedAgentConfig(customAf, promptFile);
    const payload = JSON.parse(buildManagedAgentImportPayload(customAf, canonical).toString('utf8'));
    const original = JSON.parse(fs.readFileSync(customAf, 'utf8'));

    expect(canonical.system).toBe('edited managed prompt\nwith exact tail\n');
    expect(payload.agents[0].system).toBe(canonical.system);
    const originalBootstrap = original.agents[0].messages[0].content[0].text as string;
    const importedBootstrap = payload.agents[0].messages[0].content[0].text as string;
    expect(importedBootstrap.startsWith(canonical.system)).toBe(true);
    expect(importedBootstrap.slice(canonical.system.length)).toBe(originalBootstrap.slice(original.agents[0].system.length));
    expect(payload.agents[0].model).toBe(original.agents[0].model);
    expect(payload.agents[0].embedding).toBe(original.agents[0].embedding);
    expect(payload.agents[0].context_window_limit).toBe(original.agents[0].context_window_limit);
    expect(payload.agents[0].model_settings).toEqual(original.agents[0].model_settings);
    expect(payload.agents[0].tool_ids).toEqual(original.agents[0].tool_ids);
  });

  it('preserves explicit custom AgentFile system semantics unless a prompt file is explicitly supplied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcon-custom-af-'));
    const customAf = path.join(dir, 'Custom.af');
    const parsed = JSON.parse(fs.readFileSync(BUNDLED_MANAGED_AGENT_FILES.live, 'utf8'));
    parsed.agents[0].system = 'custom caller-owned system';
    fs.writeFileSync(customAf, JSON.stringify(parsed), 'utf8');

    expect(getCanonicalManagedAgentConfig(customAf).system).toBe('custom caller-owned system');
  });

  it('keeps config markdown in the default npm package shape', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(path.dirname(BUNDLED_MANAGED_AGENT_FILES.live), 'package.json'), 'utf8'));
    expect(packageJson.files).toBeUndefined();
    expect(fs.existsSync(BUNDLED_MANAGED_SYSTEM_PROMPTS.live)).toBe(true);
    expect(fs.existsSync(BUNDLED_MANAGED_SYSTEM_PROMPTS.backfill)).toBe(true);
  });
});