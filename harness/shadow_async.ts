#!/usr/bin/env npx tsx
/**
 * Shadow async worker (docs/specs/OWN-HARNESS-DESIGN.md §6.1). Spawned detached by the Stop hook when
 * SUBCON_SHADOW=1, with a copy of the payload the hook wrote for Letta. Refreshes the shadow snapshot, waits
 * for the shadow sync record of the same turn (its pick counts as session-known), runs the async pass on the
 * snapshot, and writes one trace record. Writes stay in the snapshot; nothing is delivered.
 *
 * Usage: tsx harness/shadow_async.ts <payload.json>
 */
import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { getSyncStateFile } from '../scripts/conversation_utils.js';
import { commonBigrams, evidenceCoverage } from './evidence_coverage.js';
import { runAsyncPass } from './pass.js';
import { errorText, shadowBackends, snapshotRuntime, takePayload, type ShadowBackends } from './shadow_common.js';
import { appendTrace, liveKnownMemoryIds, readShadowSession, refreshSnapshot, shadowPaths, takeSyncPick, turnKey, updateShadowSession, withLaneLock } from './shadow_state.js';
import { prepareTurn } from './turn_input.js';

interface AsyncPayload {
  sessionId: string;
  cwd: string;
  batchId: string;
  conversationId?: string;
  latestUserMessage: string;
  canonicalMessages: CanonicalMessage[];
  assistantIntents: AssistantRememberIntentRecord[];
}

async function main(): Promise<void> {
  const payload = takePayload<AsyncPayload>(process.argv[2]);
  const paths = shadowPaths(relationshipMemoryRoot());
  const key = turnKey(payload.sessionId, payload.latestUserMessage ?? '');
  const base = { lane: 'async', session_id: payload.sessionId, batch_id: payload.batchId, turn_key: key };
  const started = Date.now();
  let backends: ShadowBackends | undefined;
  try {
    const b = (backends = shadowBackends());
    const outcome = await withLaneLock(paths, 'async', async () => {
      const turn = prepareTurn({ latestUserMessage: payload.latestUserMessage ?? '', canonicalMessages: payload.canonicalMessages ?? [] });
      const input = { dropped: turn.dropped, ...(turn.latest_dropped ? { latest_dropped: turn.latest_dropped } : {}) };
      if (turn.empty) return appendTrace(paths, { ...base, input, skip: 'input_empty' });

      const snapshot = refreshSnapshot(paths);
      const { pick, join } = await takeSyncPick(paths, payload.sessionId, key);
      const session = readShadowSession(paths, payload.sessionId);
      const known = [...new Set([
        ...liveKnownMemoryIds(getSyncStateFile(payload.cwd, payload.sessionId)),
        ...session.picked_memory_ids,
        ...(pick?.memory_id ? [pick.memory_id] : []),
      ])];
      const seen = new Map<string, string>();
      for (const pass of session.passes) for (const item of pass.seen) seen.set(item.memory_id, item.summary);

      const passStarted = Date.now();
      const result = await runAsyncPass(snapshotRuntime(b, snapshot, turn.canonicalMessages!, payload.assistantIntents ?? [], payload.conversationId), b.transport, {
        batchId: payload.batchId,
        sessionId: payload.sessionId,
        latestUserMessage: turn.latestUserMessage,
        canonicalMessages: turn.canonicalMessages!,
        assistantIntents: payload.assistantIntents ?? [],
        sessionKnownMemoryIds: known,
        recentSeen: [...seen].map(([memory_id, summary]) => ({ memory_id, summary })),
      }, { model: process.env.SUBCON_SHADOW_ASYNC_MODEL?.trim() || 'deepseek-v4.1-flash', maxSteps: 4, reasoningEffort: 'none' });
      const passMs = Date.now() - passStarted;

      const store = new RelationshipMemoryStore(snapshot.storeDir, process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user');
      const created = result.decisions.remember.filter((r) => r.outcome === 'accepted' && r.memory_id).map((r) => r.memory_id!);
      let coverage: Array<{ memory_id: string; coverage?: number }> = [];
      if (created.length) {
        const ignore = commonBigrams(store.listEvidenceForMemoryIds(store.listMemories().map((m) => m.memory_id)).map((e) => e.quote));
        coverage = created.map((id) => ({ memory_id: id, coverage: evidenceCoverage(store.getMemory(id)?.summary ?? '', store.listEvidenceForMemoryIds([id]).map((e) => e.quote), ignore) }));
      }
      await updateShadowSession(paths, payload.sessionId, (s) => {
        s.passes.push({ at: new Date().toISOString(), seen: result.surfaced_memory_ids.map((id) => ({ memory_id: id, summary: (store.getMemory(id)?.summary ?? '').slice(0, 150) })) });
        if (result.decisions.whisper) s.picked_memory_ids.push(result.decisions.whisper.memory_id);
      });

      const { query_texts, ...decisions } = result.decisions;
      appendTrace(paths, {
        ...base,
        gen: snapshot.gen,
        refresh: { copy_ms: snapshot.copy_ms, live_changed_during_copy: snapshot.live_changed_during_copy, index: snapshot.index },
        input,
        sync_join: join,
        ...(pick?.memory_id ? { sync_memory_id: pick.memory_id } : {}),
        known_count: known.length,
        pass_ms: passMs,
        wall_ms: Date.now() - started,
        succeeded: result.succeeded,
        completion: result.completion,
        steps: result.steps,
        decisions: { ...decisions, query_count: query_texts?.length ?? 0 },
        tool_errors: result.tool_errors.map((e) => e.name),
        surfaced_count: result.surfaced_memory_ids.length,
        new_memory_coverage: coverage,
      });
    });
    if (outcome === 'busy') appendTrace(paths, { ...base, skip: 'busy' });
  } catch (error) {
    appendTrace(paths, { ...base, wall_ms: Date.now() - started, crashed: errorText(error) });
  } finally {
    await backends?.close();
  }
}

void main();
