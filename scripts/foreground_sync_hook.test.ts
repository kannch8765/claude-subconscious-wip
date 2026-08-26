import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foregroundSyncV2Enabled, resolveForegroundSyncIdentity, runForegroundSyncForHook, runSyncSubconCli } from './foreground_sync_hook.js';
import { listPendingForegroundRecallTurns } from './foreground_recall_state.js';

const dirs: string[] = [];
beforeEach(() => {
  delete process.env.SUBCON_FOREGROUND_SYNC_MODE;
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_MODE;
  delete process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER;
});
afterEach(() => {
  delete process.env.SUBCON_FOREGROUND_SYNC_MODE;
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_MODE;
  delete process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-sync-hook-'));
  dirs.push(dir);
  return dir;
}

it('always uses an opaque foreground turn identity even when an identical transcript UUID is visible', () => {
  const cwd = temp();
  const transcript = path.join(cwd, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'u-old', message: { content: [{ type: 'text', text: '一样' }] } },
    { type: 'assistant', uuid: 'a-old', message: { content: [{ type: 'text', text: 'old' }] } },
    { type: 'user', uuid: 'u-new', message: { content: [{ type: 'text', text: '一样' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const identity = resolveForegroundSyncIdentity({ session_id: 's', cwd, prompt: '一样', transcript_path: transcript }, 'nonce');
  expect(identity.turn_id).toMatch(/^fg_turn_/);
  expect(identity.turn_id).not.toBe('u-old');
  expect(identity.turn_id).not.toBe('u-new');
});

it('does not bind the previous identical prompt when the current user record has not reached the transcript yet', () => {
  const cwd = temp();
  const transcript = path.join(cwd, 'lagged.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'u-prev', message: { content: [{ type: 'text', text: '一样的问题' }] } },
    { type: 'assistant', uuid: 'a-prev', message: { content: [{ type: 'text', text: '上一轮回答' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const identity = resolveForegroundSyncIdentity({ session_id: 's', cwd, prompt: '一样的问题', transcript_path: transcript }, 'lagged-nonce');
  expect(identity).toEqual({ turn_id: expect.stringMatching(/^fg_turn_/) });
  expect(identity.turn_id).not.toBe('u-prev');
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
      expect(input.turn_id).toMatch(/^fg_turn_/);
      expect(input.transcript_path).toBe(transcript);
      expect(input.context).toBe('bounded context');
      expect(input.timeout_ms).toBe(30_000);
      expect(input.sync_started_at_ms).toBeGreaterThan(0);
      return { status: 'no_whisper', bundle_ready_ms: 140, resolve_recall_ms: 1900, foreground_release_ms: 1910 };
    }, 99_000);
    expect(result).toMatchObject({
      status: 'no_whisper', turn_id: expect.stringMatching(/^fg_turn_/), bundle_ready_ms: 140, resolve_recall_ms: 1900, foreground_release_ms: 1910,
    });
    expect(listPendingForegroundRecallTurns(cwd, 's')).toEqual([expect.objectContaining({
      turn_id: result!.turn_id, transcript_anchor: { tail_role: 'user', last_user_message_id: 'u-1' },
    })]);
  });

  it('accepts only the literal v2 gate value', async () => {
    const cwd = temp();
    for (const value of ['on', '1', 'true']) {
      process.env.SUBCON_FOREGROUND_SYNC_MODE = value;
      expect(foregroundSyncV2Enabled()).toBe(false);
      let called = false;
      const result = await runForegroundSyncForHook({ session_id: 's', prompt: 'hi', hook_event_name: 'UserPromptSubmit' }, cwd, async () => {
        called = true;
        return { status: 'no_whisper' };
      });
      expect(result).toBeNull();
      expect(called).toBe(false);
    }
    process.env.SUBCON_FOREGROUND_SYNC_MODE = 'v2';
    expect(foregroundSyncV2Enabled()).toBe(true);
    delete process.env.SUBCON_FOREGROUND_SYNC_MODE;
    process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_MODE = 'shadow';
    expect(foregroundSyncV2Enabled()).toBe(false);
  });

  it('refuses v2 when legacy shadow or rerank configuration is still enabled', async () => {
    process.env.SUBCON_FOREGROUND_SYNC_MODE = 'v2';
    process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_MODE = 'shadow';
    process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER = 'dashscope-qwen';
    let called = false;
    const cwd = temp();
    const result = await runForegroundSyncForHook({ session_id: 's', prompt: 'hi', hook_event_name: 'UserPromptSubmit' }, cwd, async () => {
      called = true;
      return { status: 'no_whisper' };
    });
    expect(called).toBe(false);
    expect(result?.status).toBe('failed');
    expect(result?.error).toContain('legacy sync-recall mode');
    expect(listPendingForegroundRecallTurns(cwd, 's')).toEqual([]);

    delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_MODE;
    process.env.RELATIONSHIP_MEMORY_RERANK_PROVIDER = 'dashscope-qwen';
    const rerankOnly = await runForegroundSyncForHook({ session_id: 's', prompt: 'hi', hook_event_name: 'UserPromptSubmit' }, cwd, async () => ({ status: 'no_whisper' }));
    expect(rerankOnly?.status).toBe('failed');
    expect(rerankOnly?.error).toContain('legacy rerank provider');
  });

  it('waits for SIGTERM cleanup before an outer hard timeout releases foreground', async () => {
    const cwd = temp();
    const markerFile = path.join(cwd, 'term-cleanup-done');
    let childPid = 0;
    const fixture = [
      "const fs=require('fs')",
      `const marker=${JSON.stringify(markerFile)}`,
      "process.on('SIGTERM',()=>{fs.writeFileSync(marker,'term');setTimeout(()=>process.exit(0),120)})",
      "setInterval(()=>{},1000)",
    ].join(';');
    const started = Date.now();
    const result = await runSyncSubconCli({
      session_id: 's', turn_id: 'fg-timeout', cwd, prompt: 'timeout', timeout_ms: 250, sync_started_at_ms: Date.now(),
    }, {
      hardTimeoutMs: 180, killGraceMs: 500, finalGraceMs: 100,
      spawnChild: ((_command: string, _args: readonly string[], options: any) => {
        const child = spawn(process.execPath, ['-e', fixture], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        childPid = child.pid ?? 0;
        return child;
      }) as any,
    });
    expect(result.status).toBe('timeout');
    expect(fs.readFileSync(markerFile, 'utf8')).toBe('term');
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('kills the whole sync process group if graceful timeout cleanup itself hangs', async () => {
    if (process.platform === 'win32') return;
    const cwd = temp();
    const descendantFile = path.join(cwd, 'descendant-pid');
    let wrapperPid = 0;
    const fixture = [
      "const fs=require('fs'),cp=require('child_process')",
      `const f=${JSON.stringify(descendantFile)}`,
      "const d=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "fs.writeFileSync(f,String(d.pid))",
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(';');
    const result = await runSyncSubconCli({
      session_id: 's', turn_id: 'fg-kill-tree', cwd, prompt: 'timeout', timeout_ms: 250, sync_started_at_ms: Date.now(),
    }, {
      hardTimeoutMs: 180, killGraceMs: 180, finalGraceMs: 120,
      spawnChild: ((_command: string, _args: readonly string[], options: any) => {
        const child = spawn(process.execPath, ['-e', fixture], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        wrapperPid = child.pid ?? 0;
        return child;
      }) as any,
    });
    expect(result.status).toBe('timeout');
    const descendantPid = Number(fs.readFileSync(descendantFile, 'utf8'));
    expect(() => process.kill(wrapperPid, 0)).toThrow();
    expect(() => process.kill(descendantPid, 0)).toThrow();
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
