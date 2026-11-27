#!/usr/bin/env npx tsx
/**
 * Shadow sync worker (docs/specs/OWN-HARNESS-DESIGN.md §6.1). Spawned detached by the UserPromptSubmit hook when
 * SUBCON_SHADOW=1. Runs the sync pass on the current shadow snapshot, records its pick in the shadow session
 * state for the shadow async pass of the same turn, and writes one trace record. Delivers nothing.
 *
 * Usage: tsx harness/shadow_sync.ts <payload.json>
 *   payload: { session_id, prompt, transcript_path, cwd, prompt_at }
 */
import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { getSyncStateFile } from '../scripts/conversation_utils.js';
import { extractAllContent, readTranscript } from '../scripts/transcript_utils.js';
import { errorText, shadowBackends, snapshotRuntime, takePayload, type ShadowBackends } from './shadow_common.js';
import { appendTrace, currentSnapshot, liveKnownMemoryIds, readShadowSession, shadowPaths, turnKey, updateShadowSession, withLaneLock } from './shadow_state.js';
import { runSyncPass } from './sync_pass.js';
import { prepareTurn, previousTurn, type TurnText } from './turn_input.js';

interface SyncPayload { session_id: string; prompt: string; transcript_path: string; cwd: string; prompt_at: string }

async function main(): Promise<void> {
  const payload = takePayload<SyncPayload>(process.argv[2]);
  const paths = shadowPaths(relationshipMemoryRoot());
  const key = turnKey(payload.session_id, payload.prompt);
  const base = { lane: 'sync', session_id: payload.session_id, turn_key: key, prompt_at: payload.prompt_at };
  const started = Date.now();
  let backends: ShadowBackends | undefined;
  try {
    const b = (backends = shadowBackends());
    const outcome = await withLaneLock(paths, 'sync', async () => {
      const snapshot = currentSnapshot(paths);
      if (!snapshot) return appendTrace(paths, { ...base, skip: 'no_snapshot' });
      const messages: TurnText[] = (await readTranscript(payload.transcript_path))
        .filter((m) => m.type === 'user' || m.type === 'assistant')
        .map((m) => ({ role: m.type === 'user' ? 'user' as const : 'assistant' as const, text: extractAllContent(m).text ?? '' }));
      const turn = prepareTurn({ latestUserMessage: payload.prompt, ...previousTurn(messages, payload.prompt) });
      const input = { dropped: turn.dropped, ...(turn.latest_dropped ? { latest_dropped: turn.latest_dropped } : {}) };
      if (turn.empty) return appendTrace(paths, { ...base, gen: snapshot.gen, input, skip: 'input_empty' });

      const session = readShadowSession(paths, payload.session_id);
      const known = [...new Set([...liveKnownMemoryIds(getSyncStateFile(payload.cwd, payload.session_id)), ...session.picked_memory_ids])];
      const result = await runSyncPass(snapshotRuntime(b, snapshot, [], []), b.transport, {
        batchId: `shadow-sync-${key}`,
        sessionId: payload.session_id,
        latestUserMessage: turn.latestUserMessage,
        previousUserMessage: turn.previousUserMessage!,
        previousKohakuReply: turn.previousKohakuReply!,
        sessionKnownMemoryIds: known,
      }, { model: process.env.SUBCON_SHADOW_SYNC_MODEL?.trim() || 'glm-5.3-flash', reasoningEffort: 'none' });

      await updateShadowSession(paths, payload.session_id, (s) => {
        s.sync.push({ turn_key: key, at: new Date().toISOString(), ...(result.whisper ? { memory_id: result.whisper.memory_id } : {}) });
        if (result.whisper) s.picked_memory_ids.push(result.whisper.memory_id);
      });
      const { phrases, ...rest } = result;
      appendTrace(paths, { ...base, gen: snapshot.gen, input, known_count: known.length, wall_ms: Date.now() - started, sync: { ...rest, phrase_count: phrases.length } });
    });
    if (outcome === 'busy') appendTrace(paths, { ...base, skip: 'busy' });
  } catch (error) {
    appendTrace(paths, { ...base, wall_ms: Date.now() - started, crashed: errorText(error) });
  } finally {
    await backends?.close();
  }
}

void main();
