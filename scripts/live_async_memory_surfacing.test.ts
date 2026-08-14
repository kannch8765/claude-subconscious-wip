import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

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
    expect(worker).not.toContain('runtime.memorySearchHybrid({ query: firstSearchQuery');
    expect(worker).not.toContain('prefetched_relationship_memory_search');
    expect(send).toContain('latestUserMessage,');
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

  it('keeps the live Subcon prompt on the async next-turn flow rather than prompt-time recall', () => {
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf8'));
    const prompt = af.agents[0].system as string;
    expect(prompt).toContain('ASYNC RELATIONSHIP-MEMORY SURFACING');
    expect(prompt).toContain('<claude_code_session_update>');
    expect(prompt).toContain('<latest_user_message>');
    expect(prompt).toContain('deliver_whisper');
    expect(prompt).not.toContain('<subconscious_prompt_retrieval>');
  });
});
