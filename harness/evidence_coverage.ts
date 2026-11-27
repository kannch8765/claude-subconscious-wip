/**
 * Evidence coverage (docs/specs/OWN-HARNESS-DESIGN.md §6.1): the share of a memory summary's distinctive
 * character bigrams that appear in its evidence quotes. Bigrams found in more than `commonShare` of all
 * quotes in the store are not distinctive and are ignored. Store-wide p50 is about 43 %; evidence of a
 * random other memory gives about 0 %.
 */
import { bigrams } from './quote_sampler.js';

export function commonBigrams(quotes: Iterable<string>, commonShare = 0.01): Set<string> {
  const df = new Map<string, number>();
  let docs = 0;
  for (const quote of quotes) {
    docs++;
    for (const gram of bigrams(quote ?? '')) df.set(gram, (df.get(gram) ?? 0) + 1);
  }
  return new Set([...df].filter(([, n]) => n / Math.max(1, docs) > commonShare).map(([gram]) => gram));
}

/** Undefined when the summary has fewer than five distinctive bigrams. */
export function evidenceCoverage(summary: string, quotes: string[], ignore: ReadonlySet<string>): number | undefined {
  const wanted = [...bigrams(summary ?? '')].filter((gram) => !ignore.has(gram));
  if (wanted.length < 5) return undefined;
  const have = new Set<string>();
  for (const quote of quotes) for (const gram of bigrams(quote ?? '')) have.add(gram);
  return wanted.filter((gram) => have.has(gram)).length / wanted.length;
}
