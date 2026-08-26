import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveForegroundSyncIdentity, runForegroundSyncForHook } from './foreground_sync_hook.js';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.SUBCON_FOREGROUND_SYNC_MODE;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-sync-hook-'));
  dirs.push(dir);
  return dir;
}

it('uses the exact current transcript user UUID as the sync turn identity', () => {
  const cwd = temp();
  const transcript = path.join(cwd, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'u-old', message: { content: [{ type: 'text', text: '一样' }] } },
    { type: 'assistant', uuid: 'a-old', message: { content: [{ type: 'text', text: 'old' }] } },
    { type: 'user', uuid: 'u-new', message: { content: [{ type: 'text', text: '一样' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  expect(resolveForegroundSyncIdentity({ session_id: 's', cwd, prompt: '一样', transcript_path: transcript }, 'nonce'))
    .toEqual({ turn_id: 'u-new', message_id: 'u-new' });
});

it('falls back to an unbound unique turn instead of guessing when exact transcript identity is unavailable', () => {
  const a = resolveForegroundSyncIdentity({ session_id: 's', prompt: 'hello', transcript_path: '/missing' }, 'nonce-a');
  const b = resolveForegroundSyncIdentity({ session_id: 's', prompt: 'hello', transcript_path: '/missing' }, 'nonce-b');
  expect(a.message_id).toBeUndefined();
  expect(a.turn_id).toMatch(/^fg_turn_/);
  expect(b.turn_id).not.toBe(a.turn_id);
});

describe('foreground sync hook gating', () => {
  it('is disabled by default and does not call the blocking runner', async () => {
    let called = false;
    const result = await runForegroundSyncForHook({ session_id: 's', prompt: 'hi' }, temp(), async () => {
      called = true;
      return { status: 'no_whisper' };
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('passes exact identity, transcript path, and bounded timeout to v2 sync and returns timings', async () => {
    process.env.SUBCON_FOREGROUND_SYNC_MODE = 'v2';
    const cwd = temp();
    const transcript = path.join(cwd, 't.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u-1', message: { content: [{ type: 'text', text: '猫来了' }] } }) + '\n');
    const result = await runForegroundSyncForHook({
      session_id: 's', cwd, prompt: '猫来了', context: 'bounded context', transcript_path: transcript, hook_event_name: 'UserPromptSubmit',
    }, cwd, async (input) => {
      expect(input.turn_id).toBe('u-1');
      expect(input.transcript_path).toBe(transcript);
      expect(input.context).toBe('bounded context');
      expect(input.timeout_ms).toBe(30_000);
      expect(input.sync_started_at_ms).toBeGreaterThan(0);
      return { status: 'no_whisper', bundle_ready_ms: 140, resolve_recall_ms: 1900, foreground_release_ms: 1910 };
    }, 99_000);
    expect(result).toMatchObject({
      status: 'no_whisper', turn_id: 'u-1', message_id: 'u-1', bundle_ready_ms: 140, resolve_recall_ms: 1900, foreground_release_ms: 1910,
    });
  });

  it('fails open when the v2 runner throws', async () => {
    process.env.SUBCON_FOREGROUND_SYNC_MODE = 'v2';
    const result = await runForegroundSyncForHook({ session_id: 's', prompt: 'hi', hook_event_name: 'UserPromptSubmit' }, temp(), async () => {
      throw new Error('provider exploded');
    });
    expect(result?.status).toBe('failed');
    expect(result?.error).toContain('provider exploded');
  });
});
