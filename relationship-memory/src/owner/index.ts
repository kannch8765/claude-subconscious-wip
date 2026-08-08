import type { EffectiveMemoryRecord, MemoryKind, OwnerRevisionRecord, OwnerSemanticContent } from '../schema/index.js';
import { validateProposal } from '../schema/index.js';
import { RelationshipMemoryStore, stableJson } from '../store/index.js';

export interface OwnerReviseCommand extends OwnerSemanticContent { revision_id: string; note?: string }
export interface OwnerStateCommand { revision_id: string; note?: string }
export interface EffectiveSearchQuery { query?: string; kind?: MemoryKind; active?: boolean; memory_id?: string }

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}
function note(value: unknown): string | undefined { return value === undefined ? undefined : nonEmpty(value, 'note'); }

function validateReplacement(input: OwnerReviseCommand, evidenceIds: string[]): OwnerSemanticContent {
  const allowed = new Set(['revision_id','note','kind','summary','participants','payload','linked_memory_ids']);
  for (const key of Object.keys(input as any)) if (!allowed.has(key)) throw new Error(`Owner revise cannot replace authoritative field: ${key}`);
  const result = validateProposal({ schema_version: 1, kind: input.kind, summary: input.summary, participants: input.participants,
    evidence_message_ids: evidenceIds, payload: input.payload, ...('linked_memory_ids' in input ? { linked_memory_ids: input.linked_memory_ids } : {}) });
  if (!result.ok || !result.proposal) throw new Error(`${result.code ?? 'invalid_revision'}: ${result.reason ?? 'Invalid owner revision'}`);
  const p = result.proposal;
  return { kind: p.kind, summary: p.summary, participants: p.participants, payload: p.payload, ...(p.linked_memory_ids ? { linked_memory_ids: p.linked_memory_ids } : {}) };
}

export class RelationshipMemoryOwnerControlPlane {
  constructor(readonly store: RelationshipMemoryStore, readonly now: () => string = () => new Date().toISOString()) {}

  revise(memoryId: string, command: OwnerReviseCommand): OwnerRevisionRecord {
    const genesis = this.requireGenesis(memoryId);
    const replacement = validateReplacement(command, this.store.listEvidence().filter((e) => e.memory_id === memoryId).map((e) => e.message_id));
    for (const linked of replacement.linked_memory_ids ?? []) if (!this.store.getMemory(linked)) throw new Error(`Unknown canonical memory ID: ${linked}`);
    const n = note(command.note);
    return this.append({ schema_version: 1, revision_id: nonEmpty(command.revision_id, 'revision_id'), subject_id: genesis.subject_id, memory_id: memoryId,
      action: 'revise', recorded_at: this.now(), ...(n ? { note: n } : {}), replacement });
  }
  deactivate(memoryId: string, command: OwnerStateCommand) { return this.state(memoryId, 'deactivate', command); }
  restore(memoryId: string, command: OwnerStateCommand) { return this.state(memoryId, 'restore', command); }
  getGenesis(memoryId: string) { return this.store.getMemory(memoryId); }
  history(memoryId: string) { return this.store.listOwnerRevisions().filter((r) => r.memory_id === memoryId); }

  getEffective(memoryId: string): EffectiveMemoryRecord | undefined {
    const genesis = this.store.getMemory(memoryId); if (!genesis) return undefined;
    let semantic: OwnerSemanticContent = { kind: genesis.kind, summary: genesis.summary, participants: genesis.participants, payload: genesis.payload, ...(genesis.linked_memory_ids ? { linked_memory_ids: genesis.linked_memory_ids } : {}) };
    let status: 'active'|'inactive' = 'active'; let latest: OwnerRevisionRecord | undefined;
    for (const rev of this.history(memoryId)) { latest = rev; if (rev.action === 'revise' && rev.replacement) semantic = rev.replacement; else if (rev.action === 'deactivate') status = 'inactive'; else if (rev.action === 'restore') status = 'active'; }
    return { ...genesis, ...semantic, status, owner_corrected: Boolean(latest), ...(latest ? { latest_revision_id: latest.revision_id, latest_revision_at: latest.recorded_at } : {}) };
  }
  listEffective(): EffectiveMemoryRecord[] { return this.store.listMemories().map((m) => this.getEffective(m.memory_id)!).filter(Boolean); }
  search(query: EffectiveSearchQuery = {}): EffectiveMemoryRecord[] {
    const needle = query.query?.trim().toLowerCase();
    return this.listEffective().filter((m) => {
      if (query.memory_id && m.memory_id !== query.memory_id) return false;
      if (query.kind && m.kind !== query.kind) return false;
      if (query.active !== undefined && (m.status === 'active') !== query.active) return false;
      return !needle || stableJson({ summary: m.summary, payload: m.payload }).toLowerCase().includes(needle);
    });
  }
  private state(memoryId: string, action: 'deactivate'|'restore', command: OwnerStateCommand): OwnerRevisionRecord {
    const genesis = this.requireGenesis(memoryId); const allowed = new Set(['revision_id','note']);
    for (const key of Object.keys(command as any)) if (!allowed.has(key)) throw new Error(`Owner ${action} cannot replace authoritative field: ${key}`);
    const n = note(command.note);
    return this.append({ schema_version: 1, revision_id: nonEmpty(command.revision_id, 'revision_id'), subject_id: genesis.subject_id, memory_id: memoryId, action, recorded_at: this.now(), ...(n ? { note: n } : {}) });
  }
  private append(record: OwnerRevisionRecord): OwnerRevisionRecord {
    const existing = this.store.listOwnerRevisions().find((r) => r.revision_id === record.revision_id);
    if (existing) { const comparable = { ...record, recorded_at: existing.recorded_at }; if (stableJson(existing) !== stableJson(comparable)) throw new Error(`revision_id already used for a different owner mutation: ${record.revision_id}`); return existing; }
    this.store.appendOwnerRevision(record); return record;
  }
  private requireGenesis(memoryId: string) { const genesis = this.store.getMemory(memoryId); if (!genesis) throw new Error(`Unknown canonical memory ID: ${memoryId}`); return genesis; }
}
