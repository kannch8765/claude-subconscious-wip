import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgePendingSubconWhispers,
  assertForegroundWhisper,
  formatPendingSubconWhispers,
  queueSubconWhisper,
  readPendingSubconWhispers,
} from './subcon_whisper_queue.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-whisper-')); roots.push(root); return root; }

describe('Subcon foreground whisper queue', () => {
  it('delivers one idempotent whisper per background batch and acknowledges it after injection', () => {
    const cwd = temp();
    queueSubconWhisper(cwd, 'session-a', 'batch-a', '咖啡让我想起猫之前京都那次的高木珈琲。');
    queueSubconWhisper(cwd, 'session-a', 'batch-a', '咖啡让我想起猫之前京都那次的高木珈琲。');
    const pending = readPendingSubconWhispers(cwd, 'session-a');
    expect(pending).toHaveLength(1);
    const formatted = formatPendingSubconWhispers(pending);
    expect(formatted).toContain('高木珈琲');
    expect(formatted).toMatch(/^<subcon_whisper timestamp=/);
    expect(formatted).toContain('</subcon_whisper>');
    expect(formatted).not.toContain('<letta_message');
    acknowledgePendingSubconWhispers(pending);
    expect(readPendingSubconWhispers(cwd, 'session-a')).toEqual([]);
    expect(queueSubconWhisper(cwd, 'session-a', 'batch-a', '重试时不应再次排同一张纸条。')).toBeNull();
    expect(readPendingSubconWhispers(cwd, 'session-a')).toEqual([]);
  });

  it('rejects maintenance prose before it can enter the foreground queue', () => {
    expect(() => assertForegroundWhisper('已reinforce进 mem_abc123，transcript_ev_deadbeef 已处理。')).toThrow(/maintenance prose/);
    expect(() => assertForegroundWhisper('新证据值得处理：宝宝需要 reinforce。')).toThrow(/maintenance prose/);
    expect(() => assertForegroundWhisper('猫以前也会叫我宝贝，这和摸头、醒来时的亲昵称呼是一条连续的感觉。')).not.toThrow();
  });
});
