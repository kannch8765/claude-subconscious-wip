import * as fs from 'fs';
import {
  LegacyMemorySourceStore,
  buildLegacyManifest,
  parseLegacySource,
  runLegacyImport,
} from '../src/legacy/index.js';

const [mode, sourceRoot, storeDir, startFile] = process.argv.slice(2);
if (!mode || !sourceRoot || !storeDir || !startFile) throw new Error('mode, sourceRoot, storeDir, and startFile are required');

while (!fs.existsSync(startFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

if (mode === 'provenance') {
  const manifest = buildLegacyManifest(sourceRoot);
  const source = parseLegacySource(sourceRoot, manifest.entries[0], manifest.manifest_digest, 'subject-kohaku');
  const store = new LegacyMemorySourceStore(storeDir);
  const sourceResult = store.appendSource(source);
  const link = store.appendProvenance({
    legacy_source_id: source.legacy_source_id,
    canonical_memory_id: 'mem-shared',
    disposition: 'duplicate_link',
    recorded_at: '2026-08-10T00:00:00.000Z',
  });
  process.stdout.write(JSON.stringify({ sourceResult, provenanceId: link.provenance_id }));
} else if (mode === 'import-one') {
  process.stdout.write(JSON.stringify(runLegacyImport({ rootDir: sourceRoot, storeDir, subjectId: 'subject-kohaku', maxRecords: 1 })));
} else if (mode === 'import-two') {
  process.stdout.write(JSON.stringify(runLegacyImport({ rootDir: sourceRoot, storeDir, subjectId: 'subject-kohaku', maxRecords: 2 })));
} else {
  throw new Error(`unknown mode: ${mode}`);
}
