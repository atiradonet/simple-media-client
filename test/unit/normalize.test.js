import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHashtags, normalize, removeHashtags } from '../../src/normalize.js';

const NORMALIZE_CASES = [
  ['Café', 'cafe'],
  ['CAFÉ  au\tLAIT\n', 'cafe au lait'],
  ['ｆｕｌｌｗｉｄｔｈ', 'fullwidth'], // NFKC folds compatibility forms
  ['ﬁne', 'fine'], // ligature
  ['São Paulo', 'sao paulo'],
  ['   ', ''],
  ['', ''],
  [null, ''],
  [undefined, ''],
];

for (const [input, expected] of NORMALIZE_CASES) {
  test(`normalize(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, () => {
    assert.equal(normalize(input), expected);
  });
}

test('extractHashtags finds Unicode tags in order and stops at punctuation', () => {
  const text = normalize('Dinner #Foodie, #Café! #東京 #road_trip #2026 # alone #a-b');
  assert.deepEqual(extractHashtags(text), ['foodie', 'cafe', '東京', 'road_trip', '2026', 'a']);
});

test('extractHashtags on text without tags is empty', () => {
  assert.deepEqual(extractHashtags('no tags here'), []);
});

test('removeHashtags leaves the rest of the text with single spaces', () => {
  assert.equal(removeHashtags(normalize('#travel airport  lounge #wanderlust')), 'airport lounge');
  assert.equal(removeHashtags(''), '');
});
