/**
 * LLM and query-embedding backends for harness runs: HTTP with a key file on racknerd, or the ssh relay of the
 * offline replay (keys stay remote) for a local run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createSemanticRetrieverFromEnvironment, FileBackedSemanticRetriever, type SemanticRetriever } from '../relationship-memory/src/retrieval/index.js';
import { HttpChatTransport, RelayChatTransport, RelayProcess, RelayQueryEmbeddingProvider, shellQuote, type ChatTransport } from './llm.js';

export const DEFAULT_LLM_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions';

export interface Backends {
  transport: ChatTransport;
  /** Search over an existing index file (rankExisting); undefined when the file is missing. */
  retrieverFor(indexFile: string, storeDir: string): SemanticRetriever | undefined;
  close(): Promise<void>;
}

/**
 * HARNESS_RELAY_HOST + HARNESS_RELAY_SCRIPT: everything through the ssh relay. Otherwise HTTP with
 * HARNESS_LLM_KEY_FILE (and HARNESS_LLM_ENDPOINT), and the embedding provider from the RELATIONSHIP_MEMORY_EMBEDDING_*
 * environment.
 */
export function backends(env: NodeJS.ProcessEnv = process.env): Backends {
  const host = env.HARNESS_RELAY_HOST?.trim();
  if (host) {
    const relay = new RelayProcess('ssh', [host, `python3 -u -c ${shellQuote(fs.readFileSync(env.HARNESS_RELAY_SCRIPT!, 'utf8'))}`]);
    return {
      transport: new RelayChatTransport(relay),
      retrieverFor: (indexFile) => {
        if (!fs.existsSync(indexFile)) return undefined;
        const fingerprint = JSON.parse(fs.readFileSync(indexFile, 'utf8')).provider_fingerprint as string;
        return new FileBackedSemanticRetriever(new RelayQueryEmbeddingProvider(fingerprint, relay), indexFile);
      },
      close: () => relay.close(),
    };
  }
  const keyFile = env.HARNESS_LLM_KEY_FILE?.trim();
  if (!keyFile) throw new Error('HARNESS_LLM_KEY_FILE is required');
  return {
    transport: new HttpChatTransport(env.HARNESS_LLM_ENDPOINT?.trim() || DEFAULT_LLM_ENDPOINT, fs.readFileSync(keyFile, 'utf8').trim(), 'subcon-harness/0.1'),
    retrieverFor: (indexFile, storeDir) => {
      if (!fs.existsSync(indexFile)) return undefined;
      process.env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR = path.dirname(indexFile);
      try { return createSemanticRetrieverFromEnvironment(storeDir); } catch { return undefined; }
    },
    close: async () => {},
  };
}
