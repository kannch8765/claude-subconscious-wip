import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('additive synchronous Subcon mode contract', () => {
  it('keeps the existing Stop lane asynchronous and makes sync explicit opt-in', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'hooks/hooks.json'), 'utf8'));
    const stop = hooks.hooks.Stop[0].hooks[0];
    expect(stop.async).toBe(true);
    expect(stop.command).toContain('send_messages_to_letta.ts');

    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(worker).toContain("const mode: LiveWorkerMode = payload.mode ?? 'async'");
    expect(worker).toContain("const isSync = mode === 'sync'");
    expect(worker).toContain('if (!isSync) {');
    expect(worker).toContain('runtime.store.beginBatch(payload.batchId');
    expect(worker).toContain('runtime.finalizeBatch(payload.batchId, turnSucceeded)');
  });

  it('makes sync recall read-only while preserving the full async mutation surface', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    expect(worker).toContain("baseRelationshipTools.filter((tool) => tool.name === 'entity_search')");
    expect(worker).toContain("name: 'expand_recall'");
    expect(worker).toContain('buildForegroundRecallBundle');
    expect(worker).toContain('persistForegroundRecallBundle');
    expect(worker).toContain('renderForegroundRecallBundle');
    expect(worker).toContain("name: 'resolve_recall'");
    expect(worker).toContain("name: 'deliver_whisper'");
    expect(worker).toContain("['memory_remember', 'memory_reinforce', 'entity_remember']");
    expect(worker).toContain('runtime.memorySearchRecallHybridWithEvidence');
    expect(worker).toContain('runtime.entitySearchRecallHybrid');
    expect(worker).toContain('stdio MCP client tools: (disabled in sync mode)');
    expect(worker).toContain('continuationBusyRetry: { maxWaitMs: 3_000, intervalMs: 100 }');
    expect(worker.match(/continuationBusyRetry/g)?.length).toBe(1);
    expect(worker).toContain('openStdioMcpToolsFromEnvironment(log)');
  });

  it('scopes sync whispers to the runtime-armed UserPromptSubmit without changing async/pretool delivery', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    const syncHook = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_letta_memory.ts'), 'utf8');
    const pretool = fs.readFileSync(path.join(process.cwd(), 'scripts/pretool_sync.ts'), 'utf8');
    expect(worker).toContain("isSync ? { source: 'sync', turnId: payload.syncTurnId! } : undefined");
    expect(syncHook).toContain('SUBCON_SYNC_EXPECTED_TURN_FILE');
    expect(syncHook).toContain('partitionPendingSubconWhispersForTurn(allPendingWhispers, expectedTurnId)');
    expect(syncHook).toContain('acknowledgePendingSubconWhispers(staleSyncWhispers)');
    expect(pretool).toContain('partitionPendingSubconWhispersForTurn(');
    expect(pretool).toContain(').deliverable');
    expect(worker).toContain('writeForegroundRecallReceipt');
    expect(worker).toContain("decision: 'selected'");
    expect(worker).toContain("decision: 'none'");
  });

  it('checkpoints after durable queueing and transfers post-release cleanup ownership to the worker', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'scripts/send_worker_native.ts'), 'utf8');
    const queued = worker.indexOf('const queued = queueSubconWhisper(');
    const checkpoint = worker.indexOf("writeSyncCheckpoint(payload, 'whisper'");
    const completion = worker.indexOf('Native live turn complete: mode=${mode}');
    expect(queued).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(queued);
    expect(completion).toBeGreaterThan(checkpoint);
    expect(worker).toContain('clientToolRoundGate: syncClientToolRoundGate');
    expect(worker).toContain("requiredClientToolNames: ['resolve_recall']");
    expect(worker).toContain('Post-release sync failure cleanup deferred');
    expect(worker).toContain('cancelAndDeferSyncResources');
    expect(worker).toContain('cleanupCompletedSyncResources');

    const sync = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_subcon.ts'), 'utf8');
    const resources = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_letta_resources.ts'), 'utf8');
    expect(sync).toContain('createToolStrippedSyncAgent');
    expect(sync).toContain("mode: 'sync'");
    expect(sync).toContain('<foreground_recall_bundle>');
    expect(sync).toContain('expand_recall once');
    expect(sync).toContain('resolve_recall exactly once');
    expect(sync).toContain('decision=none');
    expect(sync).not.toContain('must complete at least one relationship memory_search');
    expect(sync).toContain('cleanupSyncResourcesOnFinish: true');
    expect(sync).toContain('process.exit(0)');
    expect(sync).toContain('cancelAndDeferSyncResources');
    expect(sync).toContain('await stopChild(child)');
    expect(sync.indexOf('cancelAndDeferSyncResources')).toBeLessThan(sync.indexOf('await stopChild(child)'));
    expect(sync).toContain('reapDeferredSyncResources(apiKey)');
    expect(sync).toContain('removePendingSubconWhisper(input.cwd, input.session_id, batchId)');
    expect(sync).toContain("process.once('SIGTERM'");
    expect(sync.indexOf("process.once('SIGTERM'")).toBeLessThan(sync.indexOf('createToolStrippedSyncAgent(apiKey, batchId)'));
    expect(resources).toContain('getConfiguredAgentIdReadOnly');
    expect(resources).toContain('tool_ids: []');
    expect(resources).toContain('include_base_tools: false');
    expect(resources).toContain("DEFERRED_CLEANUP_MIN_AGE_MS = 5 * 60_000");
  });
});
