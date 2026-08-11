import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyMemorySourceStore, legacySourceId, type LegacyAssistantMemorySourceRecord } from '../relationship-memory/src/legacy/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { runLegacySemanticObserverSource } from './legacy_semantic_observer_runner.js';
import { type NativeLettaClientLike } from './native_letta_backfill.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-legacy-observer-'));
  roots.push(root);
  return root;
}

function source(): LegacyAssistantMemorySourceRecord {
  const id = 'native-observer';
  return {
    schema_version: 1,
    legacy_source_id: legacySourceId('kohaku', 'dynamic', id),
    subject_id: 'kohaku',
    provenance_kind: 'legacy_assistant_memory',
    source_system: 'ombre_brain',
    bucket_type: 'dynamic',
    bucket_id: id,
    relative_path: `dynamic/${id}.md`,
    source_sha256: 'sha-native-observer',
    original_markdown: '---\nid: native-observer\n---\n猫和琥珀一起去了京都旅行。',
    body_text: '猫和琥珀一起去了京都旅行。',
    frontmatter: { name: '京都旅行', type: 'memory', domain: ['关系'], tags: ['琥珀'], importance: 9, valence: 0.8, arousal: 0.4, activation_count: 2 },
    raw_created: '2026-07-01T01:02:03',
    raw_last_active: '2026-07-02T01:02:03',
    created_at_utc: '2026-07-01T01:02:03.000Z',
    last_active_at_utc: '2026-07-02T01:02:03.000Z',
    manifest_digest: '5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31',
  };
}

function fakeClient(responses: any[]): NativeLettaClientLike {
  return {
    agents: {
      async retrieve() { throw new Error('not used'); },
      async update() { throw new Error('not used'); },
      tools: { async attach() { throw new Error('not used'); } },
    },
    tools: { async upsert() { throw new Error('not used'); } },
    conversations: {
      messages: {
        async create() {
          const response = responses.shift();
          if (!response) throw new Error('unexpected native Letta request');
          return (async function* () {
            for (const message of response.messages ?? []) yield message;
            if (response.stop_reason) {
              yield typeof response.stop_reason === 'string'
                ? { message_type: 'stop_reason', stop_reason: response.stop_reason }
                : response.stop_reason;
            }
          })();
        },
      },
    },
  };
}

describe('native legacy semantic observer integration', () => {
  it('preserves backend-bound create/provenance semantics through native client-tool approval and terminal completion', async () => {
    const root = temp();
    const item = source();
    new LegacyMemorySourceStore(root).appendSource(item);
    const proposal = {
      schema_version: 1,
      kind: 'shared_experience',
      summary: '京都旅行是猫和琥珀的重要共同经历',
      participants: ['user', 'assistant'],
      payload: { title: '京都旅行', event: '猫和琥珀一起经历了京都旅行', shared_meaning: '这件事让彼此更亲近' },
    };
    const client = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: { name: 'legacy_memory_create', arguments: JSON.stringify(proposal), tool_call_id: 'create-1' },
        }],
        stop_reason: 'requires_approval',
      },
      {
        messages: [{
          message_type: 'tool_call_message',
          tool_call: { name: 'legacy_source_complete', arguments: '{"result":"completed"}', tool_call_id: 'terminal-1' },
        }],
        stop_reason: 'tool_rule',
      },
    ]);

    const result = await runLegacySemanticObserverSource({
      agentId: 'agent-native',
      conversationId: 'conv-native',
      source: item,
      batchId: 'batch-native',
      rootDir: root,
      subjectId: 'kohaku',
      client,
    });

    expect(result).toEqual({ completion: 'completed' });
    const memories = new RelationshipMemoryStore(root, 'kohaku').listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ subject_id: 'kohaku', kind: 'shared_experience', summary: proposal.summary });
    expect(new LegacyMemorySourceStore(root).listProvenance()).toEqual([
      expect.objectContaining({ legacy_source_id: item.legacy_source_id, canonical_memory_id: memories[0].memory_id, disposition: 'created' }),
    ]);
    const completedBatches = new RelationshipMemoryStore(root, 'kohaku').listBatches();
    expect(completedBatches).toHaveLength(2);
    expect(completedBatches[0]).toMatchObject({ batch_id: 'batch-native', status: 'pending' });
    expect(completedBatches.at(-1)).toMatchObject({ batch_id: 'batch-native', status: 'completed' });
  });

  it('fails closed and leaves the batch resumable when a native terminal result violates local provenance invariants', async () => {
    const root = temp();
    const item = source();
    new LegacyMemorySourceStore(root).appendSource(item);
    const client = fakeClient([{
      messages: [{
        message_type: 'tool_call_message',
        tool_call: { name: 'legacy_source_complete', arguments: '{"result":"completed"}', tool_call_id: 'terminal-1' },
      }],
      stop_reason: 'tool_rule',
    }]);

    const result = await runLegacySemanticObserverSource({
      agentId: 'agent-native', conversationId: 'conv-native', source: item,
      batchId: 'batch-native', rootDir: root, subjectId: 'kohaku', client,
    });

    expect(result.completion).toBe('retryable_failure');
    expect(new RelationshipMemoryStore(root, 'kohaku').listMemories()).toHaveLength(0);
    expect(new LegacyMemorySourceStore(root).listProvenance()).toHaveLength(0);
    const failedBatches = new RelationshipMemoryStore(root, 'kohaku').listBatches();
    expect(failedBatches).toHaveLength(2);
    expect(failedBatches[0]).toMatchObject({ batch_id: 'batch-native', status: 'pending' });
    expect(failedBatches.at(-1)).toMatchObject({ batch_id: 'batch-native', status: 'retryable_failure' });
  });
});
