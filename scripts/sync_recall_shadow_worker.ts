#!/usr/bin/env tsx
import * as fs from 'fs';
import { appendShadowReceipt, makeShadowReceipt, runDeterministicSyncRecall } from './sync_recall.js';

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
  const result = await runDeterministicSyncRecall(payload.prompt);
  appendShadowReceipt(makeShadowReceipt(payload.session_id, payload.cwd, payload.prompt, result, payload.recorded_at));
}

main().catch(() => process.exit(0));
