import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import type { ChatTransport, TransportReply } from './llm.js';
import { runSyncPass, syncUserPrompt, type SyncInput } from './sync_pass.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const base: SyncInput = { batchId: 'b', sessionId: 's', latestUserMessage: '', previousUserMessage: '晚安', previousKohakuReply: '晚安', sessionKnownMemoryIds: [] };

/** A phrase model that asks for nothing extra, so the search runs on the message (or the note) alone. */
const phraseError: ChatTransport = {
  async chat(): Promise<TransportReply> {
    return { status: 200, ms: 1, body: { choices: [{ message: { role: 'assistant', content: 'not json' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
  },
};

function runtimeWithSpy(queries: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  dirs.push(root);
  const runtime = new RelationshipMemoryRuntime(new RelationshipMemoryStore(root, 'local-user'), new Map(), () => new Date().toISOString(), new Map(), true);
  (runtime as any).memorySearchRecallHybridWithEvidence = async (query: { query: string }) => { queries.push(query.query); return []; };
  return runtime;
}

describe('sync lane on a wakeup turn', () => {
  it('shows the note instead of a new message when ゆう sent nothing new', () => {
    const prompt = syncUserPrompt({ ...base, selfNote: '早上叫醒对方' });
    expect(prompt).toContain("Kohaku's own note from a wakeup she scheduled");
    expect(prompt).toContain('早上叫醒对方');
    expect(prompt).not.toContain("NEW message");
  });

  it('keeps the new message when there is one, note or not', () => {
    const prompt = syncUserPrompt({ ...base, latestUserMessage: '醒了', selfNote: '早上叫醒对方' });
    expect(prompt).toContain("ゆう's NEW message (Kohaku has not replied yet):\n醒了");
    expect(prompt).not.toContain('早上叫醒对方');
  });

  it('searches around the note', async () => {
    const queries: string[] = [];
    await runSyncPass(runtimeWithSpy(queries), phraseError, { ...base, selfNote: '早上叫醒对方' }, { model: 'm' });
    expect(queries).toEqual(['早上叫醒对方']);
  });

  it('searches nothing extra without a note or a message', async () => {
    const queries: string[] = [];
    await runSyncPass(runtimeWithSpy(queries), phraseError, base, { model: 'm' });
    expect(queries).toEqual([]);
  });
});
