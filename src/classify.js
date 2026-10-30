import { extractHashtags, normalize, removeHashtags } from './normalize.js';

// Letters, digits, or underscore in any script; used for word boundaries,
// since \b only understands ASCII.
const WORD_CHAR = '[\\p{L}\\p{N}_]';

function escapeRegex(text) {
  // Only syntax characters: the `u` flag rejects needless escapes such as \-.
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function compileKeywords(keywords) {
  const terms = [...new Set(keywords.map(normalize).filter(Boolean))];
  if (terms.length === 0) return null;
  // Escape each word, then let any run of whitespace stand in for a space.
  const alternatives = terms.map((term) => term.split(' ').map(escapeRegex).join('\\s+'));
  return new RegExp(`(?<!${WORD_CHAR})(?:${alternatives.join('|')})(?!${WORD_CHAR})`, 'u');
}

// Compile once per run. Rules keep the config's order; that order decides
// which category wins.
export function compileRules(config) {
  return config.categories.map((category) => ({
    name: category.name,
    hashtags: new Set(category.hashtags.map(normalize)),
    keywords: compileKeywords(category.keywords),
    media: new Set(category.media.map(normalize)),
  }));
}

export function classify(rules, fallback, item) {
  const caption = normalize(item.caption);
  const tags = extractHashtags(caption);
  const text = removeHashtags(caption);
  const type = normalize(item.type);

  for (const rule of rules) {
    if (tags.some((tag) => rule.hashtags.has(tag))) return rule.name;
    if (rule.keywords?.test(text)) return rule.name;
    if (rule.media.has(type)) return rule.name;
  }
  return fallback;
}

export function createClassifier(config) {
  const rules = compileRules(config);
  return (item) => classify(rules, config.fallback, item);
}
