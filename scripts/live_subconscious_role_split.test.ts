import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('live/backfill Subconscious role split', () => {
  it('keeps strict relationship observer execution out of the live worker', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(source).not.toContain('runRelationshipObserverBatch');
    expect(source).toContain('runNativeClientToolConversation');
    expect(source).toContain('createNativeLettaClient');
    expect(source).toContain('appendTrustedRelationshipCatalog');
    expect(source).toContain("name: 'deliver_whisper'");
    expect(source).not.toContain('@letta-ai/letta-code-sdk');
    expect(source).not.toContain('resumeSession');
    expect(source).not.toContain('permissionMode');
    expect(source).not.toMatch(/['"](?:Read|Grep|Glob)['"]/);
    expect(source).not.toContain('FORBIDDEN_MARKDOWN_MEMORY_TOOLS');
  });

  it('gives live and historical backfill distinct AgentFile contracts', () => {
    const live = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf8'));
    const backfill = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'SubconsciousBackfill.af'), 'utf8'));
    const liveAgent = live.agents[0];
    const backfillAgent = backfill.agents[0];

    const liveBlocks = liveAgent.block_ids.map((id: string) => live.blocks.find((block: any) => block.id === id)?.label);
    const liveTools = liveAgent.tool_ids.map((id: string) => live.tools.find((tool: any) => tool.id === id)?.name);
    const backfillBlocks = backfillAgent.block_ids.map((id: string) => backfill.blocks.find((block: any) => block.id === id)?.label);

    expect(liveAgent.system).toContain('persistent agent that whispers to Claude Code');
    expect(liveBlocks).toContain('guidance');
    expect(liveTools).toEqual(expect.arrayContaining(['memory', 'memory_insert', 'memory_replace', 'memory_rethink', 'conversation_search']));
    expect(liveTools).not.toContain('web_search');
    expect(liveTools).not.toContain('fetch_webpage');
    expect(backfillAgent.system).toContain('reconfigured as a relationship-memory observer');
    expect(backfillBlocks).toEqual(['shared_language', 'remembered_experiences', 'relationship_context']);
    expect(backfillAgent.tool_ids).toEqual([]);
  });

  it('makes the dedicated backfill resolver name its own AgentFile explicitly', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/backfill_agent_config.ts'), 'utf8');
    expect(source).toContain("'SubconsciousBackfill.af'");
    expect(source).toContain('canonicalForBackfillRuntime(getCanonicalManagedAgentConfig(DEFAULT_AGENT_FILE), runtime)');
    expect(source).toContain('buildManagedAgentImportPayload(DEFAULT_AGENT_FILE, canonical)');
    expect(source).toContain('reconcileManagedAgentConfiguration(apiKey, agentId, () => {}, DEFAULT_AGENT_FILE, canonical, { useOperatorRuntimeOverrides })');
    expect(source).not.toContain('getCanonicalManagedSystemPrompt(DEFAULT_AGENT_FILE)');
  });
});
