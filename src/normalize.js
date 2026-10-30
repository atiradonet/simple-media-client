// Text normalization shared by captions and rule terms, so both sides of every
// comparison went through the same steps.

const COMBINING_MARKS = /\p{M}/gu;
const WHITESPACE = /\s+/gu;
// A hashtag is # followed by letters, digits, or underscore, in any script.
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(WHITESPACE, ' ')
    .trim();
}

// Expects normalized text. Returns tags without the #, in order of appearance.
export function extractHashtags(normalized) {
  return [...normalized.matchAll(HASHTAG)].map((match) => match[1]);
}

// Expects normalized text. Keywords match against what is left, so a hashtag
// is not counted twice.
export function removeHashtags(normalized) {
  return normalized.replace(HASHTAG, ' ').replace(WHITESPACE, ' ').trim();
}
