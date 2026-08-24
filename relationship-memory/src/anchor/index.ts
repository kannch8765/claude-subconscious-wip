import * as crypto from 'crypto';
import * as fs from 'fs';

export interface LexicalAnchorAliasMap {
  [canonical: string]: string[];
}

export interface LexicalAnchorAnalysis {
  anchors: string[];
  context_signals: string[];
  anchor_set_sha256: string;
}

const STOPWORDS = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '的', '了', '是', '在', '有', '和', '与', '也', '就', '都', '很', '吗', '呢', '吧',
  '啊', '呀', '哦', '噢', '嗯', '呜', '哇', '嘿嘿', '哈哈', '对', '对呀', '好', '好的',
  '一个', '一下', '一点', '这样', '那样', '什么', '怎么', '为什么',
]);

const CONTEXT_SIGNALS = new Set([
  '这个', '那个', '这些', '那些', '刚刚', '刚才', '之前', '上次', '前面',
  '又', '继续', '还是', '就是', '对呀', '然后', '后来', '再', '还',
]);

function normalizeToken(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function sha256Strings(values: readonly string[]): string {
  return crypto.createHash('sha256').update([...values].sort().join('\n')).digest('hex');
}

function wordLikeSegments(query: string): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  return [...segmenter.segment(query)]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment);
}

function compoundLatinTokens(query: string): string[] {
  return query.match(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+(?:\.[A-Za-z0-9]+)?|[A-Za-z][A-Za-z0-9]{1,}/g) ?? [];
}

function isUsefulToken(value: string): boolean {
  if (!value || STOPWORDS.has(value) || CONTEXT_SIGNALS.has(value)) return false;
  if (/^\d$/.test(value)) return false;
  if (/^[\p{Script=Han}]$/u.test(value)) return false;
  return value.length >= 2;
}

export function extractLexicalAnchorAnalysis(
  query: string,
  aliases: LexicalAnchorAliasMap = {},
): LexicalAnchorAnalysis {
  const normalizedQuery = normalizeToken(query);
  const anchors: string[] = [];
  const contextSignals: string[] = [];
  const claimedAliasSpans = new Set<string>();

  for (const [canonicalRaw, variantsRaw] of Object.entries(aliases)) {
    const canonical = normalizeToken(canonicalRaw);
    if (!canonical) continue;
    const variants = [canonicalRaw, ...(Array.isArray(variantsRaw) ? variantsRaw : [])]
      .map(normalizeToken)
      .filter(Boolean);
    if (variants.some((variant) => normalizedQuery.includes(variant))) {
      anchors.push(canonical);
      for (const variant of variants) {
        claimedAliasSpans.add(variant);
        for (const token of [...wordLikeSegments(variant), ...compoundLatinTokens(variant)]) {
          claimedAliasSpans.add(normalizeToken(token));
        }
      }
    }
  }

  const segments = [...wordLikeSegments(normalizedQuery), ...compoundLatinTokens(normalizedQuery)];
  for (const raw of segments) {
    const token = normalizeToken(raw);
    if (!token) continue;
    if (CONTEXT_SIGNALS.has(token)) {
      contextSignals.push(token);
      continue;
    }
    if ([...claimedAliasSpans].some((span) => span === token)) continue;
    if (isUsefulToken(token)) anchors.push(token);
  }

  const uniqueAnchors = [...new Set(anchors)];
  const uniqueSignals = [...new Set(contextSignals)];
  return {
    anchors: uniqueAnchors,
    context_signals: uniqueSignals,
    anchor_set_sha256: sha256Strings(uniqueAnchors),
  };
}

export function readLexicalAnchorAliases(file: string | undefined): LexicalAnchorAliasMap {
  if (!file?.trim()) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file.trim(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: LexicalAnchorAliasMap = {};
    for (const [canonical, variants] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(variants)) continue;
      result[canonical] = variants.filter((value): value is string => typeof value === 'string');
    }
    return result;
  } catch {
    return {};
  }
}
