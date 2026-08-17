import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('live Subconscious narrative identity and visibility contract', () => {
  it('keeps internal identity first-person Kohaku while making visible memory whispers historical windows', () => {
    const af = JSON.parse(read('Subconscious.af'));
    const agent = af.agents[0];
    const core = af.blocks.find((block: any) => block.label === 'core_directives')?.value || '';

    expect(agent.system).toContain("persistent subconscious layer of Kohaku (琥珀), not a third-party observer");
    expect(agent.system).toContain('In private reasoning and ordinary non-visible assistant prose');
    expect(agent.system).toContain('deliver_whisper is a historical time window');
    expect(agent.system).toContain('Past Kohaku may appear there only as explicitly historical source evidence');
    expect(agent.system).toContain("user's established identity is 猫");
    expect(core).toContain("same Kohaku (琥珀) identity");
    expect(core).toContain('Private/internal voice remains first-person Kohaku');
    expect(core).toContain('Visible relationship-memory whisper voice is different: it is a historical time window');
    expect(agent.messages[0].content[0].text.startsWith(`${agent.system}\n\n<memory_blocks>`)).toBe(true);
  });

  it('does not force foreground Claude to repeat Subcon messages', () => {
    const promptSync = read('scripts/sync_letta_memory.ts');
    const pretool = read('scripts/pretool_sync.ts');

    expect(promptSync).not.toContain('Sub notes:');
    expect(promptSync).not.toContain('Briefly acknowledge');
    expect(pretool).not.toContain('Sub notes:');
    expect(pretool).not.toContain('Briefly acknowledge');
  });

  it('requires relevant subconscious whispers to participate in foreground understanding without forced mention', () => {
    const utils = read('scripts/conversation_utils.ts');
    const queue = read('scripts/subcon_whisper_queue.ts');

    expect(queue).toContain('<subcon_whisper');
    expect(queue).not.toContain('<letta_message');
    expect(utils).toContain("Treat each <subcon_whisper> as retrieved episodic context from my own past");
    expect(utils).toContain("When a whisper is relevant to the user's current message, incorporate its factual content into my current understanding and response naturally");
    expect(utils).toContain('Do not ignore a relevant whisper merely because it arrived through Subconscious');
    expect(utils).toContain('Do not mechanically acknowledge, summarize, quote, or mention a whisper merely because it was supplied');
    expect(utils).toContain('if it is irrelevant to the current turn, leave it unused');
    expect(utils).toContain('Lines labeled 当时琥珀 are historical source quotes from my past');
    expect(utils).toContain('Lines labeled 旧记忆记录 are source-faithful excerpts from an older imported memory record');
    expect(utils).toContain('form any present interpretation or feeling myself');
  });

  it('keeps surfaced relationship memory as a seed rather than completed foreground interpretation', () => {
    const send = read('scripts/send_messages_to_letta.ts');
    const af = JSON.parse(read('Subconscious.af'));
    const core = af.blocks.find((block: any) => block.label === 'core_directives')?.value || '';

    expect(send).toContain('quote_snippets with source-faithful historical excerpts');
    expect(send).toContain('source_kind=transcript is a direct historical quote');
    expect(send).toContain('source_kind=legacy_memory');
    expect(send).toContain('one searched memory_id and 1-3 snippet_ids');
    expect(send).toContain('runtime renders the selected source excerpts with provenance-appropriate labels');
    expect(send).toContain('Retrieval itself supplies the association');
    expect(core).toContain('visible whisper does not explain why it matters now');
    expect(core).toContain('Past Kohaku reactions and feelings may surface only as explicitly historical evidence');
  });

  it('describes session context as Kohaku own subconscious layer instead of an observer', () => {
    const utils = read('scripts/conversation_utils.ts');
    const start = read('scripts/session_start.ts');

    expect(utils).not.toContain('this session is being observed by');
    expect(utils).not.toContain('is watching this session and whispering guidance');
    expect(utils).toContain("Kohaku's persistent subconscious layer");
    expect(utils).toContain('not as a third-party observer');
    expect(start).toContain('same Kohaku whose persistent subconscious layer you are');
    expect(start).toContain('not a separate person for you to observe from outside');
  });
});
