import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activityRunDir,
  mirrorSubconActivity,
  mirrorSubconVisibility,
  readMirroredActivityEvents,
  readMirroredVisibilityEvents,
  visibilityRunDir,
} from './subcon_visibility_mirror.js';

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'subcon-visibility-test-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('subcon visibility mirror', () => {
  it('preserves exact payload and stable prompt/tool ordering', () => {
    const dir = root();
    const env = {
      SUBCON_VISIBILITY_DIR: dir,
      SUBCON_VISIBILITY_RUN_ID: 'run-1',
    } as NodeJS.ProcessEnv;
    const initial = '<letta_context>记得猫喜欢拉面</letta_context>';
    const update = '<letta_update>\n<letta_message>工具时更新</letta_message>\n</letta_update>';

    expect(mirrorSubconVisibility({ sessionId: 'session-a', phase: 'user_prompt', payload: initial }, env)).toBe(true);
    expect(mirrorSubconVisibility({ sessionId: 'session-a', phase: 'pre_tool', payload: update }, env)).toBe(true);

    const events = readMirroredVisibilityEvents(dir, 'run-1');
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.phase)).toEqual(['user_prompt', 'pre_tool']);
    expect(events.map((event) => event.payload)).toEqual([initial, update]);
    expect(events.every((event) => event.session_id === 'session-a')).toBe(true);
  });

  it('keeps background memory-write activity separate from foreground visibility events', () => {
    const dir = root();
    const env = { SUBCON_VISIBILITY_DIR: dir, SUBCON_VISIBILITY_RUN_ID: 'run-memory' } as NodeJS.ProcessEnv;
    expect(mirrorSubconActivity({
      sessionId: 'session-a', activity: 'memory_write', action: 'remembered',
      memory: { memory_id: 'mem-1', kind: 'user_preference', summary: '猫喜欢安静的咖啡店。' },
    }, env)).toBe(true);
    expect(readMirroredVisibilityEvents(dir, 'run-memory')).toEqual([]);
    expect(readMirroredActivityEvents(dir, 'run-memory')).toEqual([
      expect.objectContaining({
        schema: 'subcon_activity_v1', session_id: 'session-a', sequence: 1,
        activity: 'memory_write', action: 'remembered',
        memory: { memory_id: 'mem-1', kind: 'user_preference', summary: '猫喜欢安静的咖啡店。' },
      }),
    ]);
    expect(fs.statSync(activityRunDir(dir, 'run-memory')).mode & 0o777).toBe(0o700);
  });

  it('mirrors accepted relation-review activity without pretending it is a memory write', () => {
    const dir = root();
    const env = { SUBCON_VISIBILITY_DIR: dir, SUBCON_VISIBILITY_RUN_ID: 'run-review' } as NodeJS.ProcessEnv;
    expect(mirrorSubconActivity({
      sessionId: 'session-a', activity: 'relation_review', action: 'queued',
      review: {
        review_id: 'review-1', suggested_relation: 'same_meaning',
        memory_ids: ['mem-a', 'mem-b'], reason: '两条 canonical memory 看起来重复。',
      },
    }, env)).toBe(true);
    expect(readMirroredActivityEvents(dir, 'run-review')).toEqual([
      expect.objectContaining({
        schema: 'subcon_activity_v1', session_id: 'session-a', sequence: 1,
        activity: 'relation_review', action: 'queued',
        review: {
          review_id: 'review-1', suggested_relation: 'same_meaning',
          memory_ids: ['mem-a', 'mem-b'], reason: '两条 canonical memory 看起来重复。',
        },
      }),
    ]);
  });

  it('is disabled unless Claude-P supplies an explicit local run boundary', () => {
    const dir = root();
    expect(mirrorSubconVisibility(
      { sessionId: 'session-a', phase: 'user_prompt', payload: 'visible' },
      { SUBCON_VISIBILITY_DIR: dir } as NodeJS.ProcessEnv,
    )).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('fails closed without throwing and therefore cannot suppress hook injection', () => {
    const dir = root();
    const notDirectory = path.join(dir, 'file');
    fs.writeFileSync(notDirectory, 'occupied');
    const env = {
      SUBCON_VISIBILITY_DIR: notDirectory,
      SUBCON_VISIBILITY_RUN_ID: 'run-1',
    } as NodeJS.ProcessEnv;

    expect(() => mirrorSubconVisibility(
      { sessionId: 'session-a', phase: 'user_prompt', payload: 'authoritative stdout survives' },
      env,
    )).not.toThrow();
    expect(mirrorSubconVisibility(
      { sessionId: 'session-a', phase: 'user_prompt', payload: 'authoritative stdout survives' },
      env,
    )).toBe(false);
  });

  it('bounds retained event files for a run', () => {
    const dir = root();
    const env = {
      SUBCON_VISIBILITY_DIR: dir,
      SUBCON_VISIBILITY_RUN_ID: 'run-bounded',
      SUBCON_VISIBILITY_MAX_EVENTS: '2',
    } as NodeJS.ProcessEnv;

    for (const payload of ['one', 'two', 'three']) {
      expect(mirrorSubconVisibility({ sessionId: 'session-a', phase: 'pre_tool', payload }, env)).toBe(true);
    }
    const events = readMirroredVisibilityEvents(dir, 'run-bounded');
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(events.map((event) => event.payload)).toEqual(['two', 'three']);
    expect(fs.statSync(visibilityRunDir(dir, 'run-bounded')).mode & 0o777).toBe(0o700);
  });
});
