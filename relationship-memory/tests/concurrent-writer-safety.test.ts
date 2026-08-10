import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore, stableId } from '../src/store/index.js';

const childScript = path.resolve('relationship-memory/tests/concurrent-writer-child.ts');
const tsxCli = path.resolve('node_modules/.bin/tsx');
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-memory-concurrency-'));
  roots.push(root);
  return root;
}
function spawnChild(mode: string, root: string, id: string, startFile?: string, env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(tsxCli, [childScript, mode, root, id, startFile ?? ''], {
    cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function finish(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

afterEach(() => {
  delete process.env.RELATIONSHIP_MEMORY_LOCK_TIMEOUT_MS;
  delete process.env.RELATIONSHIP_MEMORY_LOCK_STALE_MS;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('cross-process canonical mutation boundary', () => {
  it('keeps JSONL well formed under two independent append writers', async () => {
    const root = tempRoot(); const start = path.join(root, 'start');
    const a = spawnChild('append', root, 'a', start); const b = spawnChild('append', root, 'b', start);
    fs.writeFileSync(start, 'go');
    const [ra, rb] = await Promise.all([finish(a), finish(b)]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const lines = fs.readFileSync(path.join(root, 'outcomes.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(200);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });

  it('re-checks remember dedupe inside the boundary', async () => {
    const root = tempRoot(); const start = path.join(root, 'start');
    const a = spawnChild('remember', root, 'batch-a', start); const b = spawnChild('remember', root, 'batch-b', start);
    fs.writeFileSync(start, 'go');
    const [ra, rb] = await Promise.all([finish(a), finish(b)]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const results = [JSON.parse(ra.stdout), JSON.parse(rb.stdout)];
    expect(results.map((r) => r.outcome).sort()).toEqual(['accepted', 'duplicate']);
    expect(new RelationshipMemoryStore(root, 'subject-test').listMemories()).toHaveLength(1);
  });

  it('keeps equivalent concurrent entity creation idempotent', async () => {
    const root = tempRoot(); const start = path.join(root, 'start');
    const a = spawnChild('entity', root, 'batch-a', start); const b = spawnChild('entity', root, 'batch-b', start);
    fs.writeFileSync(start, 'go');
    const [ra, rb] = await Promise.all([finish(a), finish(b)]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const results = [JSON.parse(ra.stdout), JSON.parse(rb.stdout)];
    expect(results.map((r) => r.outcome).sort()).toEqual(['accepted', 'duplicate']);
    expect(new RelationshipMemoryStore(root, 'subject-test').listEntities()).toHaveLength(1);
  });

  it('keeps equivalent concurrent reinforcement creation idempotent', async () => {
    const root = tempRoot(); const store = new RelationshipMemoryStore(root, 'subject-test');
    store.appendMemory({
      schema_version: 1, memory_id: 'mem-seed', subject_id: 'subject-test', kind: 'user_preference',
      summary: '用户喜欢拉面。', participants: ['user'], payload: { topic: '食物', preference: '喜欢拉面' },
      status: 'active', observed_at: '2026-08-10T00:00:00.000Z', created_at: '2026-08-10T00:00:00.000Z',
      source_key: 'seed-source', dedupe_key: stableId('dedupe', {
        subject_id: 'subject-test', kind: 'user_preference', summary: '用户喜欢拉面。', participants: ['user'],
        evidence_message_ids: ['seed-source-evidence'], payload: { topic: '食物', preference: '喜欢拉面' }, linked_memory_ids: [],
      }),
    } as any, [{
      evidence_id: 'seed-evidence', memory_id: 'mem-seed', conversation_id: 'conversation-test', message_id: 'seed-message',
      role: 'user', quote: '猫喜欢拉面', captured_at: '2026-08-10T00:00:00.000Z', source_evidence_id: 'seed-source-evidence',
    } as any]);
    const start = path.join(root, 'start');
    const a = spawnChild('reinforce', root, 'batch-a', start); const b = spawnChild('reinforce', root, 'batch-b', start);
    fs.writeFileSync(start, 'go');
    const [ra, rb] = await Promise.all([finish(a), finish(b)]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const results = [JSON.parse(ra.stdout), JSON.parse(rb.stdout)];
    expect(results.map((r) => r.outcome).sort()).toEqual(['accepted', 'duplicate']);
    expect(store.listReinforcements()).toHaveLength(1);
  });

  it('does not hold the canonical lock during simulated slow/model work before final local mutation', async () => {
    const root = tempRoot(); const marker = path.join(root, 'slow-started');
    const slow = spawnChild('delay-before-remember', root, 'slow-batch', marker);
    await waitForFile(marker);
    expect(fs.existsSync(path.join(root, '.canonical-mutation.lock'))).toBe(false);
    const store = new RelationshipMemoryStore(root, 'subject-test');
    store.appendOutcome({ batch_id: 'fast-batch', source_key: 'fast', outcome: 'retryable_failed', reason: 'probe', recorded_at: '2026-08-10T00:00:00.000Z' });
    expect(fs.existsSync(path.join(root, '.canonical-mutation.lock'))).toBe(false);
    expect((await finish(slow)).code).toBe(0);
  });

  it('surfaces lock contention as an explicit retryable failure', async () => {
    const root = tempRoot(); const ready = path.join(root, 'holder-ready');
    const holder = spawnChild('hold', root, 'holder', ready);
    await waitForFile(ready);
    const contender = spawnChild('contend', root, 'contender', undefined, { RELATIONSHIP_MEMORY_LOCK_TIMEOUT_MS: '50' });
    const result = await finish(contender);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.name).toBe('CanonicalMutationLockError');
    expect(parsed.retryable).toBe(true);
    expect(parsed.message).toContain('contention timed out');
    expect((await finish(holder)).code).toBe(0);
  });

  it('deterministically recovers a crashed same-host owner', () => {
    const root = tempRoot(); const lockDir = path.join(root, '.canonical-mutation.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 99999999, hostname: os.hostname(), token: 'dead-owner', acquired_at: '2026-08-10T00:00:00.000Z',
    }));
    const store = new RelationshipMemoryStore(root, 'subject-test');
    expect(() => store.appendOutcome({
      batch_id: 'recovered', source_key: 'recovered', outcome: 'retryable_failed', reason: 'recovered', recorded_at: '2026-08-10T00:00:00.000Z',
    })).not.toThrow();
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(store.listOutcomes()).toHaveLength(1);
  });
});
