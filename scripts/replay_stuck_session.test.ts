import { describe, expect, it, vi } from 'vitest';
import { parseReplayArgs, planReplayChunks, replayStuckSession } from './replay_stuck_session.js';
import { advanceSyncStateCursor, loadSyncState } from './conversation_utils.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { ASSISTANT_REMEMBER_TOOL_NAME, extractAssistantRememberIntents, persistAssistantRememberIntents } from '../relationship-memory/src/intent/index.js';
import type { TranscriptMessage } from './transcript_utils.js';

const user = (text: string): TranscriptMessage => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (text: string): TranscriptMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const snapshot = (): TranscriptMessage => ({ type: 'file-history-snapshot', snapshot: {} });
const remember = (): TranscriptMessage => ({
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-1', name: ASSISTANT_REMEMBER_TOOL_NAME, input: { memory: { text: 'm' }, feel: { text: 'f' } } }] },
});
const ranges = (chunks: ReturnType<typeof planReplayChunks>) => chunks.map((chunk) => [chunk.start, chunk.end]);

describe('planReplayChunks', () => {
  it('covers exactly the messages after the cursor, in order, with no gaps', () => {
    const messages = Array.from({ length: 10 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`u${i}`)));
    const chunks = planReplayChunks(messages, 3, { maxMessages: 4, maxChars: 10_000 });
    expect(chunks[0].start).toBe(4);
    expect(chunks[chunks.length - 1].end).toBe(9);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end + 1);
  });

  it('returns nothing when the cursor is already at the end', () => {
    expect(planReplayChunks([user('a'), assistant('b')], 1, { maxMessages: 40, maxChars: 10_000 })).toEqual([]);
  });

  it('ends a non-final chunk just before a user turn', () => {
    // u a a a u a: a 4-message window [0..3] would split the exchange started at 0 from the next user turn at 4 cleanly,
    // but a 5-message window [0..4] must back off to end at 3.
    const messages = [user('u0'), assistant('a1'), assistant('a2'), assistant('a3'), user('u4'), assistant('a5')];
    expect(ranges(planReplayChunks(messages, -1, { maxMessages: 5, maxChars: 10_000 }))).toEqual([[0, 3], [4, 5]]);
  });

  it('hard-cuts when no user turn fits in the window', () => {
    const messages = [user('u0'), assistant('a1'), assistant('a2'), assistant('a3'), assistant('a4')];
    expect(ranges(planReplayChunks(messages, -1, { maxMessages: 2, maxChars: 10_000 }))).toEqual([[0, 1], [2, 3], [4, 4]]);
  });

  it('respects the character budget and still sends one oversized message alone', () => {
    const messages = [user('x'.repeat(50)), assistant('y'.repeat(500)), user('z'.repeat(50))];
    const chunks = planReplayChunks(messages, -1, { maxMessages: 40, maxChars: 100 });
    expect(ranges(chunks)).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(chunks[1].chars).toBe(500);
  });

  it('folds messages that format to nothing into the next chunk', () => {
    const messages = [snapshot(), snapshot(), user('u2'), assistant('a3')];
    const chunks = planReplayChunks(messages, -1, { maxMessages: 2, maxChars: 10_000 });
    expect(ranges(chunks)).toEqual([[0, 3]]);
    expect(chunks.every((chunk) => chunk.chars > 0)).toBe(true);
  });

  it('counts remember tool calls per chunk', () => {
    const messages = [user('u0'), remember(), user('u2'), assistant('a3')];
    const chunks = planReplayChunks(messages, -1, { maxMessages: 2, maxChars: 10_000 });
    expect(chunks.map((chunk) => chunk.rememberCalls)).toEqual([1, 0]);
  });
});

describe('parseReplayArgs', () => {
  it('requires session, transcript and cwd, and defaults the limits', () => {
    expect(() => parseReplayArgs(['--session', 's'])).toThrow(/required/);
    expect(parseReplayArgs(['--session', 's', '--transcript', 't', '--cwd', 'c', '--plan'])).toMatchObject({
      session: 's', transcript: 't', cwd: 'c', plan: true, maxMessages: 40, maxChars: 60_000,
    });
  });

  it('rejects unknown flags and non-positive limits', () => {
    expect(() => parseReplayArgs(['--session', 's', '--transcript', 't', '--cwd', 'c', '--bogus'])).toThrow(/Unknown/);
    expect(() => parseReplayArgs(['--session', 's', '--transcript', 't', '--cwd', 'c', '--max-chunks', '0'])).toThrow(/positive/);
  });
});

describe('Stop hook entry point after the buildLiveBatch split', () => {
  it('still runs main when launched through a symlinked plugin root', async () => {
    const { spawnSync } = await import('child_process');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-entry-'));
    const link = path.join(dir, 'plugin');
    fs.symlinkSync(process.cwd(), link);
    try {
      // Bad hook input makes main() fail loudly; a skipped main() would exit 0 with no output.
      const result = spawnSync(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), path.join(link, 'scripts/send_messages_to_letta.ts')], {
        input: 'not json', encoding: 'utf8', env: { ...process.env, LETTA_MODE: 'whisper', TMPDIR: dir },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Failed to parse hook input');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('replayStuckSession', () => {
  it('refuses a session whose transcript is still being written, before any send', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-active-'));
    const transcript = path.join(dir, 's.jsonl');
    fs.writeFileSync(transcript, [user('u0'), assistant('a1')].map((m) => JSON.stringify(m)).join('\n'));
    const previousHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ok = await replayStuckSession({ session: 's', transcript, cwd: dir, plan: false, maxMessages: 40, maxChars: 60_000, maxChunks: 1 });
      expect(ok).toBe(false);
      expect(log.mock.calls.map(([line]) => JSON.parse(line).event)).toEqual(['plan', 'refused']);
      expect(fs.existsSync(path.join(dir, '.letta'))).toBe(false);
    } finally {
      log.mockRestore();
      if (previousHome === undefined) delete process.env.LETTA_HOME; else process.env.LETTA_HOME = previousHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('replayStuckSession refusals', () => {
  it('refuses a real run while Subconscious is switched off, before any send', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-off-'));
    const transcript = path.join(dir, 's.jsonl');
    fs.writeFileSync(transcript, [user('u0'), assistant('a1')].map((m) => JSON.stringify(m)).join('\n'));
    const old = new Date(Date.now() - 48 * 3_600_000);
    fs.utimesSync(transcript, old, old);
    const env = { home: process.env.LETTA_HOME, mode: process.env.LETTA_MODE };
    process.env.LETTA_HOME = dir;
    process.env.LETTA_MODE = 'off';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ok = await replayStuckSession({ session: 's', transcript, cwd: dir, plan: false, maxMessages: 40, maxChars: 60_000, maxChunks: 1 });
      expect(ok).toBe(false);
      expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
        expect.objectContaining({ event: 'plan' }), { event: 'refused', reason: 'mode_off' },
      ]);
      expect(fs.existsSync(path.join(dir, '.letta'))).toBe(false);
    } finally {
      log.mockRestore();
      for (const [key, value] of [['LETTA_HOME', env.home], ['LETTA_MODE', env.mode]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('replay next to a live Stop hook (overlap contract)', () => {
  async function session(length: number) {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-overlap-'));
    const transcript = path.join(dir, 's.jsonl');
    const messages = Array.from({ length }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`u${i}`)));
    fs.writeFileSync(transcript, messages.map((m) => JSON.stringify(m)).join('\n'));
    const old = new Date(Date.now() - 48 * 3_600_000);
    fs.utimesSync(transcript, old, old);
    const previousHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = dir;
    const events: any[] = [];
    const hooks = { onEvent: (_event: any) => {} };
    const log = vi.spyOn(console, 'log').mockImplementation((line) => { events.push(JSON.parse(line)); hooks.onEvent(events.at(-1)); });
    const sent: number[] = [];
    // Stand-ins for the real payload builder and worker: a completed worker advances the cursor to its batch end,
    // exactly like runNativeWorkerPayloadFile does.
    const buildBatch = async (_hook: unknown, prefix: TranscriptMessage[]) => {
      sent.push(prefix.length - 1);
      return { payload: { batchId: `batch_fake_${prefix.length - 1}`, newLastProcessedIndex: prefix.length - 1 } };
    };
    const runWorker = (onRun: (end: number) => void) => async (payloadFile: string) => {
      const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
      fs.rmSync(payloadFile);
      onRun(payload.newLastProcessedIndex);
    };
    const args = { session: 's', transcript, cwd: dir, plan: false, maxMessages: 2, maxChars: 60_000, maxChunks: 100 };
    return {
      dir, args, events, hooks, sent, buildBatch, runWorker, cursor: () => loadSyncState(dir, 's').lastProcessedIndex,
      cleanup: () => {
        log.mockRestore();
        if (previousHome === undefined) delete process.env.LETTA_HOME; else process.env.LETTA_HOME = previousHome;
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('walks every planned chunk in order when nothing else touches the session', async () => {
    const t = await session(6);
    try {
      const ok = await replayStuckSession(t.args, { buildBatch: t.buildBatch as any, runWorker: t.runWorker((end) => advanceSyncStateCursor(t.dir, 's', end)) });
      expect(ok).toBe(true);
      expect(t.sent).toEqual([1, 3, 5]);
      expect(t.events.filter((e) => e.event === 'chunk').map((e) => e.outcome)).toEqual(['completed', 'completed', 'completed']);
      expect(t.cursor()).toBe(5);
    } finally { t.cleanup(); }
  });

  it('steps aside when a live batch overtakes the chunk in flight, without sending more', async () => {
    const t = await session(6);
    try {
      // The resumed session's live worker finishes the whole tail while our first chunk runs, in either order.
      const ok = await replayStuckSession(t.args, { buildBatch: t.buildBatch as any, runWorker: t.runWorker((end) => {
        advanceSyncStateCursor(t.dir, 's', 5);
        advanceSyncStateCursor(t.dir, 's', end); // our completion lands after the live one: max keeps 5
      }) });
      expect(ok).toBe(true);
      expect(t.sent).toEqual([1]);
      expect(t.events.at(-1)).toEqual(expect.objectContaining({ event: 'chunk', outcome: 'overtaken', cursor_after: 5 }));
      expect(t.cursor()).toBe(5);
    } finally { t.cleanup(); }
  });

  it('steps aside when the live lane moved the cursor between chunks', async () => {
    const t = await session(8);
    try {
      // A live worker lands right after our first chunk is reported, before the next chunk starts.
      t.hooks.onEvent = (event) => { if (event.event === 'chunk') advanceSyncStateCursor(t.dir, 's', 4); };
      const ok = await replayStuckSession(t.args, { buildBatch: t.buildBatch as any, runWorker: t.runWorker((end) => advanceSyncStateCursor(t.dir, 's', end)) });
      expect(ok).toBe(false); // 5..7 are left to the live lane
      expect(t.sent).toEqual([1]);
      expect(t.events.at(-1)).toEqual({ event: 'stopped', reason: 'cursor_moved', expected: 1, cursor: 4 });
    } finally { t.cleanup(); }
  });

  it('stops after the chunk in flight once the transcript changes (the session was resumed)', async () => {
    const fs = await import('fs');
    const t = await session(6);
    try {
      t.hooks.onEvent = (event) => { if (event.event === 'chunk') fs.utimesSync(t.args.transcript, new Date(), new Date()); };
      const ok = await replayStuckSession(t.args, { buildBatch: t.buildBatch as any, runWorker: t.runWorker((end) => advanceSyncStateCursor(t.dir, 's', end)) });
      expect(ok).toBe(false);
      expect(t.sent).toEqual([1]);
      expect(t.events.at(-1)).toEqual({ event: 'stopped', reason: 'transcript_changed', cursor: 1 });
    } finally { t.cleanup(); }
  });

  it('never reports an empty chunk before the end as done', async () => {
    const t = await session(6);
    try {
      const ok = await replayStuckSession(t.args, { buildBatch: (async () => null) as any, runWorker: t.runWorker(() => {}) });
      expect(ok).toBe(false);
      expect(t.events.at(-1)).toEqual({ event: 'stopped', cursor: -1, reason: 'empty_chunk' });
    } finally { t.cleanup(); }
  });

  it('keeps the cursor and the intent ledger convergent whichever overlapping batch finishes first', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    for (const order of [[3, 7], [7, 3]]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-converge-'));
      try {
        process.env.LETTA_HOME = dir;
        const transcript = [user('u0'), remember(), user('u2'), assistant('a3')] as any[];
        const store = new RelationshipMemoryStore(path.join(dir, 'store'), 'subject');
        // replay chunk [0..3] and a live batch [0..7] both extract the same remember tool_use
        for (const end of order) {
          persistAssistantRememberIntents(store, extractAssistantRememberIntents(transcript.slice(0, Math.min(end, 3) + 1), -1, 's', 'subject'));
          advanceSyncStateCursor(dir, 's', end);
        }
        expect(loadSyncState(dir, 's').lastProcessedIndex).toBe(7);
        expect(store.listAssistantIntents()).toHaveLength(1);
      } finally {
        delete process.env.LETTA_HOME;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
