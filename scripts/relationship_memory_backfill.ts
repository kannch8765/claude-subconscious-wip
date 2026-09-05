#!/usr/bin/env npx tsx
import { pathToFileURL } from 'url';
import { runRelationshipMemoryBackfillCli } from './relationship_memory_backfill_runner.js';

export { parseRelationshipMemoryBackfillArgs, runRelationshipMemoryBackfill } from './relationship_memory_backfill_runner.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRelationshipMemoryBackfillCli('default').catch((error) => {
    console.error(JSON.stringify({ status: 'blocked-failure', detail: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
