import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendTrace, currentSnapshot, jstDay, liveKnownMemoryIds, readShadowSession, refreshSnapshot, shadowPaths, takeSyncPick, turnKey, updateShadowSession, withLaneLock } from './shadow_state.js';
import { previousTurn } from './turn_input.js';

const dirs: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-test-'));
  dirs.push(root);
  const live = path.join(root, 'store');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'memories.jsonl'), '{"memory_id":"m1"}\n');
  fs.mkdirSync(`${live}-semantic-index`);
  fs.writeFileSync(path.join(`${live}-semantic-index`, 'index.json'), '{"documents":{}}\n');
  return { live, paths: shadowPaths(live, {}) };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('snapshots', () => {
  it('copies the store, links an unchanged index, and keeps shadow writes out of the live store', () => {
    const { live, paths } = setup();
    expect(currentSnapshot(paths)).toBeUndefined();
    const first = refreshSnapshot(paths);
    expect(first.index).toBe('copied');
    fs.appendFileSync(path.join(first.storeDir, 'memories.jsonl'), '{"memory_id":"shadow"}\n');
    expect(fs.readFileSync(path.join(live, 'memories.jsonl'), 'utf8')).not.toContain('shadow');

    const second = refreshSnapshot(paths);
    expect(second.index).toBe('linked');
    expect(fs.statSync(second.indexFile).ino).toBe(fs.statSync(first.indexFile).ino);
    expect(fs.readFileSync(path.join(second.storeDir, 'memories.jsonl'), 'utf8')).not.toContain('shadow');
    expect(currentSnapshot(paths)?.gen).toBe(second.gen);

    fs.writeFileSync(path.join(`${live}-semantic-index`, 'index.json'), '{"documents":{"x":1}}\n');
    expect(refreshSnapshot(paths).index).toBe('copied');
  });

  it('removes old snapshots but keeps CURRENT', () => {
    const { paths } = setup();
    const first = refreshSnapshot(paths);
    const second = refreshSnapshot(paths, 0);
    expect(fs.existsSync(path.dirname(first.storeDir))).toBe(false);
    expect(fs.existsSync(second.storeDir)).toBe(true);
  });
});

describe('locks', () => {
  it('lets one worker per lane run and reports busy', async () => {
    const { paths } = setup();
    let inner: unknown;
    const outer = await withLaneLock(paths, 'async', async () => {
      inner = await withLaneLock(paths, 'async', async () => 'second');
      expect(await withLaneLock(paths, 'sync', async () => 'other lane')).toBe('other lane');
      return 'first';
    });
    expect(outer).toBe('first');
    expect(inner).toBe('busy');
    expect(await withLaneLock(paths, 'async', async () => 'again')).toBe('again');
  });

  it('takes over a stale lock', async () => {
    const { paths } = setup();
    fs.mkdirSync(path.join(paths.root, 'locks'), { recursive: true });
    const file = path.join(paths.root, 'locks', 'sync.lock');
    fs.writeFileSync(file, '{}');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    expect(await withLaneLock(paths, 'sync', async () => 'ran', 1_000)).toBe('ran');
  });
});

describe('session state', () => {
  it('joins the sync pick by turn key, ignoring spacing', async () => {
    const { paths } = setup();
    const key = turnKey('s1', '到家了  呀');
    expect(turnKey('s1', '到家了 呀\n')).toBe(key);
    await updateShadowSession(paths, 's1', (s) => { s.sync.push({ turn_key: key, at: new Date().toISOString(), memory_id: 'm7' }); });
    expect(await takeSyncPick(paths, 's1', key, 0)).toMatchObject({ join: 'key', pick: { memory_id: 'm7' } });
    expect((await takeSyncPick(paths, 's1', key, 0)).join).toBe('none');
  });

  it('falls back to the newest recent pick and waits for a running sync pass', async () => {
    const { paths } = setup();
    setTimeout(() => { void updateShadowSession(paths, 's2', (s) => { s.sync.push({ turn_key: 'other', at: new Date().toISOString() }); }); }, 100);
    expect((await takeSyncPick(paths, 's2', 'missing', 3_000)).join).toBe('recent');
  });

  it('keeps the last 3 passes and 20 sync picks', async () => {
    const { paths } = setup();
    for (let i = 0; i < 25; i++) {
      await updateShadowSession(paths, 's3', (s) => { s.sync.push({ turn_key: `k${i}`, at: '' }); s.passes.push({ at: '', seen: [] }); });
    }
    const session = readShadowSession(paths, 's3');
    expect(session.sync).toHaveLength(20);
    expect(session.passes).toHaveLength(3);
  });

  it('reads live known memories without failing on a missing or broken file', () => {
    const { paths } = setup();
    const file = path.join(paths.root, 'live.json');
    expect(liveKnownMemoryIds(file)).toEqual([]);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ deliveredMemoryIds: ['a', 'b'], sessionWrittenMemoryIds: ['b', 'c', ''] }));
    expect(liveKnownMemoryIds(file)).toEqual(['a', 'b', 'c']);
    fs.writeFileSync(file, '{broken');
    expect(liveKnownMemoryIds(file)).toEqual([]);
  });
});

describe('traces', () => {
  it('appends to the JST day file', () => {
    const { paths } = setup();
    appendTrace(paths, { lane: 'sync', skip: 'busy' });
    const file = path.join(paths.root, 'traces', `${jstDay()}.jsonl`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ lane: 'sync', skip: 'busy' });
    expect(jstDay(new Date('2026-11-27T15:30:00Z'))).toBe('2026-11-28');
  });
});

describe('previousTurn', () => {
  it('skips cache-warm turns and the new message already in the transcript', () => {
    const messages = [
      { role: 'user' as const, text: '今天去了海边' },
      { role: 'assistant' as const, text: '好玩吗' },
      { role: 'assistant' as const, text: '拍照了吗' },
      { role: 'user' as const, text: '🫳' },
      { role: 'assistant' as const, text: '🫳' },
      { role: 'user' as const, text: '到家了' },
    ];
    expect(previousTurn(messages, '到家了')).toEqual({ previousUserMessage: '今天去了海边', previousKohakuReply: '好玩吗\n拍照了吗' });
    expect(previousTurn(messages.slice(0, 5), '到家了').previousUserMessage).toBe('今天去了海边');
    expect(previousTurn([], '早')).toEqual({ previousUserMessage: '', previousKohakuReply: '' });
  });
});
