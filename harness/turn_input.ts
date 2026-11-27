/**
 * Turn input (docs/specs/OWN-HARNESS-DESIGN.md §4.3.3): the one place that decides what of the conversation
 * the model sees. Both lanes get a prepared turn and hold no special cases of their own.
 *
 *   - Turn rules drop whole turns that are not conversation. A turn is one user text and everything after
 *     it up to the next user text. Dropped turns never reach the model and never become citable evidence.
 *   - modelText() rewrites text the model reads (conversation, memory summaries, quotes). The store keeps
 *     the original.
 *
 * The caller skips the pass when a prepared turn is empty, and records `dropped` in the trace.
 */
import type { CanonicalMessage } from '../relationship-memory/src/schema/index.js';

export interface TurnRule {
  id: string;
  description: string;
  matches(userText: string): boolean;
}

export const TURN_RULES: readonly TurnRule[] = [
  {
    id: 'cache_warm',
    description: 'A bare 🫳 keeps the prompt cache warm; it is not a message to Kohaku.',
    matches: (text) => text.replace(/️/g, '').trim() === '🫳',
  },
];

export interface RawTurn {
  latestUserMessage: string;
  canonicalMessages?: CanonicalMessage[];
  previousUserMessage?: string;
  previousKohakuReply?: string;
}

export interface TurnPreparation {
  /** Turns dropped from canonicalMessages, per rule. */
  dropped: Record<string, number>;
  /** Rule that dropped the latest user message, if any. */
  latest_dropped?: string;
  /** The rules left nothing to look at: the caller skips the pass. */
  empty: boolean;
}

export function ruleFor(userText: string): TurnRule | undefined {
  return TURN_RULES.find((rule) => rule.matches(userText ?? ''));
}

function isUserText(message: CanonicalMessage): boolean {
  return message.role === 'user' && (message.event_kind ?? 'user_text') === 'user_text';
}

export function prepareTurn<T extends RawTurn>(turn: T): T & TurnPreparation {
  const dropped: Record<string, number> = {};
  let kept = turn.canonicalMessages;
  if (kept) {
    kept = [];
    let dropping: TurnRule | undefined;
    for (const message of turn.canonicalMessages!) {
      if (isUserText(message)) {
        dropping = ruleFor(message.quote);
        if (dropping) dropped[dropping.id] = (dropped[dropping.id] ?? 0) + 1;
      }
      if (!dropping) kept.push(message);
    }
  }
  const latestRule = ruleFor(turn.latestUserMessage);
  // A dropped latest message falls back to the last kept user text of the batch.
  const latest = latestRule ? ([...(kept ?? [])].reverse().find(isUserText)?.quote ?? '') : turn.latestUserMessage;
  const previousDropped = turn.previousUserMessage !== undefined && ruleFor(turn.previousUserMessage) !== undefined;
  const prepared: T & TurnPreparation = {
    ...turn,
    latestUserMessage: latest,
    ...(kept ? { canonicalMessages: kept } : {}),
    ...(previousDropped ? { previousUserMessage: '', previousKohakuReply: '' } : {}),
    dropped,
    ...(latestRule ? { latest_dropped: latestRule.id } : {}),
    empty: (Object.keys(dropped).length > 0 || latestRule !== undefined) && (kept ? !kept.some(isUserText) : !latest.trim()),
  };
  return prepared;
}

/**
 * Text as the model sees it. Live-location tags carry coordinates, accuracy and
 * heading the model cannot use, and in a short message they are most of the
 * text, so searches drift to other memories that also hold such a tag. Keep only
 * the reverse-geocoded place; drop the tag when there is none.
 */
export function modelText(text: string): string {
  return text
    .replace(/<telegram_live_location\b[^>]*?\bplace="([^"]*)"[^>]*\/?>/g, (_m, place: string) => `［位置：${place}］`)
    .replace(/<telegram_live_location\b[^>]*\/?>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
