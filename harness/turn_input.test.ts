import { describe, expect, it } from 'vitest';
import type { CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { modelText, prepareTurn, previousTurn, ruleFor } from './turn_input.js';

let n = 0;
const msg = (role: 'user' | 'assistant', quote: string, event_kind?: string): CanonicalMessage =>
  ({ message_id: `m${++n}`, evidence_id: `e${n}`, role, quote, ...(event_kind ? { event_kind } : {}) } as unknown as CanonicalMessage);

describe('turn rules', () => {
  it('matches a bare 🫳 only', () => {
    expect(ruleFor('🫳')?.id).toBe('cache_warm');
    expect(ruleFor(' 🫳️\n')?.id).toBe('cache_warm');
    expect(ruleFor('🫳🫳')).toBeUndefined();
    expect(ruleFor('摸摸你 🫳')).toBeUndefined();
    expect(ruleFor('摸')).toBeUndefined();
  });

  it('drops a cache-warm turn with everything up to the next user text', () => {
    const kept = [msg('user', '今天好累'), msg('assistant', '辛苦啦')];
    const warm = [msg('user', '🫳'), msg('assistant', '', 'assistant_tool_use'), msg('user', '{}', 'tool_result'), msg('assistant', '🫳')];
    const turn = prepareTurn({ latestUserMessage: '今天好累', canonicalMessages: [...warm, ...kept] });
    expect(turn.canonicalMessages).toEqual(kept);
    expect(turn.dropped).toEqual({ cache_warm: 1 });
    expect(turn.empty).toBe(false);
  });

  it('falls back to the last kept user text when the latest message is dropped', () => {
    const turn = prepareTurn({ latestUserMessage: '🫳', canonicalMessages: [msg('user', '到家了'), msg('assistant', '欢迎回来'), msg('user', '🫳'), msg('assistant', '🫳')] });
    expect(turn.latestUserMessage).toBe('到家了');
    expect(turn.latest_dropped).toBe('cache_warm');
    expect(turn.empty).toBe(false);
  });

  it('is empty when only cache-warm turns are left', () => {
    const turn = prepareTurn({ latestUserMessage: '🫳', canonicalMessages: [msg('user', '🫳'), msg('assistant', '🫳')] });
    expect(turn.canonicalMessages).toEqual([]);
    expect(turn.latestUserMessage).toBe('');
    expect(turn.empty).toBe(true);
  });

  it('is empty for a sync turn whose new message is 🫳, and clears a cache-warm previous turn', () => {
    expect(prepareTurn({ latestUserMessage: '🫳', previousUserMessage: '早', previousKohakuReply: '早安' }).empty).toBe(true);
    const turn = prepareTurn({ latestUserMessage: '早', previousUserMessage: '🫳', previousKohakuReply: '🫳' });
    expect(turn).toMatchObject({ latestUserMessage: '早', previousUserMessage: '', previousKohakuReply: '', empty: false });
  });

  it('leaves turns without a match alone, even with no user text', () => {
    const messages = [msg('assistant', '在跑测试', 'assistant_tool_use')];
    const turn = prepareTurn({ latestUserMessage: '', canonicalMessages: messages });
    expect(turn.canonicalMessages).toEqual(messages);
    expect(turn.empty).toBe(false);
  });
});

describe('modelText', () => {
  it('keeps only the place of a live-location tag', () => {
    expect(modelText('在走\n<telegram_live_location latitude="1" longitude="2" place="示例町, 某某区" />')).toBe('在走\n［位置：示例町, 某某区］');
    expect(modelText('到了 <telegram_live_location latitude="1" longitude="2" />')).toBe('到了');
  });
});

describe('previousTurn', () => {
  it('skips cache-warm turns and the new message already in the transcript', () => {
    const messages = [
      { role: 'user' as const, text: '今天去了海边' },
      { role: 'assistant' as const, text: '好玩吗' },
      { role: 'assistant' as const, text: '拍照了吗' },
      { role: 'user' as const, text: '🫳' },
      { role: 'assistant' as const, text: '🫳' },
      { role: 'user' as const, text: '到家了' },
    ];
    expect(previousTurn(messages, '到家了')).toEqual({ previousUserMessage: '今天去了海边', previousKohakuReply: '好玩吗\n拍照了吗' });
    expect(previousTurn(messages.slice(0, 5), '到家了').previousUserMessage).toBe('今天去了海边');
    expect(previousTurn([], '早')).toEqual({ previousUserMessage: '', previousKohakuReply: '' });
  });
});
