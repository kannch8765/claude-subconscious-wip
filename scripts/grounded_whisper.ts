const MAX_TRANSPORT_IDENTITY_ANCHOR_CHARS = 280;

interface GroundedEntityResult {
  entity_id?: unknown;
  canonical_name?: unknown;
  aliases?: unknown;
  description?: unknown;
}

export function normalizeEntityReferent(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

export function entityReferentTokens(value: string): string[] {
  return [...new Set(normalizeEntityReferent(value)
    .split(/[\s\p{P}\p{S}]+/u)
    .map((token) => token.trim())
    .filter(Boolean))];
}

function containsReferentTokens(queryTokens: readonly string[], referent: string): boolean {
  const referentTokens = entityReferentTokens(referent);
  if (referentTokens.length === 0 || referentTokens.length > queryTokens.length) return false;
  for (let offset = 0; offset <= queryTokens.length - referentTokens.length; offset += 1) {
    if (referentTokens.every((token, index) => queryTokens[offset + index] === token)) return true;
  }
  return false;
}

export function exactGroundedIdentityAnchors(query: unknown, toolResult: unknown): string[] {
  if (typeof query !== 'string') return [];
  const queryTokens = entityReferentTokens(query);
  if (queryTokens.length === 0) return [];
  const results = Array.isArray((toolResult as any)?.results) ? (toolResult as any).results as GroundedEntityResult[] : [];
  const matches = results.filter((item) => {
    const names = [item?.canonical_name, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
      .filter((value): value is string => typeof value === 'string');
    return names.some((name) => containsReferentTokens(queryTokens, name))
      && typeof item?.description === 'string'
      && item.description.trim().length > 0
      && item.description.trim().length <= MAX_TRANSPORT_IDENTITY_ANCHOR_CHARS;
  });
  const entityIds = new Set(matches.map((item) => typeof item.entity_id === 'string' ? item.entity_id : '').filter(Boolean));
  if (entityIds.size !== 1) return [];
  return [...new Set(matches.map((item) => String(item.description).trim()).filter(Boolean))];
}

export function composeGroundedWhisper(text: string, identityAnchors: readonly string[]): string {
  const body = text.trim();
  const anchors = [...new Set(identityAnchors.map((value) => value.trim()).filter(Boolean))]
    .filter((anchor) => !body.includes(anchor));
  return anchors.length > 0 ? `${anchors.join(' ')} ${body}` : body;
}
