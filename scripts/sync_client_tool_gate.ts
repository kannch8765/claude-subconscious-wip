import { parseToolArguments, type ClientToolRoundGateContext } from './native_letta_backfill.js';

/**
 * The prefetched recall bundle exists before round 1, so resolve_recall can
 * consume it immediately. Same-round entity grounding or expand_recall results
 * did not exist when resolve arguments were authored and therefore must finish
 * in a prior approval round.
 */
export function syncClientToolRoundGate(context: ClientToolRoundGateContext): string | undefined {
  const foregroundEntityInBatch = context.batchRequests.some((request) => {
    if (request.name !== 'entity_search') return false;
    const args = parseToolArguments(request.arguments);
    return args?.purpose === 'foreground_grounding';
  });
  const expandRecallInBatch = context.batchRequests.some((request) => request.name === 'expand_recall');
  if (context.request.name === 'expand_recall' && foregroundEntityInBatch) {
    return 'deferred: foreground_grounding entity_search must complete in a prior approval round before optional recall expansion';
  }
  if (context.request.name === 'resolve_recall') {
    if (foregroundEntityInBatch) {
      return 'deferred: resolve_recall cannot consume foreground entity grounding authored in the same approval round';
    }
    if (expandRecallInBatch) {
      return 'deferred: resolve_recall cannot consume expand_recall results authored in the same approval round';
    }
  }
  return undefined;
}
