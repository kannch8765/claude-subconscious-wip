/**
 * Hook side of the shadow lanes (docs/specs/OWN-HARNESS-DESIGN.md §6.1). With SUBCON_SHADOW=1 a live hook
 * writes a payload file and spawns a detached, low-priority shadow worker (harness/shadow_<lane>.ts), then
 * goes on. This never throws: a failure is logged and the live path is unchanged.
 */
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getTempStateDir } from './conversation_utils.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Payload files older than this belong to a worker that never started; they hold conversation text. */
const STALE_PAYLOAD_MS = 60 * 60_000;

export type ShadowLane = 'sync' | 'async';

export function shadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUBCON_SHADOW === '1';
}

export function spawnShadowWorker(lane: ShadowLane, payload: object, cwd: string, log: (message: string) => void = () => {}): boolean {
  if (!shadowEnabled()) return false;
  try {
    const dir = path.join(getTempStateDir(), 'shadow');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (Date.now() - fs.statSync(file).mtimeMs > STALE_PAYLOAD_MS) fs.rmSync(file, { force: true }); } catch { /* taken meanwhile */ }
    }
    const payloadFile = path.join(dir, `${lane}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(payload), { mode: 0o600 });

    const workerDir = process.env.SUBCON_SHADOW_WORKER_DIR?.trim() || path.join(PLUGIN_ROOT, 'harness');
    const tsxCli = path.join(PLUGIN_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const command = [process.execPath, tsxCli, path.join(workerDir, `shadow_${lane}.ts`), payloadFile];
    const nice = process.platform !== 'win32' && fs.existsSync('/usr/bin/nice');
    const child = spawn(nice ? '/usr/bin/nice' : command[0], nice ? ['-n', '10', ...command] : command.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: process.env,
      windowsHide: true,
    });
    child.on('error', (error) => log(`shadow ${lane} worker failed to start: ${error.message}`));
    child.unref();
    log(`Spawned shadow ${lane} worker (PID: ${child.pid})`);
    return true;
  } catch (error) {
    log(`shadow ${lane} spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
