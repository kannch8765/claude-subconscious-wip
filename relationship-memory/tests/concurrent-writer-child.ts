import * as fs from 'fs';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';

const [mode, root, id, startFile] = process.argv.slice(2);
if (!mode || !root || !id) throw new Error('mode/root/id required');

function waitForStart(): void {
  if (!startFile) return;
  while (!fs.existsSync(startFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

const store = new RelationshipMemoryStore(root, 'subject-test');
const message = {
  message_id: 'message-1', evidence_id: 'trusted-evidence-1', conversation_id: 'conversation-test',
  role: 'user', quote: '猫喜欢拉面', captured_at: '2026-08-10T00:00:00.000Z',
} as const;
const reinforceMessage = {
  message_id: 'message-2', evidence_id: 'trusted-evidence-2', conversation_id: 'conversation-test',
  role: 'user', quote: '猫又提到了拉面', captured_at: '2026-08-10T00:01:00.000Z',
} as const;

async function main(): Promise<void> {
  if (mode === 'delay-before-remember') {
    if (startFile) fs.writeFileSync(startFile, 'ready');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runtime = new RelationshipMemoryRuntime(store, new Map([[message.message_id, message as any]]));
    const result = store.withMutationBoundary(() => runtime.remember(id, {
      schema_version: 1, kind: 'user_preference', summary: '用户喜欢拉面。', participants: ['user'],
      evidence_ids: [message.evidence_id], payload: { topic: '食物', preference: '喜欢拉面' },
    }));
    console.log(JSON.stringify(result));
    return;
  }

  waitForStart();
  if (mode === 'append') {
    for (let i = 0; i < 100; i += 1) {
      store.appendOutcome({ batch_id: id, source_key: `${id}-${i}`, outcome: 'retryable_failed', reason: 'contention-test', recorded_at: new Date().toISOString() });
    }
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  if (mode === 'remember') {
    const runtime = new RelationshipMemoryRuntime(store, new Map([[message.message_id, message as any]]));
    console.log(JSON.stringify(store.withMutationBoundary(() => runtime.remember(id, {
      schema_version: 1, kind: 'user_preference', summary: '用户喜欢拉面。', participants: ['user'],
      evidence_ids: [message.evidence_id], payload: { topic: '食物', preference: '喜欢拉面' },
    }))));
    return;
  }
  if (mode === 'entity') {
    const runtime = new RelationshipMemoryRuntime(store, new Map([[message.message_id, message as any]]));
    console.log(JSON.stringify(store.withMutationBoundary(() => runtime.rememberEntity(id, {
      schema_version: 1, canonical_name: '晴', aliases: ['晴', 'Haru'], entity_type: 'assistant',
      description: '用户称呼的 GPT 助手。', evidence_ids: [message.evidence_id],
    }))));
    return;
  }
  if (mode === 'reinforce') {
    const runtime = new RelationshipMemoryRuntime(store, new Map([[reinforceMessage.message_id, reinforceMessage as any]]));
    console.log(JSON.stringify(store.withMutationBoundary(() => runtime.reinforce(id, {
      memory_id: 'mem-seed', evidence_ids: [reinforceMessage.evidence_id],
    }))));
    return;
  }
  if (mode === 'contend') {
    let result: Record<string, unknown>;
    try {
      store.appendOutcome({ batch_id: id, source_key: id, outcome: 'retryable_failed', reason: 'test', recorded_at: new Date().toISOString() });
      result = { ok: true };
    } catch (error) {
      result = {
        ok: false,
        name: error instanceof Error ? error.name : 'unknown',
        retryable: !!(error as { retryable?: boolean })?.retryable,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (startFile) fs.writeFileSync(`${startFile}.result`, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
