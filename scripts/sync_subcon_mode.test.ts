import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MEMORY_REMEMBER_TOOL_NAMES } from '../relationship-memory/src/tools/index.js';
import { RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS } from '../relationship-memory/src/adapter/index.js';

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
    expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'entity_search']);
    for (const name of MEMORY_REMEMBER_TOOL_NAMES) expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).not.toContain(name as any);
    expect(worker).toContain('baseRelationshipTools.filter((tool) => syncAllowedTools.has(tool.name))');
    expect(worker).toContain("name: 'deliver_whisper'");
    expect(worker).toContain('isRelationshipMutationClientTool(tool.name)');
    expect(worker).toContain('runtime.memorySearchRecallHybrid');
    expect(worker).toContain('runtime.entitySearchRecallHybrid');
    expect(worker).toContain('stdio MCP client tools: (disabled in sync mode)');
    expect(worker).toContain('continuationBusyRetry: { maxWaitMs: 3_000, intervalMs: 100 }');
    expect(worker.match(/continuationBusyRetry/g)?.length).toBe(1);
    expect(worker).toContain('(dependencies.openStdioMcp ?? openStdioMcpToolsFromEnvironment)(log)');
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
    expect(worker).toContain('Post-whisper sync failure cleanup deferred');
    expect(worker).toContain('cancelAndDeferSyncResources');
    expect(worker).toContain('cleanupCompletedSyncResources');

    const sync = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_subcon.ts'), 'utf8');
    const resources = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_letta_resources.ts'), 'utf8');
    expect(sync).toContain('createToolStrippedSyncAgent');
    expect(sync).toContain("mode: 'sync'");
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
