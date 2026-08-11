#!/usr/bin/env npx tsx
import * as path from 'path';
import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { LegacyMemorySourceStore } from '../relationship-memory/src/legacy/index.js';
import {
  OMBRE_LEGACY_FROZEN_MANIFEST_DIGEST,
  runLegacySemanticMigration,
} from '../relationship-memory/src/legacy/semantic.js';
import { configureVerifiedLegacyFillRuntime, getBackfillAgentId } from './backfill_agent_config.js';
import { createConversation } from './conversation_utils.js';
import { runLegacySemanticObserverSource } from './legacy_semantic_observer_runner.js';
import { createNativeLettaClient, ensureLegacyCompletionTool } from './native_letta_backfill.js';

interface Args {
  root?: string;
  state?: string;
  expectedManifestDigest?: string;
  agentId?: string;
  runtimeProfile?: 'verified-dsv4';
  maxRecords: number;
  sourceIds: string[];
  dryRun: boolean;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/legacy_semantic_backfill.ts [--root <relationship-memory-dir>] [--state <checkpoint.json>] [--expected-manifest-digest <sha256>] [--agent-id <agent-id>] [--runtime-profile verified-dsv4] [--max-records N] [--source-id <legacy_source_id> ...] [--dry-run]');
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
    else if (flag === '--expected-manifest-digest') {
      if (!value) usage();
      result.expectedManifestDigest = value; i += 1;
    }
    else if (flag === '--agent-id') { if (!value) usage(); result.agentId = value; i += 1; }
    else if (flag === '--runtime-profile') { if (value !== 'verified-dsv4') usage(); result.runtimeProfile = value; i += 1; }
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
  const expectedManifestDigest = args.expectedManifestDigest
    ?? process.env.LEGACY_SEMANTIC_EXPECTED_MANIFEST_DIGEST
    ?? OMBRE_LEGACY_FROZEN_MANIFEST_DIGEST;
  if (!/^[0-9a-f]{64}$/i.test(expectedManifestDigest)) throw new Error('expected legacy semantic manifest digest must be a SHA-256 hex digest');
  const sourceStore = new LegacyMemorySourceStore(rootDir);
  const sources = sourceStore.listSources();
  if (sources.length === 0) {
    console.log(JSON.stringify({ status: 'no-op', processed: 0, remaining: 0, detail: 'no legacy assistant sources found' }));
    return;
  }
  const manifestDigests = [...new Set(sources.map((source) => source.manifest_digest))];
  if (manifestDigests.length !== 1) throw new Error('legacy semantic sources span multiple manifest digests');
  const manifestDigest = manifestDigests[0];
  if (manifestDigest !== expectedManifestDigest) {
    throw new Error(`legacy semantic source manifest ${manifestDigest} does not match expected frozen manifest ${expectedManifestDigest}`);
  }
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID ?? 'kohaku';

  if (args.dryRun) {
    const result = await runLegacySemanticMigration({
      rootDir, expectedManifestDigest, canonicalSubjectId: subjectId, statePath, maxRecords: args.maxRecords, sourceIds: args.sourceIds, dryRun: true,
      processor: async () => { throw new Error('dry-run must not invoke semantic processor'); },
    });
    console.log(JSON.stringify(result));
    return;
  }

  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) throw new Error('LETTA_API_KEY is required for legacy semantic backfill.');
  const agentId = await getBackfillAgentId(
    apiKey,
    (message) => console.error(`[legacy-backfill] ${message}`),
    { agentId: args.agentId, reconcileCanonicalPrompt: false },
  );
  if (args.runtimeProfile === 'verified-dsv4') {
    await configureVerifiedLegacyFillRuntime(apiKey, agentId, (message) => console.error(`[legacy-backfill] ${message}`));
  }
  const client = createNativeLettaClient(apiKey);
  const completionTool = await ensureLegacyCompletionTool(client, agentId);
  console.error(`[legacy-backfill] native terminal tool ready: ${completionTool.toolId} (attached=${completionTool.attached}, rulesChanged=${completionTool.rulesChanged})`);

  const result = await runLegacySemanticMigration({
    rootDir,
    expectedManifestDigest,
    canonicalSubjectId: subjectId,
    statePath,
    maxRecords: args.maxRecords,
    sourceIds: args.sourceIds,
    processor: async (source, batchId) => {
      const conversationId = await createConversation(apiKey, agentId, () => {});
      return runLegacySemanticObserverSource({
        agentId, conversationId, source, batchId, rootDir, subjectId, client,
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
