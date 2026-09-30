import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../relationship-memory/src/owner/index.js';
import { rebuildProjection } from '../relationship-memory/src/projection/index.js';
import { MEMORY_KINDS, type MemoryKind } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';

export type OwnerMemoryReviewCommand =
  | { action: 'show'; memory_id: string }
  | { action: 'search'; query?: string; kind?: MemoryKind; active?: boolean; limit?: number }
  | { action: 'list_pending_reviews'; limit?: number }
  | { action: 'status' }
  | { action: 'revise_summary'; memory_id: string; revision_id: string; summary: string; note?: string }
  | { action: 'deactivate'; memory_id: string; revision_id: string; note?: string }
  | { action: 'restore'; memory_id: string; revision_id: string; note?: string };

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function limit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`limit must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function memoryKind(value: unknown): MemoryKind | undefined {
  if (value === undefined) return undefined;
  const text = requiredText(value, 'kind');
  if (!MEMORY_KINDS.includes(text as MemoryKind)) throw new Error(`unsupported memory kind: ${text}`);
  return text as MemoryKind;
}

export function executeOwnerMemoryReviewCommand(
  command: OwnerMemoryReviewCommand,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  const root = env.RELATIONSHIP_MEMORY_DIR?.trim() || relationshipMemoryRoot();
  const subjectId = env.RELATIONSHIP_MEMORY_SUBJECT_ID?.trim() || 'local-user';
  const store = new RelationshipMemoryStore(root, subjectId);
  const owner = new RelationshipMemoryOwnerControlPlane(store);

  if (command.action === 'show') {
    const memoryId = requiredText(command.memory_id, 'memory_id');
    const memory = owner.getEffective(memoryId);
    if (!memory) throw new Error(`Unknown canonical memory ID: ${memoryId}`);
    return {
      memory,
      evidence_count: store.listEvidenceForMemoryIds([memoryId]).length,
      revision_count: owner.history(memoryId).length,
    };
  }

  if (command.action === 'search') {
    const rows = owner.search({
      ...(command.query ? { query: command.query } : {}),
      ...(command.kind ? { kind: command.kind } : {}),
      ...(command.active !== undefined ? { active: command.active } : {}),
    });
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { memories: rows.slice(0, command.limit ?? 8), total: rows.length };
  }

  if (command.action === 'list_pending_reviews') {
    const pending = store.listMaintenanceReviews()
      .filter((review) => review.status === 'pending')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const memories = new Map(owner.listEffective().map((memory) => [memory.memory_id, memory]));
    return {
      reviews: pending.slice(0, command.limit ?? 5).map((review) => ({
        ...review,
        memories: review.memory_ids.map((memoryId) => memories.get(memoryId) ?? { memory_id: memoryId, missing: true }),
      })),
      total: pending.length,
    };
  }

  if (command.action === 'status') {
    const memories = owner.listEffective();
    const reviews = store.listMaintenanceReviews();
    const countsByKind = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0])) as Record<MemoryKind, number>;
    let active = 0;
    let inactive = 0;
    let ownerCorrected = 0;
    for (const memory of memories) {
      countsByKind[memory.kind] += 1;
      if (memory.status === 'active') active += 1;
      else inactive += 1;
      if (memory.owner_corrected) ownerCorrected += 1;
    }
    const latest = [...memories].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return {
      subject_id: subjectId,
      memory: {
        total: memories.length,
        active,
        inactive,
        owner_corrected: ownerCorrected,
        by_kind: countsByKind,
        latest: latest ? {
          memory_id: latest.memory_id,
          kind: latest.kind,
          summary: latest.summary,
          created_at: latest.created_at,
          status: latest.status,
        } : null,
      },
      review: {
        pending: reviews.filter((review) => review.status === 'pending').length,
        resolved: reviews.filter((review) => review.status === 'resolved').length,
        dismissed: reviews.filter((review) => review.status === 'dismissed').length,
      },
    };
  }

  const memoryId = requiredText(command.memory_id, 'memory_id');
  const revisionId = requiredText(command.revision_id, 'revision_id');

  if (command.action === 'revise_summary') {
    const current = owner.getEffective(memoryId);
    if (!current) throw new Error(`Unknown canonical memory ID: ${memoryId}`);
    const summary = requiredText(command.summary, 'summary');
    owner.revise(memoryId, {
      revision_id: revisionId,
      kind: current.kind,
      summary,
      participants: current.participants,
      payload: current.payload,
      ...(current.linked_memory_ids ? { linked_memory_ids: current.linked_memory_ids } : {}),
      ...(command.note ? { note: command.note } : {}),
    });
  } else if (command.action === 'deactivate') {
    owner.deactivate(memoryId, {
      revision_id: revisionId,
      ...(command.note ? { note: command.note } : {}),
    });
  } else if (command.action === 'restore') {
    owner.restore(memoryId, {
      revision_id: revisionId,
      ...(command.note ? { note: command.note } : {}),
    });
  }

  rebuildProjection(store);
  return { memory: owner.getEffective(memoryId) };
}

function parseCommand(raw: unknown): OwnerMemoryReviewCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('command must be a JSON object');
  const command = raw as Record<string, unknown>;
  const action = requiredText(command.action, 'action');

  if (action === 'status') return { action };
  if (action === 'list_pending_reviews') return { action, limit: limit(command.limit, 5, 20) };
  if (action === 'show') return { action, memory_id: requiredText(command.memory_id, 'memory_id') };
  if (action === 'search') {
    if (command.active !== undefined && typeof command.active !== 'boolean') throw new Error('active must be boolean');
    const query = optionalText(command.query);
    const kind = memoryKind(command.kind);
    return {
      action,
      ...(query ? { query } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof command.active === 'boolean' ? { active: command.active } : {}),
      limit: limit(command.limit, 8, 20),
    };
  }
  if (action === 'revise_summary') {
    return {
      action,
      memory_id: requiredText(command.memory_id, 'memory_id'),
      revision_id: requiredText(command.revision_id, 'revision_id'),
      summary: requiredText(command.summary, 'summary'),
      ...(typeof command.note === 'string' && command.note.trim() ? { note: command.note.trim() } : {}),
    };
  }
  if (action === 'deactivate' || action === 'restore') {
    return {
      action,
      memory_id: requiredText(command.memory_id, 'memory_id'),
      revision_id: requiredText(command.revision_id, 'revision_id'),
      ...(typeof command.note === 'string' && command.note.trim() ? { note: command.note.trim() } : {}),
    };
  }
  throw new Error(`unsupported action: ${action}`);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('expected one JSON command on stdin');
  const result = executeOwnerMemoryReviewCommand(parseCommand(JSON.parse(raw)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
