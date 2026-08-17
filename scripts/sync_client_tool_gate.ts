import { parseToolArguments, type ClientToolRoundGateContext } from './native_letta_backfill.js';

/**
 * Foreground sync tools have data dependencies that cannot be satisfied by
 * execution order within one parallel approval batch: tool arguments were
 * already authored before any result in that batch exists. Defer dependent
 * calls non-fatally and require the model to issue them again in a later round.
 */
export function syncClientToolRoundGate(context: ClientToolRoundGateContext): string | undefined {
  const foregroundEntityInBatch = context.batchRequests.some((request) => {
    if (request.name !== 'entity_search') return false;
    const args = parseToolArguments(request.arguments);
    return args?.purpose === 'foreground_grounding';
  });
  if (context.request.name === 'memory_search' && foregroundEntityInBatch) {
    return 'deferred: foreground_grounding entity_search must complete in a prior approval round so memory_search can use the resolved identity';
  }
  if (context.request.name === 'deliver_whisper') {
    if (!context.completedBeforeRound.has('memory_search')) {
      return 'deferred: deliver_whisper requires a successful memory_search result from a prior approval round';
    }
    if (foregroundEntityInBatch) {
      return 'deferred: deliver_whisper cannot consume foreground entity grounding authored in the same approval round';
    }
  }
  return undefined;
}
