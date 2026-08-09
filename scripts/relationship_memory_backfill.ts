#!/usr/bin/env npx tsx
import * as path from 'path';
import { getAgentId } from './agent_config.js';
import { createConversation } from './conversation_utils.js';
import { runRelationshipObserverBatch } from './relationship_observer_runner.js';
import {
  loadBackfillState,
  runHistoricalBackfill,
  saveBackfillState,
  type HistoricalBatch,
} from '../relationship-memory/src/backfill/index.js';
import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { validateBackfillSnapshot } from '../relationship-memory/src/backfill/snapshot.js';

interface Args {
  transcript?: string;
  snapshotManifest?: string;
  state?: string;
  root?: string;
  cwd?: string;
  maxBatches: number;
  maxRecords: number;
  maxBytes: number;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/relationship_memory_backfill.ts (--snapshot-manifest <manifest.json> | --transcript <file-or-root>) --state <checkpoint.json> [--root <relationship-memory-dir>] [--cwd <dir>] [--max-batches N] [--max-records N] [--max-bytes N]');
  process.exit(2);
}

function positive(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { maxBatches: 1, maxRecords: 40, maxBytes: 2 * 1024 * 1024 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--transcript') { result.transcript = value; i += 1; }
    else if (flag === '--snapshot-manifest') { result.snapshotManifest = value; i += 1; }
    else if (flag === '--state') { result.state = value; i += 1; }
    else if (flag === '--root') { result.root = value; i += 1; }
    else if (flag === '--cwd') { result.cwd = value; i += 1; }
    else if (flag === '--max-batches') { result.maxBatches = positive(value, flag); i += 1; }
    else if (flag === '--max-records') { result.maxRecords = positive(value, flag); i += 1; }
    else if (flag === '--max-bytes') { result.maxBytes = positive(value, flag); i += 1; }
    else usage();
  }
  if ((!result.transcript && !result.snapshotManifest) || (result.transcript && result.snapshotManifest) || !result.state) usage();
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const transcript = args.snapshotManifest
    ? validateBackfillSnapshot(path.resolve(args.snapshotManifest)).transcriptPath
    : path.resolve(args.transcript!);
  const statePath = path.resolve(args.state!);
  const rootDir = path.resolve(args.root ?? relationshipMemoryRoot());
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) throw new Error('LETTA_API_KEY is required for relationship-memory historical backfill.');

  const state = loadBackfillState(statePath);
  const agentId = await getAgentId(apiKey, () => {});
  if (state.agent_id && state.agent_id !== agentId) {
    throw new Error(`Backfill state is bound to a different agent (${state.agent_id}); use a new checkpoint file.`);
  }
  if (state.conversation_id && !state.agent_id) {
    state.agent_id = agentId;
    saveBackfillState(statePath, state);
  }
  if (!state.conversation_id) {
    state.conversation_id = await createConversation(apiKey, agentId, () => {});
    state.agent_id = agentId;
    saveBackfillState(statePath, state);
  }
  const conversationId = state.conversation_id;

  const processor = async (batch: HistoricalBatch) => ({
    completion: await runRelationshipObserverBatch({
      agentId,
      conversationId,
      message: batch.observerMessage,
      cwd,
      batchId: batch.batchId,
      canonicalMessages: batch.canonicalMessages,
      rootDir,
      log: (message) => console.error(`[backfill] ${message}`),
    }),
  });

  const result = await runHistoricalBackfill({
    transcriptPath: transcript,
    statePath,
    maxBatches: args.maxBatches,
    maxRecordsPerBatch: args.maxRecords,
    maxBatchBytes: args.maxBytes,
    processor,
  });
  console.log(JSON.stringify(result));
  if (result.status === 'blocked-failure') process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'blocked-failure', detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
