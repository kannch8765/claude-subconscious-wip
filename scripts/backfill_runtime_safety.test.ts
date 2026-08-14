import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORICAL_CANONICAL_MUTATION_TARGETS,
  assertCanonicalStoreWriterAccess,
  assertPrivilegedSnapshotRuntimeSafety,
} from './backfill_runtime_safety.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-backfill-safety-'));
  roots.push(root);
  const privileged = path.join(root, 'privileged');
  const snapshot = path.join(privileged, 'batch', 'manifest.json');
  const canonical = path.join(root, 'canonical');
  const semantic = path.join(root, 'semantic');
  const state = path.join(root, 'state', 'backfill.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.mkdirSync(canonical, { recursive: true });
  for (const name of HISTORICAL_CANONICAL_MUTATION_TARGETS) fs.writeFileSync(path.join(canonical, name), '{}\n');
  fs.mkdirSync(semantic, { recursive: true });
  fs.writeFileSync(path.join(semantic, 'index.json'), '{}');
  const uid = fs.statSync(semantic).uid;
  const env = {
    RELATIONSHIP_MEMORY_SUBJECT_ID: 'kohaku',
    RELATIONSHIP_MEMORY_DIR: canonical,
    RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR: semantic,
    LETTA_BACKFILL_AGENT_ID: 'agent-6972b32d-29c0-454c-986a-deb6184bd287',
  };
  return { root, privileged, snapshot, canonical, semantic, state, uid, env };
}

describe('privileged historical backfill runtime safety', () => {
  it('accepts a shared live-owned semantic index with explicit subject/root/backfill agent', () => {
    const f = fixture();
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env: f.env },
    )).not.toThrow();
  });

  it('refuses an implicit semantic index path that could fork the live cache', () => {
    const f = fixture();
    const env = { ...f.env };
    delete env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR;
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env },
    )).toThrow(/requires explicit RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR/);
  });

  it('refuses a semantic index owned by another uid so atomic rename cannot transfer ownership', () => {
    const f = fixture();
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid + 1, env: f.env },
    )).toThrow(/does not own shared semantic index target/);
  });

  it('refuses implicit dedicated-agent provisioning when service HOME differs from the old haru HOME', () => {
    const f = fixture();
    const env = { ...f.env };
    delete env.LETTA_BACKFILL_AGENT_ID;
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env },
    )).toThrow(/requires --agent-id or LETTA_BACKFILL_AGENT_ID/);
  });

  it('refuses a checkpoint inside the immutable snapshot tree', () => {
    const f = fixture();
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: path.join(f.privileged, 'state.json'), rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env: f.env },
    )).toThrow(/checkpoint must live outside/);
  });

  it('derives the privileged writer preflight from the historical store mutation surface only', () => {
    expect(HISTORICAL_CANONICAL_MUTATION_TARGETS).toEqual([
      'batches.jsonl', 'memories.jsonl', 'evidence.jsonl', 'outcomes.jsonl',
      'reinforcements.jsonl', 'entities.jsonl', 'entity-evidence.jsonl', 'entity-outcomes.jsonl',
    ]);
  });

  it('fails closed before semantic/API work when the process cannot create the canonical mutation lock', () => {
    const f = fixture();
    const semanticProbe = vi.fn();
    const accessSync = vi.fn((target: fs.PathLike, mode?: number) => {
      if (path.resolve(String(target)) === path.resolve(f.canonical) && mode === (fs.constants.W_OK | fs.constants.X_OK)) {
        const error = Object.assign(new Error('synthetic ACL denial'), { code: 'EACCES' });
        throw error;
      }
      semanticProbe();
    });

    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid + 1, env: f.env, accessSync },
    )).toThrow(/lacks effective write\+execute access.*canonical mutation root.*canonical-mutation\.lock/);
    expect(semanticProbe).not.toHaveBeenCalled();
  });

  it('fails closed when an existing historical mutation target is not effectively writable', () => {
    const f = fixture();
    const memories = path.join(f.canonical, 'memories.jsonl');
    const accessSync = vi.fn((target: fs.PathLike, mode?: number) => {
      if (path.resolve(String(target)) === path.resolve(memories) && mode === fs.constants.W_OK) {
        const error = Object.assign(new Error('synthetic ACL denial'), { code: 'EACCES' });
        throw error;
      }
      fs.accessSync(target, mode);
    });

    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { snapshotManifest: f.snapshot, statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env: f.env, accessSync },
    )).toThrow(/lacks effective write access.*memories\.jsonl/);
  });

  it('uses effective access rather than canonical file ownership so ACL grants remain valid', () => {
    const f = fixture();
    const batches = path.join(f.canonical, 'batches.jsonl');
    const accessSync = vi.fn(() => undefined);
    expect(() => assertCanonicalStoreWriterAccess(f.canonical, accessSync)).not.toThrow();
    expect(accessSync).toHaveBeenCalledWith(path.resolve(f.canonical), fs.constants.W_OK | fs.constants.X_OK);
    expect(accessSync).toHaveBeenCalledWith(batches, fs.constants.W_OK);
  });

  it('does not over-require write access to unrelated canonical-side ledgers', () => {
    const f = fixture();
    const unrelated = path.join(f.canonical, 'legacy-semantic-receipts.jsonl');
    fs.writeFileSync(unrelated, '{}\n');
    const accessSync = vi.fn((target: fs.PathLike, mode?: number) => {
      if (path.resolve(String(target)) === path.resolve(unrelated)) throw new Error('must not inspect unrelated ledger');
      fs.accessSync(target, mode);
    });
    expect(() => assertCanonicalStoreWriterAccess(f.canonical, accessSync)).not.toThrow();
  });

  it('keeps the privileged writer preflight before snapshot/API/agent resolution in the runner', () => {
    const runner = fs.readFileSync(path.resolve('scripts/relationship_memory_backfill.ts'), 'utf8');
    const preflight = runner.indexOf('assertPrivilegedSnapshotRuntimeSafety(');
    const snapshotResolve = runner.indexOf('resolveBackfillTranscriptInput(');
    const apiKey = runner.indexOf('process.env.LETTA_API_KEY');
    const agentResolve = runner.indexOf('getBackfillAgentId(');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(snapshotResolve).toBeGreaterThan(preflight);
    expect(apiKey).toBeGreaterThan(preflight);
    expect(agentResolve).toBeGreaterThan(preflight);
  });

  it('does not impose production-only guards on ordinary caller-owned transcript runs', () => {
    const f = fixture();
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env: {} },
    )).not.toThrow();
  });
});
