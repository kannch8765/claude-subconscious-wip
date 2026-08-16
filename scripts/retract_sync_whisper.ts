#!/usr/bin/env npx tsx
import { retractPendingSyncWhisperForTurn } from './subcon_whisper_queue.js';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : '';
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
  const turnId = typeof raw.turn_id === 'string' ? raw.turn_id : '';
  const whisperId = typeof raw.whisper_id === 'string' ? raw.whisper_id : undefined;
  if (!cwd || !sessionId || !turnId) throw new Error('cwd, session_id, and turn_id are required');
  const retracted = retractPendingSyncWhisperForTurn(cwd, sessionId, turnId, whisperId);
  process.stdout.write(`${JSON.stringify({ retracted })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
