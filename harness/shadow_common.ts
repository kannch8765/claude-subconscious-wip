/**
 * Shared setup of the shadow workers (docs/specs/OWN-HARNESS-DESIGN.md §6.1): LLM and embedding backends, a
 * runtime over a snapshot, payload handling.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { createSemanticRetrieverFromEnvironment, FileBackedSemanticRetriever, type SemanticRetriever } from '../relationship-memory/src/retrieval/index.js';
import { HttpChatTransport, RelayChatTransport, RelayProcess, RelayQueryEmbeddingProvider, shellQuote, type ChatTransport } from './llm.js';
import type { Snapshot } from './shadow_state.js';

export const DEFAULT_LLM_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions';

export interface ShadowBackends {
  transport: ChatTransport;
  retrieverFor(snapshot: Snapshot): SemanticRetriever | undefined;
  close(): Promise<void>;
}

/**
 * On racknerd: HTTP with the key file and the embedding provider from the environment. For a local test run,
 * SUBCON_SHADOW_RELAY_HOST + SUBCON_SHADOW_RELAY_SCRIPT send both through the ssh relay of the offline replay.
 */
export function shadowBackends(env: NodeJS.ProcessEnv = process.env): ShadowBackends {
  const host = env.SUBCON_SHADOW_RELAY_HOST?.trim();
  if (host) {
    const relay = new RelayProcess('ssh', [host, `python3 -u -c ${shellQuote(fs.readFileSync(env.SUBCON_SHADOW_RELAY_SCRIPT!, 'utf8'))}`]);
    return {
      transport: new RelayChatTransport(relay),
      retrieverFor: (snapshot) => {
        if (!fs.existsSync(snapshot.indexFile)) return undefined;
        const fingerprint = JSON.parse(fs.readFileSync(snapshot.indexFile, 'utf8')).provider_fingerprint as string;
        return new FileBackedSemanticRetriever(new RelayQueryEmbeddingProvider(fingerprint, relay), snapshot.indexFile);
      },
      close: () => relay.close(),
    };
  }
  const keyFile = env.SUBCON_SHADOW_LLM_KEY_FILE?.trim();
  if (!keyFile) throw new Error('SUBCON_SHADOW_LLM_KEY_FILE is required');
  return {
    transport: new HttpChatTransport(env.SUBCON_SHADOW_LLM_ENDPOINT?.trim() || DEFAULT_LLM_ENDPOINT, fs.readFileSync(keyFile, 'utf8').trim(), 'subcon-shadow/0.1'),
    retrieverFor: (snapshot) => {
      if (!fs.existsSync(snapshot.indexFile)) return undefined;
      process.env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR = path.dirname(snapshot.indexFile);
      try { return createSemanticRetrieverFromEnvironment(snapshot.storeDir); } catch { return undefined; }
    },
    close: async () => {},
  };
}

/** Runtime over a snapshot. Search reads the snapshot's index copy (rankExisting); nothing re-embeds documents. */
export function snapshotRuntime(
  backends: ShadowBackends,
  snapshot: Snapshot,
  canonicalMessages: CanonicalMessage[],
  assistantIntents: AssistantRememberIntentRecord[],
  conversationId?: string,
): RelationshipMemoryRuntime {
  return new RelationshipMemoryRuntime(
    new RelationshipMemoryStore(snapshot.storeDir, process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user'),
    new Map(canonicalMessages.map((m) => [m.evidence_id ?? m.message_id, conversationId ? { ...m, conversation_id: conversationId } : m])),
    () => new Date().toISOString(),
    new Map(assistantIntents.map((intent) => [intent.intent_id, intent])),
    true,
    backends.retrieverFor(snapshot),
  );
}

/** Reads a payload file and removes it (payloads hold conversation text). */
export function takePayload<T>(file: string): T {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  fs.rmSync(file, { force: true });
  return value;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown';
}
