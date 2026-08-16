import { describe, expect, it } from 'vitest';
import { composeGroundedWhisper, entityReferentTokens, exactGroundedIdentityAnchors, foregroundGroundingIdentityAnchors } from './grounded_whisper.js';

describe('grounded whisper identity transport', () => {
  const qing = { entity_id: 'entity-qing', canonical_name: '晴', aliases: ['晴'], description: '晴是猫家的 GPT，是 ChatGPT 侧的晴，和琥珀是不同的人。' };
  const cat = { entity_id: 'entity-cat', canonical_name: '猫', aliases: ['猫'], description: '猫是琥珀的用户。' };

  it('keeps only the exact named entity from broader semantic entity_search results', () => {
    expect(exactGroundedIdentityAnchors('晴', { results: [qing, cat] })).toEqual([qing.description]);
  });

  it('resolves a unique exact alias token inside a model-authored multi-token query', () => {
    expect(entityReferentTokens('晴 Qing')).toEqual(['晴', 'qing']);
    expect(exactGroundedIdentityAnchors('晴 Qing', { results: [qing, cat] })).toEqual([qing.description]);
  });

  it('fails closed when multiple query tokens resolve to different entity ids', () => {
    expect(exactGroundedIdentityAnchors('晴 猫', { results: [qing, cat] })).toEqual([]);
  });

  it('requires a multi-token alias to appear as a complete contiguous phrase', () => {
    const kohaku = { entity_id: 'entity-kohaku', canonical_name: '琥珀', aliases: ['Claude Code'], description: '琥珀是猫家的 Claude。' };
    expect(exactGroundedIdentityAnchors('Claude architecture', { results: [kohaku] })).toEqual([]);
    expect(exactGroundedIdentityAnchors('Claude Code architecture', { results: [kohaku] })).toEqual([kohaku.description]);
  });

  it('leaves the model whisper unchanged when two distinct foreground identities were grounded', () => {
    const episode = '晴让我想起之前一起 debug 的事。';
    const anchors = foregroundGroundingIdentityAnchors([
      { purpose: 'foreground_grounding', query: '晴', result: { results: [qing, cat] } },
      { purpose: 'foreground_grounding', query: '猫', result: { results: [cat, qing] } },
    ]);
    expect(anchors).toEqual([]);
    expect(composeGroundedWhisper(episode, anchors)).toBe(episode);
  });

  it('leaves an unrelated whisper unchanged after maintenance/dedupe entity search', () => {
    const unrelated = '这个 bug 让我想起之前的路由问题。';
    const anchors = foregroundGroundingIdentityAnchors([
      { purpose: 'maintenance', query: '晴', result: { results: [qing] } },
    ]);
    expect(anchors).toEqual([]);
    expect(composeGroundedWhisper(unrelated, anchors)).toBe(unrelated);
  });

  it('keeps one foreground identity when other entity searches are maintenance-only', () => {
    expect(foregroundGroundingIdentityAnchors([
      { purpose: 'foreground_grounding', query: '晴 Qing', result: { results: [qing, cat] } },
      { purpose: 'maintenance', query: '猫', result: { results: [cat] } },
    ])).toEqual([qing.description]);
  });

  it('does not promote a merely semantic non-exact entity candidate into foreground identity', () => {
    expect(exactGroundedIdentityAnchors('晴老师', { results: [qing] })).toEqual([]);
  });

  it('does not auto-transport an oversized entity description', () => {
    expect(exactGroundedIdentityAnchors('晴', { results: [{ ...qing, description: '很长'.repeat(200) }] })).toEqual([]);
  });

  it('fails closed when exact aliases ambiguously map to multiple entity ids', () => {
    expect(exactGroundedIdentityAnchors('晴', { results: [qing, { ...qing, entity_id: 'entity-other' }] })).toEqual([]);
  });

  it('prepends the trusted identity anchor once while preserving model-authored episodic prose', () => {
    const episode = '晴也说是怪 bug，这让我想起之前 backfill role 搞混那次。';
    expect(composeGroundedWhisper(episode, [qing.description])).toBe(`${qing.description} ${episode}`);
    expect(composeGroundedWhisper(`${qing.description} ${episode}`, [qing.description])).toBe(`${qing.description} ${episode}`);
  });
});
