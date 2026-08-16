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

interface GroundedIdentityMatch {
  entityId: string;
  description: string;
}

export interface EntitySearchObservation {
  purpose: unknown;
  query: unknown;
  result: unknown;
}

function groundedIdentityCandidates(query: unknown, toolResult: unknown): GroundedIdentityMatch[] {
  if (typeof query !== 'string') return [];
  const queryTokens = entityReferentTokens(query);
  if (queryTokens.length === 0) return [];
  const results = Array.isArray((toolResult as any)?.results) ? (toolResult as any).results as GroundedEntityResult[] : [];
  return results.flatMap((item): GroundedIdentityMatch[] => {
    const names = [item?.canonical_name, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
      .filter((value): value is string => typeof value === 'string');
    const entityId = typeof item?.entity_id === 'string' ? item.entity_id.trim() : '';
    const description = typeof item?.description === 'string' ? item.description.trim() : '';
    if (!entityId || !description || description.length > MAX_TRANSPORT_IDENTITY_ANCHOR_CHARS) return [];
    if (!names.some((name) => containsReferentTokens(queryTokens, name))) return [];
    return [{ entityId, description }];
  });
}

function exactGroundedIdentityMatches(query: unknown, toolResult: unknown): GroundedIdentityMatch[] {
  const matches = groundedIdentityCandidates(query, toolResult);
  const entityIds = new Set(matches.map((item) => item.entityId));
  return entityIds.size === 1 ? matches : [];
}

export function exactGroundedIdentityAnchors(query: unknown, toolResult: unknown): string[] {
  return [...new Set(exactGroundedIdentityMatches(query, toolResult).map((item) => item.description))];
}

export function foregroundGroundingIdentityAnchors(observations: readonly EntitySearchObservation[]): string[] {
  const identities = new Map<string, string>();
  for (const observation of observations) {
    if (observation.purpose !== 'foreground_grounding') continue;
    for (const match of groundedIdentityCandidates(observation.query, observation.result)) {
      identities.set(match.entityId, match.description);
    }
  }
  return identities.size === 1 ? [...identities.values()] : [];
}

export function composeGroundedWhisper(text: string, identityAnchors: readonly string[]): string {
  const body = text.trim();
  const anchors = [...new Set(identityAnchors.map((value) => value.trim()).filter(Boolean))]
    .filter((anchor) => !body.includes(anchor));
  return anchors.length > 0 ? `${anchors.join(' ')} ${body}` : body;
}
