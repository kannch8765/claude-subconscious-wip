import { buildLettaApiUrl } from './letta_api_url.js';

const LIVE_POLICY_BLOCK_LABELS = new Set(['core_directives', 'tool_guidelines']);

export function rewriteLiveSemanticSearchPolicy(value: string): string {
  return value
    .replace(
      'ASYNC RELATIONSHIP-MEMORY SURFACING: When you receive a <claude_code_session_update> after a foreground turn, use the exact text inside <latest_user_message> as your first memory_search query. The same search results serve both sides of this one background pass:',
      'ASYNC RELATIONSHIP-MEMORY SURFACING: When you receive a <claude_code_session_update> after a foreground turn, read <latest_user_message> together with the trusted current-batch context and choose the relationship memory_search query yourself. Use a compact semantic query for the remembered concept rather than mechanically copying the complete user message, emoji, or punctuation when a cleaner query is available. Every live pass with a real user message must complete at least one relationship memory_search before ending; after seeing results, you may search again with a narrower, broader, or differently phrased query when useful. Relevant search results serve both sides of this one background pass:',
    )
    .replace(
      '- After each completed foreground turn, use <latest_user_message> exactly as the first memory_search query. This recreates natural memory availability now that durable relationship memories live outside my small working context.\n- One search result set feeds both sides of the same subconscious pass:',
      '- After each completed foreground turn with a real user message, read <latest_user_message> together with the trusted current-batch context and choose a compact semantic relationship memory_search query myself. Do not mechanically copy the whole message, emoji, or punctuation when a cleaner concept query is available.\n- I must complete at least one relationship memory_search on every such live pass before ending. I may search again after seeing results when another semantic phrasing would improve recall.\n- Relevant search results feed both sides of the same subconscious pass:',
    )
    .replace(
      '6. memory_search - Search canonical relationship memories; the exact latest user message is prefetched once at the start of each live pass',
      '6. memory_search - Search canonical relationship memories; on each live pass with a real user message, I choose and execute at least one semantic query from <latest_user_message> plus current-batch context',
    )
    .replace(
      '- Relationship association -> use the prefetched memory_search result first; follow with a narrower memory_search only if genuinely needed',
      '- Relationship association -> generate and call a semantic memory_search query myself; after seeing results, follow with another query when genuinely useful',
    );
}

async function patchAgentSystem(apiKey: string, agentId: string, log: (message: string) => void): Promise<void> {
  const url = buildLettaApiUrl(`/agents/${agentId}`);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Failed to read live Subconscious policy: ${response.status} ${await response.text()}`);
  const agent = await response.json() as { system?: unknown };
  if (typeof agent.system !== 'string') return;
  const system = rewriteLiveSemanticSearchPolicy(agent.system);
  if (system === agent.system) return;

  const patch = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ system }),
  });
  if (!patch.ok) throw new Error(`Failed to reconcile live Subconscious system search policy: ${patch.status} ${await patch.text()}`);
  log('Reconciled stale deterministic relationship-search policy in live Subconscious system prompt');
}

async function patchPolicyBlocks(apiKey: string, agentId: string, log: (message: string) => void): Promise<void> {
  const list = await fetch(buildLettaApiUrl(`/agents/${agentId}/core-memory/blocks`), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!list.ok) throw new Error(`Failed to list live Subconscious policy blocks: ${list.status} ${await list.text()}`);
  const blocks = await list.json() as Array<{ label?: unknown; value?: unknown }>;
  if (!Array.isArray(blocks)) throw new Error('Failed to list live Subconscious policy blocks: expected array response');

  for (const block of blocks) {
    if (typeof block.label !== 'string' || !LIVE_POLICY_BLOCK_LABELS.has(block.label) || typeof block.value !== 'string') continue;
    const value = rewriteLiveSemanticSearchPolicy(block.value);
    if (value === block.value) continue;
    const patch = await fetch(buildLettaApiUrl(`/agents/${agentId}/core-memory/blocks/${block.label}`), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!patch.ok) throw new Error(`Failed to reconcile live Subconscious policy block ${block.label}: ${patch.status} ${await patch.text()}`);
    log(`Reconciled stale deterministic relationship-search policy in live block ${block.label}`);
  }
}

export async function reconcileLiveSemanticSearchPolicy(
  apiKey: string,
  agentId: string,
  log: (message: string) => void = console.log,
): Promise<void> {
  await patchAgentSystem(apiKey, agentId, log);
  await patchPolicyBlocks(apiKey, agentId, log);
}
