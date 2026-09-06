import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_REMEMBER_TOOL_NAMES } from '../relationship-memory/src/tools/index.js';
import { sendViaNativeClient } from './send_worker_native.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_DIR;
  delete process.env.LETTA_API_KEY;
});

describe('live async relationship-memory surfacing contract', () => {
  it('lets the live model choose semantic relationship searches while requiring at least one real search', () => {
    const send = fs.readFileSync(path.join(process.cwd(), 'scripts/send_messages_to_letta.ts'), 'utf8');
    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(send).toContain('<latest_user_message>');
    expect(send).toContain('choose and call relationship memory_search yourself');
    expect(send).toContain('compact semantic query');
    expect(send).toContain('must complete at least one relationship memory_search');
    expect(send).toContain('additional memory_search calls after seeing earlier results');
    expect(send).toContain('deliver_whisper');
    expect(worker).toContain("name: 'deliver_whisper'");
    expect(worker).toContain("requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : []");
    expect(worker).toContain('Model relationship memory_search: query=');
    expect(worker).toContain('foregroundGroundingIdentityAnchors(entitySearchObservations)');
    expect(worker).toContain("enum: ['foreground_grounding', 'maintenance']");
    expect(worker).toContain('const { purpose: _purpose, ...searchArgs } = rawArgs');
    expect(worker).toContain('quote_snippets');
    expect(worker).toContain("required: ['memory_id', 'snippet_ids']");
    expect(worker).toContain("const summary = typeof memory?.summary === 'string' ? memory.summary.trim() : ''");
    expect(worker).toContain('const surfacedRecallMemories = new Map<string, SurfacedRecallMemory>()');
    expect(worker).toContain('renderHistoricalMemoryWhisper(surfacedMemory.summary, snippets)');
    expect(worker).toContain('The runtime renders the surfaced canonical memory summary as `记忆：...`');
    expect(worker).toContain('composeGroundedWhisper(historicalWindow, foregroundGroundingIdentityAnchors(entitySearchObservations))');
    expect(worker).not.toContain('runtime.memorySearchHybrid({ query: firstSearchQuery');
    expect(worker).not.toContain('prefetched_relationship_memory_search');
    expect(send).toContain('latestUserMessage,');
    expect(worker).toContain('isRelationshipMutationClientTool(tool.name)');
    expect(worker).toContain('RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS');
  });

  it('sends the five kind-specific create schemas on the final async native client-tool surface', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-memory-tools-')); roots.push(root);
    process.env.RELATIONSHIP_MEMORY_DIR = root; process.env.LETTA_API_KEY = 'test-only';
    let capturedTools: any[] = [];
    const completion = await sendViaNativeClient({
      agentId: 'agent-test', conversationId: 'conversation-test', sessionId: 'session-test',
      message: '<claude_code_session_update>test</claude_code_session_update>', cwd: root,
      batchId: 'batch-live-tool-surface', canonicalMessages: [], assistantIntents: [], latestUserMessage: '',
    }, {
      createClient: () => ({}),
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
      runConversation: async (input: any) => { capturedTools = input.tools; return { response: { stop_reason: { stop_reason: 'end_turn' } }, clientToolFailure: false } as any; },
    });
    expect(completion).toBe('completed');
    const names = capturedTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...MEMORY_REMEMBER_TOOL_NAMES, 'memory_search', 'memory_reinforce', 'entity_search', 'entity_remember', 'deliver_whisper']));
    expect(names).not.toContain('memory_remember');
    const eventTool = capturedTools.find((tool) => tool.name === 'memory_remember_relationship_event');
    expect(Object.keys(eventTool.parameters.properties.payload.properties)).toEqual(['event', 'meaning', 'prior_context', 'resulting_change']);
    expect(eventTool.parameters.properties.payload.properties).not.toHaveProperty('emotional_tone');
  });

  it('keeps live delivery on the native Letta client-tool conversation loop', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(worker).toContain('createNativeLettaClient');
    expect(worker).toContain('runNativeClientToolConversation');
    expect(worker).toContain('turnSucceeded = !result.clientToolFailure');
    expect(worker).toContain('turnSucceeded = false');
    expect(worker).toContain('runtime.finalizeBatch(payload.batchId, turnSucceeded)');
    expect(worker).toContain('markConversationForRetryRotation(');
    expect(worker).toContain('armed live-conversation recovery marker for a later pass after overlap grace');
    expect(worker).not.toContain('@letta-ai/letta-code-sdk');
    expect(worker).not.toContain('resumeSession');
    expect(worker).not.toContain('runTurn(');
  });

  it('prevents raw Letta assistant history from becoming foreground context', () => {
    const sync = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_letta_memory.ts'), 'utf8');
    const pretool = fs.readFileSync(path.join(process.cwd(), 'scripts/pretool_sync.ts'), 'utf8');
    expect(sync).not.toContain('assistant_message');
    expect(sync).not.toContain('fetchAssistantMessages');
    expect(pretool).not.toContain('assistant_message');
    expect(pretool).not.toContain('fetchNewMessages');
    expect(sync).toContain('readPendingSubconWhispers');
    expect(pretool).toContain('readPendingSubconWhispers');
  });

  it('keeps the canonical live AgentFile on semantic next-turn recall without changing runtime configuration', () => {
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf8'));
    const agent = af.agents[0];
    const prompt = agent.system as string;
    expect(prompt).toContain('ASYNC RELATIONSHIP-MEMORY SURFACING');
    expect(prompt).toContain('<claude_code_session_update>');
    expect(prompt).toContain('<latest_user_message>');
    expect(prompt).toContain('choose the relationship memory_search query yourself');
    expect(prompt).toContain('compact semantic query');
    expect(prompt).toContain('must complete at least one relationship memory_search');
    expect(prompt).toContain('you may search again');
    expect(prompt).toContain('deliver_whisper');
    expect(prompt).not.toContain('use the exact text inside <latest_user_message> as your first memory_search query');
    expect(prompt).not.toContain('<subconscious_prompt_retrieval>');

    const blocks = new Map((af.blocks as any[]).map((block) => [block.label, String(block.value ?? '')]));
    expect(blocks.get('core_directives')).toContain('choose a compact semantic relationship memory_search query myself');
    expect(blocks.get('core_directives')).not.toContain('use <latest_user_message> exactly as the first memory_search query');
    expect(blocks.get('tool_guidelines')).toContain('I choose and execute at least one semantic query');
    for (const name of MEMORY_REMEMBER_TOOL_NAMES) expect(blocks.get('tool_guidelines')).toContain(name);
    expect(blocks.get('tool_guidelines')).not.toContain('the exact latest user message is prefetched once');

    expect(agent.model).toBe('openai-proxy/mimo-v2.5');
    expect(agent.model_settings?.parallel_tool_calls).toBe(true);
    expect(typeof agent.embedding).toBe('string');
    expect(agent.embedding.length).toBeGreaterThan(0);
  });
});
