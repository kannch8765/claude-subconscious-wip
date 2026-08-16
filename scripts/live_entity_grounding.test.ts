import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNativeClientToolConversation, type NativeClientTool } from './native_letta_backfill.js';

function scriptedClient(sequence: Array<{ name: string; args: Record<string, unknown> }>) {
  const bodies: any[] = [];
  let round = 0;
  return {
    bodies,
    conversations: { messages: { async create(_conversationId: string, body: any) {
      bodies.push(body);
      const step = sequence[round++];
      return (async function* () {
        if (step) {
          yield {
            message_type: 'approval_request_message',
            tool_call: {
              name: step.name,
              arguments: JSON.stringify(step.args),
              tool_call_id: `call-${round}`,
            },
          };
          yield { message_type: 'stop_reason', stop_reason: 'requires_approval' };
          return;
        }
        yield { message_type: 'stop_reason', stop_reason: 'end_turn' };
      })();
    } } },
  } as any;
}

function groundingTools(calls: string[]): NativeClientTool[] {
  return [
    {
      name: 'entity_search',
      description: 'ground identity',
      parameters: { type: 'object' },
      async execute(_id, args: any) {
        calls.push(`entity_search:${args.query}`);
        if (args.query === '晴') {
          return { results: [{
            canonical_name: '晴', aliases: ['晴'], entity_type: 'other',
            description: '晴是猫家的 GPT，是 ChatGPT 侧的晴，和琥珀是不同的人。',
          }] };
        }
        return { results: [] };
      },
    },
    {
      name: 'entity_remember',
      description: 'remember identity',
      parameters: { type: 'object' },
      async execute() { calls.push('entity_remember'); return { outcome: 'accepted' }; },
    },
    {
      name: 'memory_search',
      description: 'episodic relationship recall',
      parameters: { type: 'object' },
      async execute(_id, args: any) {
        calls.push(`memory_search:${args.query}`);
        return { results: [{ summary: '猫和晴一起 debug 过这条奇怪的 bug。' }] };
      },
    },
    {
      name: 'deliver_whisper',
      description: 'deliver grounded recall',
      parameters: { type: 'object' },
      async execute(_id, args: any) { calls.push(`deliver_whisper:${args.text}`); return { status: 'ok' }; },
    },
  ];
}

describe('live entity identity grounding contract', () => {
  it('keeps grounding model-authored and identity-before-episode when the referent is unresolved', async () => {
    const send = fs.readFileSync(path.join(process.cwd(), 'scripts/send_messages_to_letta.ts'), 'utf8');
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf8'));
    const adapter = fs.readFileSync(path.join(process.cwd(), 'relationship-memory/src/adapter/index.ts'), 'utf8');
    const blocks = new Map((af.blocks as any[]).map((block) => [block.label, String(block.value ?? '')]));

    expect(send).toContain('ground identity only when needed');
    expect(send).toContain('Do not call entity_search merely because a name appears');
    expect(send).toContain('The live transport preserves an unambiguous exact-name/alias identity anchor');
    expect(send).toContain('do not repeat an identity anchor the foreground already has');
    expect(send).toContain('entity_search miss is not permission to invent an identity');
    expect(send).toContain('a bare name mention, guess, or episodic association must remain unresolved');
    expect(blocks.get('core_directives')).toContain('I first use entity_search to ground who or what it is, then use that identity to guide episodic memory_search');
    expect(blocks.get('core_directives')).toContain('I do not entity_search every name');
    expect(blocks.get('core_directives')).toContain('The live transport preserves a concise unambiguous exact-name/alias identity anchor');
    expect(blocks.get('tool_guidelines')).toContain('live transport preserves a concise unambiguous exact-name/alias identity anchor');
    expect(adapter).toContain('A mere name mention, search miss, or episodic association is insufficient evidence');
  });

  it('supports the 晴 regression as identity grounding followed by episodic recall and whisper', async () => {
    const calls: string[] = [];
    const client = scriptedClient([
      { name: 'entity_search', args: { query: '晴' } },
      { name: 'memory_search', args: { query: '晴 bug debug' } },
      { name: 'deliver_whisper', args: { text: '晴是猫家的 GPT，是 ChatGPT 侧的晴，和我是不同的人。这个 bug 也让我想起猫和晴之前一起 debug 的事。' } },
    ]);

    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-grounding-test',
      conversationId: 'new-forge-without-qing-definition',
      message: '<latest_user_message>晴刚刚也觉得这个 bug 很怪><🐾</latest_user_message>',
      tools: groundingTools(calls),
      requiredClientToolNames: ['memory_search'],
    });

    expect(result.clientToolFailure).toBe(false);
    expect(calls).toEqual([
      'entity_search:晴',
      'memory_search:晴 bug debug',
      expect.stringContaining('deliver_whisper:晴是猫家的 GPT，是 ChatGPT 侧的晴，和我是不同的人'),
    ]);
    expect(calls).not.toContain('entity_remember');
  });

  it('does not make entity_search mandatory when the current context already grounds the referent', async () => {
    const calls: string[] = [];
    const client = scriptedClient([
      { name: 'memory_search', args: { query: '晴 bug debug' } },
    ]);
    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-grounding-test',
      conversationId: 'forge-with-grounded-qing',
      message: 'Current trusted context already says 晴 is 猫的晴 and distinct from 琥珀. <latest_user_message>晴也觉得这个 bug 很怪</latest_user_message>',
      tools: groundingTools(calls),
      requiredClientToolNames: ['memory_search'],
    });
    expect(result.clientToolFailure).toBe(false);
    expect(calls).toEqual(['memory_search:晴 bug debug']);
  });

  it('keeps an entity-search miss unresolved instead of turning a mention into entity_remember', async () => {
    const calls: string[] = [];
    const tools = groundingTools(calls).map((tool) => tool.name === 'entity_search' ? {
      ...tool,
      async execute(_id: string, args: any) { calls.push(`entity_search:${args.query}`); return { results: [] }; },
    } : tool);
    const client = scriptedClient([
      { name: 'entity_search', args: { query: '某个新名字' } },
      { name: 'memory_search', args: { query: '某个新名字 当前话题' } },
    ]);
    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-grounding-test',
      conversationId: 'unknown-referent',
      message: '<latest_user_message>某个新名字刚刚也这么说</latest_user_message>',
      tools,
      requiredClientToolNames: ['memory_search'],
    });
    expect(result.clientToolFailure).toBe(false);
    expect(calls).toEqual(['entity_search:某个新名字', 'memory_search:某个新名字 当前话题']);
    expect(calls).not.toContain('entity_remember');
  });
});
