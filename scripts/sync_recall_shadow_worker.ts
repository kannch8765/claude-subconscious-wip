#!/usr/bin/env tsx
import * as fs from 'fs';
import { createRuntime, relationshipMemoryRoot } from '../relationship-memory/src/index.js';
import {
  appendShadowReceipt,
  makeShadowReceipt,
  runDeterministicAnchorShadow,
  runDeterministicSyncRecall,
} from './sync_recall.js';

interface ShadowPayload {
  schema_version: 1;
  session_id: string;
  cwd?: string;
  prompt: string;
  recorded_at?: string;
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];
  if (!payloadFile) process.exit(0);
  let payload: ShadowPayload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8')) as ShadowPayload;
  } catch {
    try { fs.rmSync(payloadFile, { force: true }); } catch { }
    process.exit(0);
  }
  try { fs.rmSync(payloadFile, { force: true }); } catch { }
  if (payload?.schema_version !== 1 || typeof payload.session_id !== 'string' || typeof payload.prompt !== 'string') return;

  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  const runtime = createRuntime([], subjectId, relationshipMemoryRoot(), []);
  const result = await runDeterministicSyncRecall(payload.prompt, { runtime });
  const anchorShadow = runDeterministicAnchorShadow(payload.prompt, result, runtime);
  appendShadowReceipt(makeShadowReceipt(payload.session_id, payload.cwd, payload.prompt, result, payload.recorded_at, anchorShadow));
}

main().catch(() => process.exit(0));
