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
  accessSync?: (target: fs.PathLike, mode?: number) => void;
}

/**
 * Files that the historical relationship observer can append through the current
 * RelationshipMemoryStore mutation surface: begin/finalize batch plus
 * memory_remember, memory_reinforce, and entity_remember outcomes/evidence.
 * Missing files are creatable when the canonical root itself is writable; only
 * already-existing targets need an independent effective-write check.
 */
export const HISTORICAL_CANONICAL_MUTATION_TARGETS = [
  'batches.jsonl',
  'memories.jsonl',
  'evidence.jsonl',
  'outcomes.jsonl',
  'reinforcements.jsonl',
  'entities.jsonl',
  'entity-evidence.jsonl',
  'entity-outcomes.jsonl',
] as const;

export function pathWithin(candidate: string, root: string): boolean {
  const absolute = path.resolve(candidate);
  const boundary = path.resolve(root);
  return absolute === boundary || absolute.startsWith(`${boundary}${path.sep}`);
}

export function assertCanonicalStoreWriterAccess(
  rootDir: string,
  accessSync: (target: fs.PathLike, mode?: number) => void = fs.accessSync,
): void {
  const canonicalRoot = path.resolve(rootDir);
  try {
    // RelationshipMemoryStore acquires .canonical-mutation.lock with mkdirSync,
    // so the process needs effective write+execute access on the parent root.
    accessSync(canonicalRoot, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw new Error(`Backfill process lacks effective write+execute access to canonical mutation root ${canonicalRoot}; cannot create .canonical-mutation.lock (${error instanceof Error ? error.message : String(error)}).`);
  }

  for (const name of HISTORICAL_CANONICAL_MUTATION_TARGETS) {
    const target = path.join(canonicalRoot, name);
    if (!fs.existsSync(target)) continue;
    try {
      // accessSync asks the kernel about process filesystem permissions,
      // including ACL grants; ownership is intentionally irrelevant.
      accessSync(target, fs.constants.W_OK);
    } catch (error) {
      throw new Error(`Backfill process lacks effective write access to existing canonical mutation target ${target} (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
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
  assertCanonicalStoreWriterAccess(path.resolve(configuredRoot), options.accessSync);

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
