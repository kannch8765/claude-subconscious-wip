import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTempStateDir } from './conversation_utils.js';
import { shadowEnabled, spawnShadowWorker } from './subcon_shadow.js';

const saved = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
  process.env = { ...saved };
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkers(): { dir: string; marker: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-worker-'));
  dirs.push(dir);
  const marker = path.join(dir, 'ran.json');
  for (const lane of ['sync', 'async']) {
    fs.writeFileSync(path.join(dir, `shadow_${lane}.ts`), `import * as fs from 'fs';\nconst file = process.argv[2];\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ lane: '${lane}', mode: (fs.statSync(file).mode & 0o777).toString(8), payload: JSON.parse(fs.readFileSync(file, 'utf8')) }));\nfs.rmSync(file);\n`);
  }
  return { dir, marker };
}

async function waitFor(file: string, ms = 10_000): Promise<any> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* still writing */ } }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('worker did not run');
}

describe('shadow spawn', () => {
  it('does nothing unless SUBCON_SHADOW=1', () => {
    delete process.env.SUBCON_SHADOW;
    expect(shadowEnabled()).toBe(false);
    expect(spawnShadowWorker('sync', { x: 1 }, os.tmpdir())).toBe(false);
    process.env.SUBCON_SHADOW = 'true';
    expect(shadowEnabled()).toBe(false);
  });

  it('writes a private payload file and starts the lane worker detached', async () => {
    const { dir, marker } = fakeWorkers();
    process.env.SUBCON_SHADOW = '1';
    process.env.SUBCON_SHADOW_WORKER_DIR = dir;
    expect(spawnShadowWorker('async', { sessionId: 's1' }, dir)).toBe(true);
    expect(await waitFor(marker)).toEqual({ lane: 'async', mode: '600', payload: { sessionId: 's1' } });
  });

  it('removes stale payload files and never throws', () => {
    process.env.SUBCON_SHADOW = '1';
    process.env.SUBCON_SHADOW_WORKER_DIR = path.join(os.tmpdir(), 'no-such-shadow-workers');
    const dir = path.join(getTempStateDir(), 'shadow');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'sync-stale-test.json');
    fs.writeFileSync(stale, '{}');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(stale, old, old);
    const before = new Set(fs.readdirSync(dir));
    expect(() => spawnShadowWorker('sync', {}, '/no/such/cwd')).not.toThrow();
    expect(fs.existsSync(stale)).toBe(false);
    for (const name of fs.readdirSync(dir)) if (!before.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  });

  it('is called by the hooks after their live work is set up', () => {
    const stop = fs.readFileSync(path.join(process.cwd(), 'scripts/send_messages_to_letta.ts'), 'utf8');
    expect(stop.indexOf("spawnShadowWorker('async'")).toBeGreaterThan(stop.indexOf('spawnSilentWorker(workerScript'));
    const prompt = fs.readFileSync(path.join(process.cwd(), 'scripts/sync_letta_memory.ts'), 'utf8');
    expect(prompt).toContain("spawnShadowWorker('sync'");
  });
});
