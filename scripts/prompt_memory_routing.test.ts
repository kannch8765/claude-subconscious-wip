import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('prompt-time subconscious relationship-memory routing', () => {
  it('routes whisper mode by lifecycle instead of replaying post-turn assistant history', () => {
    const hooks = JSON.parse(read('hooks/hooks.json'));
    const promptCommand = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    const stopCommand = hooks.hooks.Stop[0].hooks[0].command;
    const pretoolCommand = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(promptCommand).toContain('prompt_memory_recall_hook.ts');
    expect(stopCommand).toContain('silent_relationship_stop.ts');
    expect(pretoolCommand).toContain('pretool_route.ts');
    expect(promptCommand).not.toContain('sync_letta_memory.ts');
  });

  it('uses the existing canonical memory_search for the full current prompt and only exposes a terminal whisper', () => {
    const source = read('scripts/prompt_memory_recall_hook.ts');
    expect(source).toContain('buildRelationshipTools');
    expect(source).toContain("tool.name === 'memory_search'");
    expect(source).toContain('first search must use full current prompt');
    expect(source).toContain("allowedTools: ['memory_search','deliver_subcon_whisper']");
    expect(source).toContain('createSemanticRetrieverFromEnvironment');
    expect(source).toContain('provider_fingerprint === retriever.provider.fingerprint');
    expect(source).toContain("phase: 'user_prompt'");
    expect(source).not.toContain('fetchAssistantMessages');
  });

  it('keeps reinforce and remember in silent Stop maintenance while discarding ordinary prose', () => {
    const stop = read('scripts/silent_relationship_stop.ts');
    const worker = read('scripts/silent_relationship_worker.ts');
    expect(stop).toContain('memory_reinforce existing durable memories');
    expect(stop).toContain('memory_remember genuinely new durable memories');
    expect(stop).toContain('current_prompt_memory_search_results');
    expect(stop).toContain('Ordinary assistant prose is private and discarded');
    expect(worker).toContain('RELATIONSHIP_ALLOWED_CLIENT_TOOLS');
    expect(worker).toContain('RELATIONSHIP_DISALLOWED_CLIENT_TOOLS');
    expect(worker).not.toContain('deliver_whisper');
    expect(worker).not.toContain('mirrorSubconVisibility');
  });

  it('disables PreToolUse message surfacing in whisper mode and provides out-of-band Qwen prewarm', () => {
    const pretool = read('scripts/pretool_route.ts');
    const prewarm = read('scripts/prewarm_relationship_semantic_index.ts');
    const pkg = JSON.parse(read('package.json'));
    expect(pretool).toContain("getMode() !== 'full'");
    expect(prewarm).toContain("RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER must be dashscope-qwen");
    expect(prewarm).toContain('memorySearchHybrid');
    expect(prewarm).toContain('semantic index incomplete');
    expect(pkg.scripts['prewarm-semantic-index']).toContain('prewarm_relationship_semantic_index.ts');
  });
});
