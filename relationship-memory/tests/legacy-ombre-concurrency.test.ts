import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyMemorySourceStore, buildLegacyManifest, loadLegacyImportState } from '../src/legacy/index.js';

const childScript = path.resolve('relationship-memory/tests/legacy-ombre-concurrency-child.ts');
const tsxCli = path.resolve('node_modules/.bin/tsx');
const roots: string[] = [];

function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-093x-concurrency-')); roots.push(root); return root; }
function bucket(root: string, relative: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = path.basename(relative, '.md');
  fs.writeFileSync(file, `---\nid: ${id}\nname: 并发测试\ntype: memory\ncreated: 2026-07-01T01:02:03\nlast_active: 2026-07-02T04:05:06\ndomain: [关系]\ntags: [琥珀, 猫]\nimportance: 8\nvalence: 0.7\narousal: 0.4\nactivation_count: 1.5\n---\n历史记忆。\n`, 'utf8');
}
function spawnChild(mode: string, sourceRoot: string, storeDir: string, startFile: string): ChildProcessWithoutNullStreams {
  return spawn(tsxCli, [childScript, mode, sourceRoot, storeDir, startFile], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function finish(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('Task 093X legacy writer concurrency', () => {
  it('serializes racing deterministic source and provenance writes without duplicate rows', async () => {
    const root = temp(); const sourceRoot = path.join(root, 'ombre'); const storeDir = path.join(root, 'store'); const start = path.join(root, 'start');
    bucket(sourceRoot, 'dynamic/1.md');
    const a = spawnChild('provenance', sourceRoot, storeDir, start); const b = spawnChild('provenance', sourceRoot, storeDir, start);
    fs.writeFileSync(start, 'go');
    const [ra, rb] = await Promise.all([finish(a), finish(b)]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const store = new LegacyMemorySourceStore(storeDir);
    expect(store.listSources()).toHaveLength(1);
    expect(store.listProvenance()).toHaveLength(1);
    expect(new Set([JSON.parse(ra.stdout).provenanceId, JSON.parse(rb.stdout).provenanceId]).size).toBe(1);
  });

  it('merges manifest-bound resume progress from concurrent bounded importers', async () => {
    const root = temp(); const sourceRoot = path.join(root, 'ombre'); const storeDir = path.join(root, 'store'); const start = path.join(root, 'start');
    bucket(sourceRoot, 'dynamic/1.md'); bucket(sourceRoot, 'dynamic/2.md');
    const one = spawnChild('import-one', sourceRoot, storeDir, start); const two = spawnChild('import-two', sourceRoot, storeDir, start);
    fs.writeFileSync(start, 'go');
    const [r1, r2] = await Promise.all([finish(one), finish(two)]);
    expect([r1.code, r2.code]).toEqual([0, 0]);
    const manifest = buildLegacyManifest(sourceRoot);
    const state = loadLegacyImportState(path.join(storeDir, 'legacy-import-state.json'), manifest.manifest_digest);
    expect(state.processed_paths).toEqual(['dynamic/1.md', 'dynamic/2.md']);
    const store = new LegacyMemorySourceStore(storeDir);
    expect(store.listSources()).toHaveLength(2);
    expect(new Set(store.listReceipts().map((item) => item.relative_path))).toEqual(new Set(['dynamic/1.md', 'dynamic/2.md']));
  });
});
