import { describe, expect, it, vi } from 'vitest';
import { parseReplayArgs, planReplayChunks, replayStuckSession } from './replay_stuck_session.js';
import { acquireReplayLease, getReplayLeaseDir, replayLeaseHolder } from './conversation_utils.js';
import { ASSISTANT_REMEMBER_TOOL_NAME } from '../relationship-memory/src/intent/index.js';
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
      expect(fs.readdirSync(path.join(dir, '.letta', 'claude'))).toEqual([]); // lease released, no session state
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

describe('session replay lease', () => {
  async function scratch() {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-lease-'));
    const previousHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = dir;
    return {
      fs, path, dir,
      cleanup: () => {
        if (previousHome === undefined) delete process.env.LETTA_HOME; else process.env.LETTA_HOME = previousHome;
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('is exclusive while its owner lives, released by its owner, and replaced when the owner died', async () => {
    const { fs, path, dir, cleanup } = await scratch();
    try {
      expect(replayLeaseHolder(dir, 's')).toBeNull();
      const release = acquireReplayLease(dir, 's');
      expect(replayLeaseHolder(dir, 's')).toBe(process.pid);
      expect(() => acquireReplayLease(dir, 's')).toThrow(/held by live process/);
      release();
      expect(replayLeaseHolder(dir, 's')).toBeNull();

      const leaseDir = getReplayLeaseDir(dir, 's');
      fs.mkdirSync(leaseDir, { recursive: true });
      fs.writeFileSync(path.join(leaseDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', createdAt: new Date().toISOString() }));
      expect(replayLeaseHolder(dir, 's')).toBeNull();
      acquireReplayLease(dir, 's')();
      expect(fs.existsSync(leaseDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('makes a real replay refuse while another replay holds the session', async () => {
    const { fs, path, dir, cleanup } = await scratch();
    const transcript = path.join(dir, 's.jsonl');
    fs.writeFileSync(transcript, [user('u0'), assistant('a1')].map((m) => JSON.stringify(m)).join('\n'));
    const release = acquireReplayLease(dir, 's');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await replayStuckSession({ session: 's', transcript, cwd: dir, plan: false, maxMessages: 40, maxChars: 60_000, maxChunks: 1 })).toBe(false);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ event: 'refused', reason: 'replay_in_progress' });
      expect(replayLeaseHolder(dir, 's')).toBe(process.pid); // the other holder's lease is untouched
    } finally {
      log.mockRestore();
      release();
      cleanup();
    }
  });

  it('makes the Stop hook send nothing for a leased session', async () => {
    const { fs, path, dir, cleanup } = await scratch();
    const { spawnSync } = await import('child_process');
    const release = acquireReplayLease(dir, 'leased-session');
    try {
      const transcript = path.join(dir, 't.jsonl');
      fs.writeFileSync(transcript, [user('u0'), assistant('a1')].map((m) => JSON.stringify(m)).join('\n'));
      const result = spawnSync(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), path.join(process.cwd(), 'scripts/send_messages_to_letta.ts')], {
        input: JSON.stringify({ session_id: 'leased-session', transcript_path: transcript, cwd: dir }),
        encoding: 'utf8', env: { ...process.env, LETTA_MODE: 'whisper', LETTA_HOME: dir, TMPDIR: dir, LETTA_API_KEY: '' },
      });
      expect(result.status).toBe(0);
      const tempState = fs.readdirSync(dir).find((name) => name.startsWith('letta-claude-sync-'))!;
      const files = fs.readdirSync(path.join(dir, tempState));
      expect(files.some((name) => name.startsWith('payload-'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, tempState, 'send_messages.log'), 'utf8')).toContain('Replay in progress for this session');
      expect(fs.existsSync(path.join(dir, '.letta', 'claude', 'session-leased-session.json'))).toBe(false); // cursor untouched
    } finally {
      release();
      cleanup();
    }
  }, 30_000);
});
