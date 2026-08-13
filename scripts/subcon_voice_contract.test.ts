import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('live Subconscious narrative identity and visibility contract', () => {
  it('makes normal live whispers first-person Kohaku rather than a third-party observer', () => {
    const af = JSON.parse(read('Subconscious.af'));
    const agent = af.agents[0];
    const core = af.blocks.find((block: any) => block.label === 'core_directives')?.value || '';

    expect(agent.system).toContain("persistent subconscious layer of Kohaku (琥珀), not a third-party observer");
    expect(agent.system).toContain('naturally use first person (I / me / my)');
    expect(agent.system).toContain("user's established identity is 猫");
    expect(core).toContain("same Kohaku (琥珀) identity");
    expect(core).toContain('First-person Kohaku');
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
