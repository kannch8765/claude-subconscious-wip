#!/usr/bin/env npx tsx
/**
 * Sequential replay (docs/specs/OWN-HARNESS-DESIGN.md §6): archived turns of one period run in time order on ONE
 * store copy, so the harness's own writes accumulate and later turns see them. Each turn runs the sync pass, then
 * the async pass with sync's pick as session-known. Session-known and recently seen come from the harness's own
 * earlier passes in that session (picks, memories it created, last three searches).
 *
 * Nothing live is read after the start or written at all: the store and the semantic index are copied into --out
 * once. Search uses the existing vectors; only memories the harness creates get vectors, added to the index copy
 * (HTTP mode only). Recall timing is switched off. Before every turn the OpenCode Go usage meters are checked and
 * the run stops (exit 3, resumable) when the 5-hour or weekly meter passes its cap, leaving room for live traffic.
 *
 * Usage: tsx harness/sequential_replay.ts --batches <chronological jsonl> --store <start store dir> --index <index.json>
 *        --out <dir> [--limit n] [--model m] [--sync-model m] [--max-steps n] [--rolling-cap pct] [--weekly-cap pct]
 * Backends: see harness/backends.ts (HTTP with HARNESS_LLM_KEY_FILE on racknerd, or the ssh relay).
 * Rerunning with the same --out resumes after the last finished turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { backends } from './backends.js';
import { evidenceCoverage, commonBigrams } from './evidence_coverage.js';
import { runAsyncPass } from './pass.js';
import { runSyncPass } from './sync_pass.js';
import { prepareTurn } from './turn_input.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

interface Session { picked: string[]; written: string[]; passes: Array<Array<{ memory_id: string; summary: string }>> }

const USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';

/** Percent used of the 5-hour and weekly meters, or undefined when it cannot be read (relay mode, network). */
async function usageMeters(): Promise<{ rolling: number; weekly: number } | undefined> {
  const keyFile = process.env.HARNESS_LLM_KEY_FILE?.trim();
  if (!keyFile || process.env.HARNESS_RELAY_HOST) return undefined;
  try {
    const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${fs.readFileSync(keyFile, 'utf8').trim()}`, 'User-Agent': 'subcon-harness/0.1' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return undefined;
    const usage = (await response.json() as any).usage ?? {};
    return { rolling: Number(usage.rolling?.percent ?? 0), weekly: Number(usage.weekly?.percent ?? 0) };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING;
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE;
  const outDir = arg('out');
  const limit = Number(arg('limit', '0'));
  const model = arg('model', 'deepseek-v4.1-flash');
  const syncModel = arg('sync-model', 'glm-5.3-flash');
  const maxSteps = Number(arg('max-steps', '4'));
  const rollingCap = Number(arg('rolling-cap', '60'));
  const weeklyCap = Number(arg('weekly-cap', '70'));
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const storeDir = path.join(outDir, 'store');
  const indexFile = path.join(outDir, 'semantic-index', 'index.json');
  if (!fs.existsSync(storeDir)) {
    fs.cpSync(arg('store'), storeDir, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') || src === arg('store') });
    fs.mkdirSync(path.dirname(indexFile), { recursive: true, mode: 0o700 });
    fs.copyFileSync(arg('index'), indexFile);
  }

  const resultsFile = path.join(outDir, 'results.jsonl');
  const sessionsFile = path.join(outDir, 'sessions.json');
  const startedFile = path.join(outDir, 'started.json');
  const done = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).batch_id) : []);
  const sessions: Record<string, Session> = fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) : {};
  const append = (record: Record<string, unknown>): void => {
    fs.appendFileSync(resultsFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
    done.add(String(record.batch_id));
  };
  // A turn that started but never finished (crash, kill) may have written part of its pass: record it and go on.
  if (fs.existsSync(startedFile)) {
    const interrupted = JSON.parse(fs.readFileSync(startedFile, 'utf8')).batch_id as string;
    if (!done.has(interrupted)) append({ batch_id: interrupted, skip: 'interrupted' });
    fs.rmSync(startedFile, { force: true });
  }

  const batches = fs.readFileSync(arg('batches'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const queue = batches.filter((batch) => !done.has(batch.batch_id)).slice(0, limit > 0 ? Math.max(0, limit - done.size) : undefined);
  process.stderr.write(`sequential replay: ${queue.length} turns to run (${done.size} done), model=${model}, sync=${syncModel}\n`);

  const b = backends();
  const ignore = commonBigrams(new RelationshipMemoryStore(storeDir, 'local-user').listEvidenceForMemoryIds(
    new RelationshipMemoryStore(storeDir, 'local-user').listMemories().map((m) => m.memory_id)).map((e) => e.quote));
  let exitCode = 0;
  try {
    for (const batch of queue) {
      const meters = await usageMeters();
      if (meters && (meters.rolling >= rollingCap || meters.weekly >= weeklyCap)) {
        process.stderr.write(`paused: usage rolling ${meters.rolling}% weekly ${meters.weekly}% (caps ${rollingCap}/${weeklyCap})\n`);
        exitCode = 3;
        break;
      }
      fs.writeFileSync(startedFile, JSON.stringify({ batch_id: batch.batch_id }), { mode: 0o600 });
      const session = (sessions[batch.letta_session] ??= { picked: [], written: [], passes: [] });
      const started = Date.now();
      const turn = prepareTurn({
        latestUserMessage: batch.latest_user_message as string,
        canonicalMessages: batch.canonical_messages,
        previousUserMessage: batch.sync_context?.prev_user ?? '',
        previousKohakuReply: batch.sync_context?.prev_kohaku ?? '',
      });
      const input = { dropped: turn.dropped, ...(turn.latest_dropped ? { latest_dropped: turn.latest_dropped } : {}) };
      if (turn.empty) {
        append({ batch_id: batch.batch_id, session: batch.letta_session, input, skip: 'input_empty', usage_before: meters });
        fs.rmSync(startedFile, { force: true });
        continue;
      }
      const store = new RelationshipMemoryStore(storeDir, 'local-user');
      const runtime = new RelationshipMemoryRuntime(
        store,
        new Map(turn.canonicalMessages!.map((m: any) => [m.evidence_id ?? m.message_id, { ...m, conversation_id: batch.letta_session }])),
        () => new Date().toISOString(),
        new Map(batch.assistant_intents.map((intent: any) => [intent.intent_id, intent])),
        true,
        b.retrieverFor(indexFile, storeDir),
      );
      let record: Record<string, unknown>;
      try {
        const knownBefore = [...new Set([...session.picked, ...session.written])];
        const sync = await runSyncPass(runtime, b.transport, {
          batchId: batch.batch_id,
          sessionId: batch.letta_session,
          latestUserMessage: turn.latestUserMessage,
          previousUserMessage: turn.previousUserMessage!,
          previousKohakuReply: turn.previousKohakuReply!,
          sessionKnownMemoryIds: knownBefore,
        }, { model: syncModel, reasoningEffort: 'none' });
        const known = sync.whisper ? [...knownBefore, sync.whisper.memory_id] : knownBefore;
        const seen = new Map<string, string>();
        for (const pass of session.passes) for (const item of pass) seen.set(item.memory_id, item.summary);
        const asyncStarted = Date.now();
        const result = await runAsyncPass(runtime, b.transport, {
          batchId: batch.batch_id,
          sessionId: batch.letta_session,
          latestUserMessage: turn.latestUserMessage,
          canonicalMessages: turn.canonicalMessages!,
          assistantIntents: batch.assistant_intents,
          sessionKnownMemoryIds: known,
          recentSeen: [...seen].map(([memory_id, summary]) => ({ memory_id, summary })),
        }, { model, maxSteps, reasoningEffort: 'none' });
        const asyncMs = Date.now() - asyncStarted;

        const created = result.decisions.remember.filter((r) => r.outcome === 'accepted' && r.memory_id).map((r) => r.memory_id!);
        let embedMs: number | undefined;
        let embedError: string | undefined;
        if (created.length) {
          const embedStarted = Date.now();
          try { await runtime.prepareCurrentMemorySemanticIndex(new Set(created)); } catch (error) { embedError = error instanceof Error ? error.name : 'error'; }
          embedMs = Date.now() - embedStarted;
        }
        const coverage = created.map((id) => ({
          memory_id: id,
          coverage: evidenceCoverage(store.getMemory(id)?.summary ?? '', store.listEvidenceForMemoryIds([id]).map((e) => e.quote), ignore),
        }));

        if (sync.whisper) session.picked.push(sync.whisper.memory_id);
        if (result.decisions.whisper) session.picked.push(result.decisions.whisper.memory_id);
        session.written.push(...created);
        session.passes = [...session.passes, result.surfaced_memory_ids.map((id) => ({ memory_id: id, summary: (store.getMemory(id)?.summary ?? '').slice(0, 150) }))].slice(-3);

        record = {
          batch_id: batch.batch_id, session: batch.letta_session, group: batch.group, input, usage_before: meters,
          known_count: knownBefore.length, wall_ms: Date.now() - started, async_ms: asyncMs,
          sync, ...result, new_memory_coverage: coverage, ...(embedMs !== undefined ? { embed_ms: embedMs } : {}), ...(embedError ? { embed_error: embedError } : {}),
        };
      } catch (error) {
        record = { batch_id: batch.batch_id, session: batch.letta_session, wall_ms: Date.now() - started, crashed: error instanceof Error ? error.name : 'unknown' };
      }
      fs.writeFileSync(sessionsFile, JSON.stringify(sessions), { mode: 0o600 });
      append(record);
      fs.rmSync(startedFile, { force: true });
      for (const file of fs.readdirSync(path.dirname(indexFile))) if (file.includes('provider-cooldown')) fs.rmSync(path.join(path.dirname(indexFile), file), { force: true });
      const r = record as any;
      process.stderr.write(`  ${batch.batch_id}: ${r.crashed ? `CRASHED ${r.crashed}` : `${r.completion} sync=${r.sync?.whisper ? 'whisper' : r.sync?.skip_reason} async=${r.decisions?.whisper ? 'whisper' : '-'} r${r.decisions?.reinforce?.length ?? 0} m${acceptedCount(r)} ${r.wall_ms} ms`}\n`);
    }
  } finally {
    await b.close();
  }
  process.exit(exitCode);
}

function acceptedCount(r: any): number {
  return (r.decisions?.remember ?? []).filter((x: any) => x.outcome === 'accepted').length;
}

main().catch((error) => {
  process.stderr.write(`sequential replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
