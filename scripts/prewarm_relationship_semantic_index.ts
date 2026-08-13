#!/usr/bin/env npx tsx
import * as fs from 'fs';
import * as path from 'path';
import { createRuntime } from '../relationship-memory/src/adapter/index.js';

const need = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
async function main() {
  const rootDir = path.resolve(need('RELATIONSHIP_MEMORY_DIR'));
  const subjectId = need('RELATIONSHIP_MEMORY_SUBJECT_ID');
  if (need('RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER') !== 'dashscope-qwen') throw new Error('RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER must be dashscope-qwen');
  fs.accessSync(path.resolve(need('RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE')), fs.constants.R_OK);
  const indexDir = path.resolve(process.env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR?.trim() || `${rootDir}-semantic-index`);
  const indexFile = path.join(indexDir, 'index.json');
  const runtime = createRuntime([], subjectId, rootDir);
  const active = runtime.memorySearch({});
  if (active.length) await runtime.memorySearchHybrid({ query: 'relationship memory semantic index prewarm', limit: 1 });
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const indexed = Object.keys(index.documents ?? {}).filter((id) => id.startsWith('memory:')).length;
  if (indexed < active.length) throw new Error(`semantic index incomplete: active=${active.length}, indexed=${indexed}`);
  console.log(JSON.stringify({ status: 'ok', active_memories: active.length, indexed_memories: indexed, index_file: indexFile, provider_fingerprint: index.provider_fingerprint }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
