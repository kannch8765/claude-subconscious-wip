import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('live async relationship-memory surfacing contract', () => {
  it('reuses exact foreground recall receipts and makes async search conditional instead of mandatory', () => {
    const send = fs.readFileSync(path.join(process.cwd(), 'scripts/send_messages_to_letta.ts'), 'utf8');
    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    const sync = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_letta_memory.ts'), 'utf8');
    expect(send).toContain('<latest_user_message>');
    expect(send).toContain('<foreground_recall_receipt_catalog>');
    expect(send).toContain('There is no search quota');
    expect(send).toContain('surface != reinforce');
    expect(send).toContain('readForegroundRecallTurnStateForMessage');
    expect(send).toContain('latestUserMessageId');
    expect(send).toContain('foregroundRecallTurns');
    expect(send).toContain('bindPendingForegroundRecallTurnsToMessages');
    expect(sync).toContain('v2 never derives transcript identity from prompt text');
    expect(worker).toContain("name: 'deliver_whisper'");
    expect(worker).toContain('latestForegroundRecallResolved');
    expect(worker).toContain('Skipping async deliver_whisper because foreground recall already resolved');
    expect(worker).toContain('renderForegroundRecallReceiptCatalog');
    expect(worker).toContain('requiredClientToolNames: []');
    expect(worker).not.toContain("requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : []");
    expect(worker).toContain('Model relationship memory_search: query=');
    expect(worker).toContain('memory_reinforce');
    expect(worker).toContain('memory_remember');
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
    expect(prompt).toContain('<foreground_recall_receipt_catalog>');
    expect(prompt).toContain('There is no mandatory search quota');
    expect(prompt).toContain('decision=selected is only a foreground continuity decision');
    expect(prompt).toContain('deliver_whisper');
    expect(prompt).not.toContain('must complete at least one relationship memory_search');
    expect(prompt).not.toContain('use the exact text inside <latest_user_message> as your first memory_search query');
    expect(prompt).not.toContain('<subconscious_prompt_retrieval>');

    const blocks = new Map((af.blocks as any[]).map((block) => [block.label, String(block.value ?? '')]));
    expect(blocks.get('core_directives')).toContain('surface != reinforce');
    expect(blocks.get('core_directives')).toContain('There is no mandatory search quota');
    expect(blocks.get('tool_guidelines')).toContain('there is no per-pass search quota');
    expect(blocks.get('tool_guidelines')).not.toContain('I choose and execute at least one semantic query');

    expect(agent.model).toBe('openai-proxy/mimo-v2.5');
    expect(agent.model_settings?.parallel_tool_calls).toBe(true);
    expect(typeof agent.embedding).toBe('string');
    expect(agent.embedding.length).toBeGreaterThan(0);
  });
});
