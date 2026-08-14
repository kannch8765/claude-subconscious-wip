import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { rewriteLiveSemanticSearchPolicy } from './live_semantic_search_policy.js';

describe('live semantic relationship-search policy migration', () => {
  it('rewrites the adopted AgentFile exact-message/prefetch policy without touching runtime configuration', () => {
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf8'));
    const agent = af.agents[0];
    const before = JSON.stringify({
      model: agent.model,
      embedding: agent.embedding,
      model_settings: agent.model_settings,
      tool_ids: agent.tool_ids,
    });

    const system = rewriteLiveSemanticSearchPolicy(agent.system as string);
    expect(system).toContain('choose the relationship memory_search query yourself');
    expect(system).toContain('compact semantic query');
    expect(system).toContain('must complete at least one relationship memory_search');
    expect(system).toContain('you may search again');
    expect(system).not.toContain('use the exact text inside <latest_user_message> as your first memory_search query');

    const blocks = new Map((af.blocks as any[]).map((block) => [block.label, rewriteLiveSemanticSearchPolicy(String(block.value ?? ''))]));
    expect(blocks.get('core_directives')).toContain('choose a compact semantic relationship memory_search query myself');
    expect(blocks.get('core_directives')).not.toContain('use <latest_user_message> exactly as the first memory_search query');
    expect(blocks.get('tool_guidelines')).toContain('I choose and execute at least one semantic query');
    expect(blocks.get('tool_guidelines')).not.toContain('the exact latest user message is prefetched once');

    const after = JSON.stringify({
      model: agent.model,
      embedding: agent.embedding,
      model_settings: agent.model_settings,
      tool_ids: agent.tool_ids,
    });
    expect(after).toBe(before);
  });

  it('is idempotent after the stale policy has been migrated', () => {
    const source = 'ASYNC RELATIONSHIP-MEMORY SURFACING: When you receive a <claude_code_session_update> after a foreground turn, use the exact text inside <latest_user_message> as your first memory_search query. The same search results serve both sides of this one background pass:';
    const once = rewriteLiveSemanticSearchPolicy(source);
    expect(rewriteLiveSemanticSearchPolicy(once)).toBe(once);
  });
});
