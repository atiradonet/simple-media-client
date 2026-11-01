import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileRules, createClassifier } from '../../src/classify.js';
import { parseConfig } from '../../src/config.js';

function category(name, { hashtags = [], keywords = [], media = [] } = {}) {
  return { name, hashtags, keywords, media };
}

// Mirrors the example config, plus categories for the edge cases below.
const CONFIG = {
  fallback: 'Everyday',
  categories: [
    category('Travel', { hashtags: ['travel', 'wanderlust', '東京'], keywords: ['airport', 'flight', 'hotel', 'road trip'] }),
    category('Food', { hashtags: ['foodie', 'recipe'], keywords: ['dinner', 'brunch', 'Café'] }),
    category('Art', { keywords: ['art'] }),
    category('Code', { keywords: ['c++', 'q&a', 'node.js', 'self-care'] }),
    category('Video', { media: ['reel', 'video'] }),
  ],
};

const classify = createClassifier(CONFIG);

// [description, caption, type, expected category]
const CASES = [
  ['hashtag hit', 'sunset #wanderlust', 'photo', 'Travel'],
  ['keyword hit', 'Late dinner with friends', 'photo', 'Food'],
  ['media-only hit', 'just vibes', 'reel', 'Video'],
  ['no hit goes to fallback', 'just vibes', 'photo', 'Everyday'],
  ['first match wins over a later category', 'airport #foodie', 'reel', 'Travel'],
  ['earlier category beats a later media rule', 'brunch', 'video', 'Food'],
  ['accent folding: rule Café matches caption cafe', 'morning cafe run', 'photo', 'Food'],
  ['accent folding: rule airport matches caption AÍRPORT', 'AÍRPORT', 'photo', 'Travel'],
  ['case folding on hashtags', '#TRAVEL', 'photo', 'Travel'],
  ['accented hashtag folds', '#Wänderlust', 'photo', 'Travel'],
  ['Unicode hashtag', '週末 #東京', 'photo', 'Travel'],
  ['exact hashtag only: #travelgram does not match travel', '#travelgram', 'photo', 'Everyday'],
  ['hashtag text does not count as a keyword', '#dinner', 'photo', 'Everyday'],
  ['multi-word keyword with irregular whitespace', 'epic road \t\n  trip', 'photo', 'Travel'],
  ['keyword inside another word does not match', 'great party', 'photo', 'Everyday'],
  ['keyword at word boundary next to punctuation', 'modern art!', 'photo', 'Art'],
  ['keyword next to a non-ASCII letter does not match', 'éart', 'photo', 'Everyday'],
  ['regex metacharacters: c++', 'learning c++ today', 'photo', 'Code'],
  ['regex metacharacters: c++ is not c followed by anything', 'learning cxx today', 'photo', 'Everyday'],
  ['regex metacharacters: q&a', 'live Q&A tonight', 'photo', 'Code'],
  ['regex metacharacters: dot is literal', 'nodexjs', 'photo', 'Everyday'],
  ['hyphenated keyword', 'sunday self-care', 'photo', 'Code'],
  ['empty caption with media rule', '', 'video', 'Video'],
  ['empty caption without media rule', '', 'photo', 'Everyday'],
  ['whitespace-only caption', ' \n\t ', 'carousel', 'Everyday'],
  ['missing caption', undefined, 'reel', 'Video'],
  ['very long caption still matches at the end', `${'lorem ipsum '.repeat(200)}hotel`, 'photo', 'Travel'],
];

for (const [description, caption, type, expected] of CASES) {
  test(`classify: ${description}`, () => {
    assert.equal(classify({ caption, type }), expected);
  });
}

test('the long-caption case is over 2,200 characters', () => {
  assert.ok(CASES.find(([d]) => d.startsWith('very long'))[1].length > 2200);
});

test('reordering the file changes the result', () => {
  const item = { caption: 'airport #foodie', type: 'photo' };
  const reversed = createClassifier({ ...CONFIG, categories: [...CONFIG.categories].reverse() });
  assert.equal(classify(item), 'Travel');
  assert.equal(reversed(item), 'Food');
});

test('no categories means everything goes to fallback', () => {
  const none = createClassifier({ fallback: 'All', categories: [] });
  assert.equal(none({ caption: '#travel', type: 'reel' }), 'All');
});

test('compileRules skips empty keyword lists and normalizes terms', () => {
  const [rule] = compileRules({ categories: [category('X', { hashtags: ['Café'], media: ['Reel'] })] });
  assert.equal(rule.keywords, null);
  assert.deepEqual([...rule.hashtags], ['cafe']);
  assert.deepEqual([...rule.media], ['reel']);
});

test('compileRules deduplicates keywords that normalize to the same text', () => {
  const [rule] = compileRules({ categories: [category('X', { keywords: ['Café', 'cafe', 'CAFE'] })] });
  assert.equal(rule.keywords.source, '(?<![\\p{L}\\p{N}_])(?:cafe)(?![\\p{L}\\p{N}_])');
});

test('determinism: same input twice, and shuffled order, gives the same result per item', () => {
  const items = CASES.map(([, caption, type], i) => ({ id: String(i), caption, type }));
  const first = new Map(items.map((item) => [item.id, classify(item)]));
  const second = new Map(items.map((item) => [item.id, classify(item)]));
  // Deterministic shuffle: reverse, then interleave halves.
  const reversed = [...items].reverse();
  const half = Math.ceil(reversed.length / 2);
  const shuffled = reversed.slice(0, half).flatMap((item, i) => [item, reversed[half + i]].filter(Boolean));
  const third = new Map(shuffled.map((item) => [item.id, createClassifier(CONFIG)(item)]));
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test('performance: a hundred items take well under a millisecond each', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    caption: `${'some words here '.repeat(50)} #tag${i} ending`,
    type: 'photo',
  }));
  const start = process.hrtime.bigint();
  for (const item of items) classify(item);
  const perItemMs = Number(process.hrtime.bigint() - start) / 1e6 / items.length;
  assert.ok(perItemMs < 1, `took ${perItemMs.toFixed(3)} ms per item`);
});

test('the worked examples in the README hold for the example config', () => {
  const config = parseConfig(readFileSync(join(import.meta.dirname, '../../examples/simple-media.yml'), 'utf8'));
  const classify = createClassifier(config);
  assert.equal(classify({ caption: 'Dinner at the airport #foodie', type: 'photo' }), 'Travel');
  assert.equal(classify({ caption: 'Sunday pasta #recipe', type: 'reel' }), 'Food');
});
