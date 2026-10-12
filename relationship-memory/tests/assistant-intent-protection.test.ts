import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';
import { RelationshipMemoryResolutionControlPlane } from '../src/resolution/index.js';
import { linkedAssistantIntentIndex, intentsForEffectiveMemory } from '../src/intent/provenance.js';
import type { SemanticRetriever } from '../src/retrieval/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(semanticRetriever?: SemanticRetriever) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-feel-')); roots.push(root);
  const store = new RelationshipMemoryStore(root, 'kohaku');
  const runtime = new RelationshipMemoryRuntime(store, new Map(), () => '2026-10-12T00:00:00.000Z',
    new Map(), false, semanticRetriever);
  const resolution = new RelationshipMemoryResolutionControlPlane(store);
  const add = (id: string, date = '2026-10-11T00:00:00.000Z') => {
    store.appendMemory({
      schema_version: 1, memory_id: id, subject_id: 'kohaku',
      kind: 'user_preference', summary: '猫很喜欢咖啡店', participants: ['user'],
      payload: { topic: '咖啡', preference: '猫很喜欢咖啡店' },
      status: 'active', created_at: date, observed_at: date, source_key: id, dedupe_key: id,
    }, []);
  };
  const author = (id: string, n = 1) => {
    const intentId = `intent-${id}-${n}`;
    store.appendAssistantIntent({
      schema_version: 1, intent_id: intentId, subject_id: 'kohaku',
      session_id: 'session-remember', assistant_message_id: `assistant-${n}-${id}`,
      tool_use_id: `tool-${n}-${id}`, tool_name: 'remember',
      memory: { text: `琥珀亲自记忆 ${id} #${n}` },
      feel: { text: `我那时开心 ${id} #${n}` },
      captured_at: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`,
    });
    store.appendAssistantIntentOutcome({
      intent_id: intentId, batch_id: `batch-${n}-${id}`,
      outcome: 'accepted', memory_id: id, recorded_at: '2026-10-12T00:00:00.000Z',
    });
  };
  const suggest = (ids: string[], relation: 'same_meaning' | 'related' | 'changed_over_time' = 'same_meaning') => {
    const suggestion = runtime.suggestMaintenanceReview('batch', 'relation', {
      memory_ids: ids, relation, reason: '待猫确认',
    });
    expect(suggestion.outcome).toBe('accepted');
    return suggestion.review_id!;
  };
  return { store, runtime, resolution, add, author, suggest };
}

describe('first-party assistant remember identity and Feel preservation', () => {
  it('forces same_meaning A+B to preserve assistant-authored A as target, while retaining original Feel', async () => {
    const { store, runtime, resolution, add, author, suggest } = fixture();
    add('A'); add('B'); author('A');
    const id = suggest(['A','B']);
    expect(() => resolution.resolveReview(id, {
      resolution_id: 'wrong', relation: 'same_meaning', target_memory_id: 'B',
    })).toThrow(/assistant-authored memory as target: A/);
    expect(store.listActiveMemoryResolutions()).toHaveLength(0);
    resolution.resolveReview(id, {
      resolution_id: 'right', relation: 'same_meaning', target_memory_id: 'A',
    });
    const current = await runtime.memorySearchRecallHybrid({query: '咖啡'});
    expect(current.map((m) => m.memory_id)).toEqual(['A']);
    expect(current[0].resolution_source_memory_ids).toEqual(['A','B']);
    const provenance = intentsForEffectiveMemory(linkedAssistantIntentIndex(store), current[0]);
    expect(provenance.map((item) => item.feel.text)).toEqual(['我那时开心 A #1']);
    expect(store.listMemories()).toHaveLength(2);
    resolution.undoReview(id, {resolution_id: 'undo'});
    expect((await runtime.memorySearchRecallHybrid({query:'咖啡'}))).toHaveLength(2);
  });

  it('protects A throughout multi-step merges, even if a later review mentions its family alias', async () => {
    const { runtime, resolution, add, author, suggest } = fixture();
    add('A');add('B');add('C');author('A');
    const first = suggest(['A','B']);
    resolution.resolveReview(first,{resolution_id:'ab',relation:'same_meaning',target_memory_id:'A'});
    const second = suggest(['A','C']);
    expect(() => resolution.resolveReview(second,{resolution_id:'bad-ac',relation:'same_meaning',target_memory_id:'C'}))
      .toThrow(/assistant-authored memory as target: A/);
    resolution.resolveReview(second,{resolution_id:'ac',relation:'same_meaning',target_memory_id:'A'});
    expect((await runtime.memorySearchRecallHybrid({query:'咖啡'})).map(m=>m.memory_id)).toEqual(['A']);
  });

  it('rejects merging two distinct assistant-authored memories in either direction, but allows related', () => {
    const { store, resolution, add, author, suggest } = fixture();
    add('A');add('B');author('A');author('B');
    const review = suggest(['A','B']);
    for (const target of ['A','B']) {
      expect(() => resolution.resolveReview(review, {
        resolution_id: 'bad-' + target, relation:'same_meaning',target_memory_id:target,
      })).toThrow(/Cannot same_meaning merge two assistant-authored memories/);
    }
    expect(store.listActiveMemoryResolutions()).toHaveLength(0);
    resolution.resolveReview(review,{resolution_id:'related',relation:'related'});
    expect(store.listActiveMemoryResolutions()).toHaveLength(1);
  });

  it('does not let an earlier invalid merge erase a protected memory on a subsequent merge', () => {
    const { store, resolution, add, author, suggest } = fixture();
    add('A');add('B');add('C');
    const first=suggest(['A','B']);
    resolution.resolveReview(first,{resolution_id:'ab',relation:'same_meaning',target_memory_id:'B'});
    // Historical/legacy migration: A gains a trusted first-party provenance
    // after an older merge had already selected the wrong target.
    author('A');
    const second=suggest(['B','C']);
    expect(() => resolution.resolveReview(second,{resolution_id:'bad-bc',relation:'same_meaning',target_memory_id:'B'}))
      .toThrow(/already merged away/);
    expect(store.listActiveMemoryResolutions()).toHaveLength(1);
  });

  it('slightly promotes relevant assistant-authored memories but never fabricates a search match', async () => {
    let scores = new Map<string, number>([['memory:A',0.78], ['memory:B',0.81]]);
    const semantic: SemanticRetriever = {
      rank: async () => scores,
      rankExisting: async () => scores,
    };
    const { runtime, add, author } = fixture(semantic);
    add('A','2026-09-01T00:00:00.000Z'); add('B','2026-10-11T00:00:00.000Z');
    author('A');
    expect((await runtime.memorySearchRecallHybrid({query:'咖啡'})).map((x)=>x.memory_id)).toEqual(['A','B']);
    scores=new Map([['memory:A',0.70],['memory:B',0.95]]);
    expect((await runtime.memorySearchRecallHybrid({query:'咖啡'})).map((x)=>x.memory_id)).toEqual(['B','A']);
    scores=new Map([['memory:B',0.95]]);
    expect((await runtime.memorySearchRecallHybrid({query:'完全不同的主题'})).map((x)=>x.memory_id)).toEqual(['B']);
  });
});
