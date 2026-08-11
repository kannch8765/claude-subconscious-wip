from pathlib import Path

semantic = Path('relationship-memory/src/legacy/semantic.ts')
s = semantic.read_text()
s = s.replace("export interface LegacySemanticReceipt {\n  schema_version: 1;", "export interface LegacySemanticReceipt {\n  schema_version: 1;\n  attempt?: number;")
s = s.replace("export interface LegacySemanticProcessorResult {\n  completion: LegacySemanticCompletion;\n  reason?: string;\n}", "export interface LegacySemanticProcessorResult {\n  completion: LegacySemanticCompletion;\n  reason?: string;\n  retry_class?: 'zero_mutation_missing_completion';\n}")
needle = "function remainingCount(sources: LegacyAssistantMemorySourceRecord[], processed: Set<string>, selected?: Set<string>): number {\n  return sources.filter((source) => (!selected || selected.has(source.legacy_source_id)) && !processed.has(source.legacy_source_id)).length;\n}\n"
insert = needle + "\nconst LEGACY_ZERO_MUTATION_MAX_ATTEMPTS = 2;\n\nfunction semanticMutationFingerprint(legacyStore: LegacyMemorySourceStore, canonicalStore: RelationshipMemoryStore): string {\n  return stableId('legacy_semantic_mutation_snapshot', {\n    memories: canonicalStore.listMemories(),\n    evidence: canonicalStore.listEvidence(),\n    reinforcements: canonicalStore.listReinforcements(),\n    provenance: legacyStore.listProvenance(),\n  });\n}\n\nfunction nextReceiptAttempt(rootDir: string, sourceId: string, manifestDigest: string, canonicalSubjectId: string): number {\n  return listLegacySemanticReceipts(rootDir).filter((item) =>\n    item.legacy_source_id === sourceId && item.manifest_digest === manifestDigest && item.canonical_subject_id === canonicalSubjectId\n  ).length + 1;\n}\n"
if needle not in s:
    raise SystemExit('semantic helper insertion point missing')
s = s.replace(needle, insert)
old = """    const batchId = legacySemanticBatchId(manifestDigest, source.legacy_source_id, canonicalSubjectId);
    const result = await options.processor(source, batchId);
    const provenance = provenanceForSubject(legacyStore, canonicalStore, canonicalSubjectId, source.legacy_source_id);
    let failure: string | undefined;
    if (result.completion === 'completed' && provenance.length === 0) failure = 'observer completed without canonical provenance';
    if (result.completion === 'no_memory_required' && provenance.length > 0) failure = 'observer returned no_memory_required after canonical provenance was written';
    const effectiveCompletion: LegacySemanticCompletion = failure ? 'retryable_failure' : result.completion;
    const memoryIds = [...new Set(provenance.map((item) => item.canonical_memory_id))].sort();
    const provenanceIds = provenance.map((item) => item.provenance_id).sort();
    const receiptCore = {
      manifest_digest: manifestDigest,
      canonical_subject_id: canonicalSubjectId,
      legacy_source_id: source.legacy_source_id,
      batch_id: batchId,
      result: effectiveCompletion,
      provenance_ids: provenanceIds,
      memory_ids: memoryIds,
      ...((failure ?? result.reason) ? { reason: failure ?? result.reason } : {}),
    } as const;
    const receipt: LegacySemanticReceipt = {
      schema_version: 1,
      receipt_id: receiptId(receiptCore),
      ...receiptCore,
      recorded_at: new Date().toISOString(),
    };

    if (effectiveCompletion === 'retryable_failure') {
      legacyStore.withMutationBoundary(() => appendSemanticReceipt(rootDir, receipt));
      return {
        status: 'blocked-failure', manifest_digest: manifestDigest, processed: completedCount,
        remaining: remainingCount(sources, processed, selected), source_id: source.legacy_source_id,
        detail: receipt.reason ?? 'legacy semantic observer retryable failure',
      };
    }

    legacyStore.withMutationBoundary(() => {
      appendSemanticReceipt(rootDir, receipt);
      const latestState = loadLegacySemanticState(statePath, manifestDigest, canonicalSubjectId);
      if (!latestState.processed_source_ids.includes(source.legacy_source_id)) {
        latestState.processed_source_ids.push(source.legacy_source_id);
        saveLegacySemanticState(statePath, latestState);
      }
      state.processed_source_ids = latestState.processed_source_ids;
      processed.add(source.legacy_source_id);
    });
    completedCount += 1;
"""
new = """    const batchId = legacySemanticBatchId(manifestDigest, source.legacy_source_id, canonicalSubjectId);
    let sourceCompleted = false;
    for (let attemptInRun = 1; attemptInRun <= LEGACY_ZERO_MUTATION_MAX_ATTEMPTS; attemptInRun += 1) {
      const beforeMutation = semanticMutationFingerprint(legacyStore, canonicalStore);
      const result = await options.processor(source, batchId);
      const afterMutation = semanticMutationFingerprint(legacyStore, canonicalStore);
      const provenance = provenanceForSubject(legacyStore, canonicalStore, canonicalSubjectId, source.legacy_source_id);
      let failure: string | undefined;
      if (result.completion === 'completed' && provenance.length === 0) failure = 'observer completed without canonical provenance';
      if (result.completion === 'no_memory_required' && provenance.length > 0) failure = 'observer returned no_memory_required after canonical provenance was written';
      const effectiveCompletion: LegacySemanticCompletion = failure ? 'retryable_failure' : result.completion;
      const memoryIds = [...new Set(provenance.map((item) => item.canonical_memory_id))].sort();
      const provenanceIds = provenance.map((item) => item.provenance_id).sort();
      const receiptCore = {
        attempt: nextReceiptAttempt(rootDir, source.legacy_source_id, manifestDigest, canonicalSubjectId),
        manifest_digest: manifestDigest,
        canonical_subject_id: canonicalSubjectId,
        legacy_source_id: source.legacy_source_id,
        batch_id: batchId,
        result: effectiveCompletion,
        provenance_ids: provenanceIds,
        memory_ids: memoryIds,
        ...((failure ?? result.reason) ? { reason: failure ?? result.reason } : {}),
      } as const;
      const receipt: LegacySemanticReceipt = {
        schema_version: 1,
        receipt_id: receiptId(receiptCore),
        ...receiptCore,
        recorded_at: new Date().toISOString(),
      };

      if (effectiveCompletion === 'retryable_failure') {
        legacyStore.withMutationBoundary(() => appendSemanticReceipt(rootDir, receipt));
        const safeZeroMutationRetry = result.retry_class === 'zero_mutation_missing_completion' && beforeMutation === afterMutation;
        if (safeZeroMutationRetry && attemptInRun < LEGACY_ZERO_MUTATION_MAX_ATTEMPTS) continue;
        return {
          status: 'blocked-failure', manifest_digest: manifestDigest, processed: completedCount,
          remaining: remainingCount(sources, processed, selected), source_id: source.legacy_source_id,
          detail: receipt.reason ?? 'legacy semantic observer retryable failure',
        };
      }

      legacyStore.withMutationBoundary(() => {
        appendSemanticReceipt(rootDir, receipt);
        const latestState = loadLegacySemanticState(statePath, manifestDigest, canonicalSubjectId);
        if (!latestState.processed_source_ids.includes(source.legacy_source_id)) {
          latestState.processed_source_ids.push(source.legacy_source_id);
          saveLegacySemanticState(statePath, latestState);
        }
        state.processed_source_ids = latestState.processed_source_ids;
        processed.add(source.legacy_source_id);
      });
      completedCount += 1;
      sourceCompleted = true;
      break;
    }
    if (!sourceCompleted) throw new Error(`legacy semantic retry loop exited without terminal result: ${source.legacy_source_id}`);
"""
if old not in s:
    raise SystemExit('semantic runner block missing')
s = s.replace(old, new)
semantic.write_text(s)

runner = Path('scripts/legacy_semantic_observer_runner.ts')
s = runner.read_text()
s = s.replace("  let toolRetryableFailure = false;", "  let toolRetryableFailure = false;\n  let toolPermanentlyRejected = false;")
s = s.replace("      if (result?.outcome === 'retryable_failed') toolRetryableFailure = true;", "      if (result?.outcome === 'retryable_failed') toolRetryableFailure = true;\n      if (result?.outcome === 'permanently_rejected') toolPermanentlyRejected = true;")
old = """  if (retryable) return { completion: 'retryable_failure', reason: !completion ? 'observer ended without explicit legacy_source_complete' : 'observer/tool session retryable failure' };
  return { completion };
}"""
new = """  if (retryable) {
    const pureMissingCompletion = !completion && sessionSucceeded && !toolRetryableFailure && !toolPermanentlyRejected;
    return {
      completion: 'retryable_failure',
      reason: !completion
        ? (toolPermanentlyRejected ? 'observer ended after permanently rejected legacy mutation tool call' : 'observer ended without explicit legacy_source_complete')
        : 'observer/tool session retryable failure',
      ...(pureMissingCompletion ? { retry_class: 'zero_mutation_missing_completion' as const } : {}),
    };
  }
  return { completion };
}"""
if old not in s:
    raise SystemExit('observer return block missing')
s = s.replace(old, new)
runner.write_text(s)

test = Path('relationship-memory/tests/legacy-semantic-migration.test.ts')
s = test.read_text()
needle = "  it('redacts source credentials before observation and hard-rejects credential-bearing canonical proposals', () => {\n"
block = """  it('auto-retries a classified zero-mutation missing-completion attempt and then continues to the next source', async () => {
    const root = temp(); const a = source('auto-retry-a'); const b = source('auto-retry-b'); seed(root, a, b);
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    const result = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject, maxRecords: 2,
      processor: async (item) => {
        calls.push(item.legacy_source_id);
        const attempt = (attempts.get(item.legacy_source_id) ?? 0) + 1;
        attempts.set(item.legacy_source_id, attempt);
        if (item.legacy_source_id === a.legacy_source_id && attempt === 1) {
          return { completion: 'retryable_failure', reason: 'observer ended without explicit legacy_source_complete', retry_class: 'zero_mutation_missing_completion' };
        }
        return { completion: 'no_memory_required' };
      },
    });
    expect(result.status).toBe('completed');
    expect(calls).toEqual([a.legacy_source_id, a.legacy_source_id, b.legacy_source_id]);
    expect(listLegacySemanticReceipts(root).map((receipt) => [receipt.legacy_source_id, receipt.result, receipt.attempt])).toEqual([
      [a.legacy_source_id, 'retryable_failure', 1],
      [a.legacy_source_id, 'no_memory_required', 2],
      [b.legacy_source_id, 'no_memory_required', 1],
    ]);
    expect(loadLegacySemanticState(path.join(root, 'legacy-semantic-migration-state.json'), manifest, canonicalSubject).processed_source_ids).toEqual([a.legacy_source_id, b.legacy_source_id]);

    const resumed = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => { throw new Error('completed sources must not be reprocessed'); },
    });
    expect(resumed.status).toBe('no-op');
  });

  it('bounds repeated zero-mutation missing-completion retries and remains resumable', async () => {
    const root = temp(); const s = source('auto-retry-bounded'); seed(root, s);
    let calls = 0;
    const blocked = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => {
        calls += 1;
        return { completion: 'retryable_failure', reason: 'observer ended without explicit legacy_source_complete', retry_class: 'zero_mutation_missing_completion' };
      },
    });
    expect(blocked.status).toBe('blocked-failure');
    expect(calls).toBe(2);
    expect(listLegacySemanticReceipts(root).map((receipt) => [receipt.result, receipt.attempt])).toEqual([['retryable_failure', 1], ['retryable_failure', 2]]);
    expect(loadLegacySemanticState(path.join(root, 'legacy-semantic-migration-state.json'), manifest, canonicalSubject).processed_source_ids).toEqual([]);

    const resumed = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => ({ completion: 'no_memory_required' }),
    });
    expect(resumed.status).toBe('completed');
    expect(listLegacySemanticReceipts(root).map((receipt) => receipt.attempt)).toEqual([1, 2, 3]);
  });

  it('does not auto-retry a classified failure when canonical or provenance mutation occurred', async () => {
    const root = temp(); const s = source('auto-retry-mutated'); seed(root, s);
    let calls = 0;
    const result = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async (item, batchId) => {
        calls += 1;
        const runtime = new LegacySemanticMutationRuntime(root, canonicalSubject, item, batchId, () => '2026-08-11T00:00:00Z');
        expect(runtime.createMemory(sharedProposal('自动重试边界')).outcome).toBe('created');
        return { completion: 'retryable_failure', reason: 'observer ended without explicit legacy_source_complete', retry_class: 'zero_mutation_missing_completion' };
      },
    });
    expect(result.status).toBe('blocked-failure');
    expect(calls).toBe(1);
    expect(new RelationshipMemoryStore(root, canonicalSubject).listMemories()).toHaveLength(1);
    expect(new LegacyMemorySourceStore(root).listProvenance()).toHaveLength(1);
  });

  it('does not auto-retry unclassified zero-mutation failures', async () => {
    const root = temp(); const s = source('auto-retry-unclassified'); seed(root, s);
    let calls = 0;
    const result = await runLegacySemanticMigration({
      rootDir: root, expectedManifestDigest: manifest, canonicalSubjectId: canonicalSubject,
      processor: async () => { calls += 1; return { completion: 'retryable_failure', reason: 'observer/tool session retryable failure' }; },
    });
    expect(result.status).toBe('blocked-failure');
    expect(calls).toBe(1);
  });

"""
if needle not in s:
    raise SystemExit('test insertion point missing')
s = s.replace(needle, block + needle)
test.write_text(s)
