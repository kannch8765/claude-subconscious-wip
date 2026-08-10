#!/usr/bin/env npx tsx
import * as path from 'path';
import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { LegacyMemorySourceStore } from '../relationship-memory/src/legacy/index.js';
import {
  loadLegacySemanticState,
  runLegacySemanticMigration,
  saveLegacySemanticState,
} from '../relationship-memory/src/legacy/semantic.js';
import { getBackfillAgentId } from './backfill_agent_config.js';
import { createConversation } from './conversation_utils.js';
import { runLegacySemanticObserverSource } from './legacy_semantic_observer_runner.js';

interface Args {
  root?: string;
  state?: string;
  cwd?: string;
  maxRecords: number;
  sourceIds: string[];
  dryRun: boolean;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/legacy_semantic_backfill.ts [--root <relationship-memory-dir>] [--state <checkpoint.json>] [--cwd <dir>] [--max-records N] [--source-id <legacy_source_id> ...] [--dry-run]');
  process.exit(2);
}

function positive(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { maxRecords: 1, sourceIds: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root') { result.root = value; i += 1; }
    else if (flag === '--state') { result.state = value; i += 1; }
    else if (flag === '--cwd') { result.cwd = value; i += 1; }
    else if (flag === '--max-records') { result.maxRecords = positive(value, flag); i += 1; }
    else if (flag === '--source-id') {
      if (!value) usage();
      result.sourceIds.push(value); i += 1;
    } else if (flag === '--dry-run') result.dryRun = true;
    else usage();
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root ?? relationshipMemoryRoot());
  const statePath = path.resolve(args.state ?? path.join(rootDir, 'legacy-semantic-migration-state.json'));
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const sourceStore = new LegacyMemorySourceStore(rootDir);
  const sources = sourceStore.listSources();
  if (sources.length === 0) {
    console.log(JSON.stringify({ status: 'no-op', processed: 0, remaining: 0, detail: 'no legacy assistant sources found' }));
    return;
  }
  const manifestDigests = [...new Set(sources.map((source) => source.manifest_digest))];
  if (manifestDigests.length !== 1) throw new Error('legacy semantic sources span multiple manifest digests');
  const manifestDigest = manifestDigests[0];

  if (args.dryRun) {
    const result = await runLegacySemanticMigration({
      rootDir, statePath, maxRecords: args.maxRecords, sourceIds: args.sourceIds, dryRun: true,
      processor: async () => { throw new Error('dry-run must not invoke semantic processor'); },
    });
    console.log(JSON.stringify(result));
    return;
  }

  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) throw new Error('LETTA_API_KEY is required for legacy semantic backfill.');
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID ?? 'local-user';
  const agentId = await getBackfillAgentId(apiKey, (message) => console.error(`[legacy-backfill] ${message}`));
  const state = loadLegacySemanticState(statePath, manifestDigest);
  if (state.agent_id && state.agent_id !== agentId) {
    throw new Error(`Legacy semantic state is bound to a different backfill agent (${state.agent_id}); use the original dedicated agent or a new state file.`);
  }
  if (!state.agent_id) {
    state.agent_id = agentId;
    saveLegacySemanticState(statePath, state);
  }

  const result = await runLegacySemanticMigration({
    rootDir,
    statePath,
    maxRecords: args.maxRecords,
    sourceIds: args.sourceIds,
    processor: async (source, batchId) => {
      const conversationId = await createConversation(apiKey, agentId, () => {});
      return runLegacySemanticObserverSource({
        agentId, conversationId, source, batchId, rootDir, subjectId, cwd,
        log: (message) => console.error(`[legacy-backfill] ${message}`),
      });
    },
  });
  console.log(JSON.stringify(result));
  if (result.status === 'blocked-failure') process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'blocked-failure', detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
