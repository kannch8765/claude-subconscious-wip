import { relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../relationship-memory/src/owner/index.js';
import { rebuildProjection } from '../relationship-memory/src/projection/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';

export type OwnerMemoryReviewCommand =
  | { action: 'show'; memory_id: string }
  | { action: 'list_pending_reviews' }
  | { action: 'revise_summary'; memory_id: string; revision_id: string; summary: string; note?: string }
  | { action: 'deactivate'; memory_id: string; revision_id: string; note?: string }
  | { action: 'restore'; memory_id: string; revision_id: string; note?: string };

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
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
    return { memory };
  }

  if (command.action === 'list_pending_reviews') {
    return {
      reviews: store.listMaintenanceReviews().filter((review) => review.status === 'pending'),
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

  if (action === 'list_pending_reviews') return { action };
  if (action === 'show') return { action, memory_id: requiredText(command.memory_id, 'memory_id') };
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
