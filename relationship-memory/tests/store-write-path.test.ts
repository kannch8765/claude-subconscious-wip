import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../src/store/index.js';
import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  CanonicalMemoryRecord,
  EntityEvidenceRecord,
  EntityIdentityRecord,
  EvidenceRecord,
  ReinforcementRecord,
} from '../src/schema/index.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-memory-write-path-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function memory(id: string): CanonicalMemoryRecord {
  return {
    schema_version: 1,
    memory_id: id,
    subject_id: 'subject',
    kind: 'personal_experience',
    summary: `summary ${id}`,
    participants: ['user'],
    payload: { title: id, experience: `experience ${id}` },
    status: 'active',
    observed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    source_key: `source:${id}`,
    dedupe_key: `dedupe:${id}`,
  };
}

function evidence(id: string, memoryId: string): EvidenceRecord {
  return {
    evidence_id: id,
    memory_id: memoryId,
    conversation_id: 'conversation',
    message_id: `message:${id}`,
    role: 'user',
    quote: `quote ${id}`,
    captured_at: '2026-01-01T00:00:00.000Z',
  };
}

function reinforcement(id: string, memoryId: string, evidenceIds: string[]): ReinforcementRecord {
  return {
    schema_version: 1,
    reinforcement_id: id,
    memory_id: memoryId,
    batch_id: 'batch',
    evidence_ids: evidenceIds,
    latest_evidence_at: '2026-01-01T00:00:00.000Z',
    recorded_at: '2026-01-01T00:00:00.000Z',
  };
}

function entity(id: string): EntityIdentityRecord {
  return {
    schema_version: 1,
    entity_id: id,
    subject_id: 'subject',
    canonical_name: id,
    aliases: [],
    entity_type: 'other',
    description: `description ${id}`,
    observed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    source_key: `source:${id}`,
  };
}

function entityEvidence(id: string, entityId: string): EntityEvidenceRecord {
  return {
    evidence_id: id,
    entity_id: entityId,
    conversation_id: 'conversation',
    message_id: `message:${id}`,
    role: 'user',
    quote: `quote ${id}`,
    captured_at: '2026-01-01T00:00:00.000Z',
  };
}

function intent(id: string, text = 'remember this'): AssistantRememberIntentRecord {
  return {
    schema_version: 1,
    intent_id: id,
    subject_id: 'subject',
    session_id: 'session',
    assistant_message_id: 'assistant-message',
    tool_use_id: 'tool-use',
    tool_name: 'memory_remember',
    memory: { text },
    feel: { text: 'warm' },
    captured_at: '2026-01-01T00:00:00.000Z',
  };
}

function intentOutcome(intentId: string): AssistantIntentOutcome {
  return {
    intent_id: intentId,
    batch_id: 'batch',
    outcome: 'accepted',
    memory_id: 'memory-1',
    recorded_at: '2026-01-01T00:00:00.000Z',
  };
}

function canonicalSnapshot(store: RelationshipMemoryStore) {
  return {
    memories: store.listMemories(),
    evidence: store.listEvidence(),
    reinforcements: store.listReinforcements(),
    entities: store.listEntities(),
    entityEvidence: store.listEntityEvidence(),
    intents: store.listAssistantIntents(),
    intentOutcomes: store.listAssistantIntentOutcomes(),
  };
}

describe('store write-path indexing', () => {
  it('preserves memory, evidence, reinforcement, and entity idempotency', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    const mem = memory('memory-1');
    const ev = evidence('evidence-1', mem.memory_id);
    store.appendMemory(mem, [ev]);
    store.appendMemory(mem, [ev]);
    expect(store.listMemories()).toHaveLength(1);
    expect(store.listEvidence()).toHaveLength(1);

    const reinf = reinforcement('reinforcement-1', mem.memory_id, [ev.evidence_id]);
    store.appendReinforcement(reinf, [ev]);
    store.appendReinforcement(reinf, [ev]);
    expect(store.listReinforcements()).toHaveLength(1);
    expect(store.listEvidence()).toHaveLength(1);

    const ent = entity('entity-1');
    const entEv = entityEvidence('entity-evidence-1', ent.entity_id);
    store.appendEntity(ent, [entEv]);
    store.appendEntity(ent, [entEv]);
    expect(store.listEntities()).toHaveLength(1);
    expect(store.listEntityEvidence()).toHaveLength(1);
  });

  it('preserves reinforcement and assistant-intent identity collisions', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    store.appendReinforcement(reinforcement('reinforcement-1', 'memory-1', ['evidence-1']), []);
    expect(() => store.appendReinforcement(reinforcement('reinforcement-1', 'memory-2', ['evidence-1']), [])).toThrow('reinforcement identity collision: reinforcement-1');
    expect(() => store.appendReinforcement(reinforcement('reinforcement-1', 'memory-1', ['evidence-2']), [])).toThrow('reinforcement identity collision: reinforcement-1');

    store.appendAssistantIntent(intent('intent-1'));
    store.appendAssistantIntent(intent('intent-1'));
    expect(store.listAssistantIntents()).toHaveLength(1);
    expect(() => store.appendAssistantIntent(intent('intent-1', 'different'))).toThrow('assistant intent identity collision: intent-1');
  });

  it('deduplicates an exactly repeated assistant intent outcome', () => {
    const store = new RelationshipMemoryStore(tempDir(), 'subject');
    const outcome = intentOutcome('intent-1');
    store.appendAssistantIntentOutcome(outcome);
    store.appendAssistantIntentOutcome(outcome);
    expect(store.listAssistantIntentOutcomes()).toEqual([outcome]);
  });

  it('produces the same canonical result inside one outer mutation boundary and across separate boundaries', () => {
    const nested = new RelationshipMemoryStore(tempDir(), 'subject');
    const separate = new RelationshipMemoryStore(tempDir(), 'subject');
    const write = (store: RelationshipMemoryStore) => {
      for (let i = 0; i < 12; i += 1) {
        const mem = memory(`memory-${i}`);
        const ev = evidence(`evidence-${i}`, mem.memory_id);
        store.appendMemory(mem, [ev]);
        store.appendReinforcement(reinforcement(`reinforcement-${i}`, mem.memory_id, [ev.evidence_id]), [ev]);
      }
    };
    nested.withMutationBoundary(() => write(nested));
    write(separate);
    expect(canonicalSnapshot(nested)).toEqual(canonicalSnapshot(separate));
  });

  it('does not retain stale state when another store writes between boundaries', () => {
    const dir = tempDir();
    const first = new RelationshipMemoryStore(dir, 'subject');
    const second = new RelationshipMemoryStore(dir, 'subject');
    first.appendMemory(memory('memory-1'), []);
    second.appendMemory(memory('memory-2'), []);
    first.appendMemory(memory('memory-2'), []);
    expect(first.listMemories().map((item) => item.memory_id)).toEqual(['memory-1', 'memory-2']);
  });

  it('rebuilds a stale sidecar before trusting absence after an external canonical append', () => {
    const dir = tempDir();
    const store = new RelationshipMemoryStore(dir, 'subject');
    store.appendMemory(memory('memory-1'), []);
    const external = memory('memory-external');
    fs.appendFileSync(path.join(dir, 'memories.jsonl'), `${JSON.stringify(external)}\n`, 'utf8');
    store.appendMemory(external, []);
    expect(store.listMemories().filter((item) => item.memory_id === external.memory_id)).toHaveLength(1);
  });

  it('keeps disk and later writes correct after failureInjector aborts a mutation', () => {
    const dir = tempDir();
    let fail = true;
    const store = new RelationshipMemoryStore(dir, 'subject', (phase) => fail && phase === 'memory_commit');
    expect(() => store.appendMemory(memory('memory-1'), [evidence('evidence-1', 'memory-1')])).toThrow('injected memory commit failure');
    expect(store.listMemories()).toHaveLength(0);
    expect(store.listEvidence()).toHaveLength(0);

    fail = false;
    store.appendMemory(memory('memory-1'), [evidence('evidence-1', 'memory-1')]);
    store.appendMemory(memory('memory-1'), [evidence('evidence-1', 'memory-1')]);
    expect(store.listMemories()).toHaveLength(1);
    expect(store.listEvidence()).toHaveLength(1);
  });
});
