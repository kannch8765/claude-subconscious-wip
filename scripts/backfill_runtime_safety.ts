import * as fs from 'fs';
import * as path from 'path';

export const PRIVILEGED_SNAPSHOT_ROOT = '/var/lib/subconscious-backfill-input';

export interface PrivilegedBackfillSafetyInput {
  snapshotManifest?: string;
  statePath: string;
  rootDir: string;
  agentId?: string;
}

export interface PrivilegedBackfillSafetyOptions {
  privilegedSnapshotRoot?: string;
  currentUid?: number;
  env?: NodeJS.ProcessEnv;
}

export function pathWithin(candidate: string, root: string): boolean {
  const absolute = path.resolve(candidate);
  const boundary = path.resolve(root);
  return absolute === boundary || absolute.startsWith(`${boundary}${path.sep}`);
}

export function assertSemanticIndexWriterOwnership(indexDir: string, currentUid = process.getuid?.()): void {
  if (currentUid === undefined) return;
  const targets = [indexDir, path.join(indexDir, 'index.json')].filter((target) => fs.existsSync(target));
  if (targets.length === 0) {
    throw new Error(`Shared semantic index does not exist yet: ${indexDir}; refuse privileged backfill bootstrap without an established live-owned index.`);
  }
  for (const target of targets) {
    const stat = fs.statSync(target);
    if (stat.uid !== currentUid) {
      throw new Error(`Backfill uid ${currentUid} does not own shared semantic index target ${target} (uid ${stat.uid}); run backfill as the live semantic-index owner to preserve atomic-rename ownership.`);
    }
  }
}

export function assertPrivilegedSnapshotRuntimeSafety(
  input: PrivilegedBackfillSafetyInput,
  options: PrivilegedBackfillSafetyOptions = {},
): void {
  const privilegedSnapshotRoot = options.privilegedSnapshotRoot ?? PRIVILEGED_SNAPSHOT_ROOT;
  if (!input.snapshotManifest || !pathWithin(input.snapshotManifest, privilegedSnapshotRoot)) return;
  const env = options.env ?? process.env;

  const subjectId = env.RELATIONSHIP_MEMORY_SUBJECT_ID?.trim();
  if (!subjectId) throw new Error('Privileged owner-snapshot backfill requires explicit RELATIONSHIP_MEMORY_SUBJECT_ID.');

  const configuredRoot = env.RELATIONSHIP_MEMORY_DIR?.trim();
  if (!configuredRoot) throw new Error('Privileged owner-snapshot backfill requires explicit RELATIONSHIP_MEMORY_DIR.');
  if (path.resolve(configuredRoot) !== path.resolve(input.rootDir)) {
    throw new Error(`Backfill canonical root mismatch: RELATIONSHIP_MEMORY_DIR=${path.resolve(configuredRoot)} but effective root is ${path.resolve(input.rootDir)}.`);
  }

  const semanticIndexDir = env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR?.trim();
  if (!semanticIndexDir) {
    throw new Error('Privileged owner-snapshot backfill requires explicit RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR so it cannot fork a default semantic cache.');
  }
  assertSemanticIndexWriterOwnership(path.resolve(semanticIndexDir), options.currentUid);

  const explicitBackfillAgent = input.agentId ?? env.LETTA_BACKFILL_AGENT_ID?.trim();
  if (!explicitBackfillAgent) {
    throw new Error('Privileged owner-snapshot backfill requires --agent-id or LETTA_BACKFILL_AGENT_ID so a service-user HOME change cannot provision a second backfill agent.');
  }

  if (pathWithin(input.statePath, privilegedSnapshotRoot)) {
    throw new Error('Backfill checkpoint must live outside the immutable privileged snapshot root.');
  }
}
