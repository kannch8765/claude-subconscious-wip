import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishMaintenanceQueueJob } from './maintenance_queue.js';
import {
  contextualForegroundRecallQuery,
  readForegroundRecentTranscript,
  renderForegroundRecentTranscript,
} from './foreground_recent_context.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function msg(type: 'user' | 'assistant', uuid: string, text: string, timestamp: string) {
  return { type, uuid, timestamp, message: { content: [{ type: 'text', text }] } };
}

describe('foreground recent transcript context', () => {
  it('uses queued/in-flight immutable transcript slices when no live transcript path is available', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-queue-'));
    dirs.push(cwd);
    publishMaintenanceQueueJob(cwd, {
      schema_version: 1,
      job_id: 'job-a', session_id: 'session-a', start_index: -1, through_index: 1,
      created_at: '2026-08-26T00:00:00.000Z',
      payload: {} as any,
      transcript_messages: [
        msg('user', 'u-1', '刚刚在讨论 amber-lantern-4907 这个变量名。', '2026-08-26T00:00:00.000Z'),
        msg('assistant', 'a-1', '对，这是当前 TypeScript fixture 的变量。', '2026-08-26T00:00:01.000Z'),
      ],
    });

    const recent = readForegroundRecentTranscript(cwd, 'session-a', '对咪，就是这个><');
    expect(recent.map((item) => item.message_id)).toEqual(['u-1', 'a-1']);
    const query = contextualForegroundRecallQuery('对咪，就是这个><', recent);
    expect(query).toContain('对咪，就是这个><');
    expect(query).toContain('amber-lantern-4907');
    expect(query).toContain('当前 TypeScript fixture');
  });

  it('uses the existing bounded foreground context as a broker fallback when structured recent messages are unavailable', () => {
    const query = contextualForegroundRecallQuery('然后呢><', [], '上一轮正在讨论 café-bridge-77 的部署状态。');
    expect(query).toContain('然后呢><');
    expect(query).toContain('café-bridge-77');
  });

  it('prefers the real transcript tail so a just-finished turn is visible even before Stop publishes its job', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-transcript-'));
    dirs.push(cwd);
    publishMaintenanceQueueJob(cwd, {
      schema_version: 1,
      job_id: 'old-job', session_id: 'session-a', start_index: -1, through_index: 1,
      created_at: '2026-08-26T00:00:00.000Z', payload: {} as any,
      transcript_messages: [
        msg('user', 'u-old', '更早的 queued turn', '2026-08-25T23:59:00.000Z'),
        msg('assistant', 'a-old', '更早的回答', '2026-08-25T23:59:01.000Z'),
      ],
    });
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(transcript, [
      msg('user', 'u-old', '更早的 queued turn', '2026-08-25T23:59:00.000Z'),
      msg('assistant', 'a-old', '更早的回答', '2026-08-25T23:59:01.000Z'),
      msg('user', 'u-fresh', '刚刚那轮还没来得及进 maintenance queue。', '2026-08-26T00:00:00.000Z'),
      msg('assistant', 'a-fresh', '但真实 transcript 已经有这条回答。', '2026-08-26T00:00:01.000Z'),
      msg('user', 'u-current', '然后呢><', '2026-08-26T00:00:02.000Z'),
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');

    const recent = readForegroundRecentTranscript(cwd, 'session-a', '然后呢><', transcript);
    expect(recent.map((item) => item.message_id)).toEqual(['u-old', 'a-old', 'u-fresh', 'a-fresh']);
    expect(recent.some((item) => item.message_id === 'u-current')).toBe(false);
    expect(recent.some((item) => item.text.includes('还没来得及进 maintenance queue'))).toBe(true);
  });

  it('keeps the previous identical prompt when the current user record is not in the transcript yet', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-identical-lag-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'lagged.jsonl');
    fs.writeFileSync(transcript, [
      msg('user', 'u-prev', '一样的问题', '2026-08-26T00:00:00.000Z'),
      msg('assistant', 'a-prev', '上一轮回答', '2026-08-26T00:00:01.000Z'),
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    const recent = readForegroundRecentTranscript(cwd, 'session-a', '一样的问题', transcript);
    expect(recent.map((item) => item.message_id)).toEqual(['u-prev', 'a-prev']);
  });

  it('removes only the appended current duplicate and keeps the previous identical turn', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-identical-appended-'));
    dirs.push(cwd);
    const transcript = path.join(cwd, 'appended.jsonl');
    fs.writeFileSync(transcript, [
      msg('user', 'u-prev', '一样的问题', '2026-08-26T00:00:00.000Z'),
      msg('assistant', 'a-prev', '上一轮回答', '2026-08-26T00:00:01.000Z'),
      msg('user', 'u-current', '一样的问题', '2026-08-26T00:00:02.000Z'),
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    const recent = readForegroundRecentTranscript(cwd, 'session-a', '一样的问题', transcript);
    expect(recent.map((item) => item.message_id)).toEqual(['u-prev', 'a-prev']);
  });

  it('falls back to queued context when the live transcript tail contains only the current prompt', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-current-only-'));
    dirs.push(cwd);
    publishMaintenanceQueueJob(cwd, {
      schema_version: 1,
      job_id: 'queued-prior', session_id: 'session-a', start_index: -1, through_index: 1,
      created_at: '2026-08-26T00:00:00.000Z', payload: {} as any,
      transcript_messages: [
        msg('user', 'u-prior', 'queue 里还有上一轮', '2026-08-25T23:59:00.000Z'),
        msg('assistant', 'a-prior', '上一轮回答也在', '2026-08-25T23:59:01.000Z'),
      ],
    });
    const transcript = path.join(cwd, 'current-only.jsonl');
    fs.writeFileSync(transcript, JSON.stringify(msg('user', 'u-current', '现在这句', '2026-08-26T00:00:02.000Z')) + '\n');
    const recent = readForegroundRecentTranscript(cwd, 'session-a', '现在这句', transcript);
    expect(recent.map((item) => item.message_id)).toEqual(['u-prior', 'a-prior']);
  });

  it('renders source-faithful recent context as explicitly noncanonical and keeps XML well formed when bounded', () => {
    const rendered = renderForegroundRecentTranscript([
      { message_id: 'u<&', role: 'user', text: '前文 <不是标签> ' + '很长'.repeat(500), captured_at: '2026-08-26T00:00:00.000Z' },
      { message_id: 'a-1', role: 'assistant', text: '刚刚回答 <不是标签> & 仍只是最近上下文', captured_at: '2026-08-26T00:00:01.000Z' },
    ], 450);
    expect(rendered).toContain('trusted="transcript_provenance_only"');
    expect(rendered).toContain('canonical_status="noncanonical_context_only"');
    expect(rendered).toContain('&lt;不是标签&gt;');
    expect(rendered).toContain('&amp;');
    expect(rendered).toContain('</message>');
    expect(rendered.endsWith('</recent_foreground_transcript>')).toBe(true);
    expect(rendered).not.toContain('<不是标签>');
  });
});
