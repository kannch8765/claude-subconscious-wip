import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPrivilegedSnapshotRuntimeSafety } from './backfill_runtime_safety.js';

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

  it('does not impose production-only guards on ordinary caller-owned transcript runs', () => {
    const f = fixture();
    expect(() => assertPrivilegedSnapshotRuntimeSafety(
      { statePath: f.state, rootDir: f.canonical },
      { privilegedSnapshotRoot: f.privileged, currentUid: f.uid, env: {} },
    )).not.toThrow();
  });
});
