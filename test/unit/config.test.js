import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ConfigError, DEFAULT_THEME, loadConfig, parseConfig, validateConfig } from '../../src/config.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/config');

// Smallest valid config; cases below append to it.
const BASE = 'site:\n  title: T\n  contact_email: a@b.co\nfallback: Everyday\n';

function rejects(yaml, expected) {
  assert.throws(() => parseConfig(yaml), (err) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.name}`);
    assert.equal(err.message, expected);
    return true;
  });
}

test('minimal config passes and fills defaults', () => {
  const config = loadConfig(join(FIXTURES, 'minimal.yml'));
  assert.deepEqual(config, {
    provider: null,
    site: {
      title: 'Minimal',
      description: '',
      language: 'en',
      profile_url: null,
      contact_email: 'owner@example.com',
      theme: DEFAULT_THEME,
    },
    output: { dir: 'feed', max_items: 200 },
    fetch: { limit: 50, backfill: 20 },
    thumbnails: { width: 480, tiny_width: 96, format: 'webp', quality: 75, max_bytes: 40000 },
    fallback: 'Everyday',
    categories: [],
  });
});

test('full example config passes', () => {
  const config = loadConfig(join(FIXTURES, 'full.yml'));
  assert.equal(config.provider, 'instagram');
  assert.equal(config.site.profile_url, 'https://www.instagram.com/example/');
  assert.deepEqual(config.categories, [
    { name: 'Travel', hashtags: ['travel', 'wanderlust'], keywords: ['airport', 'flight', 'hotel', 'road trip'], media: [] },
    { name: 'Food', hashtags: ['foodie', 'recipe'], keywords: ['dinner', 'brunch', 'coffee'], media: [] },
    { name: 'Video', hashtags: [], keywords: [], media: ['reel', 'video'] },
  ]);
});

test('leading # on hashtags is stripped and numbers become text', () => {
  const config = parseConfig(`${BASE}categories:\n  - name: A\n    hashtags: ["#travel", " #food ", 2026]\n    keywords: [1999]\n`);
  assert.deepEqual(config.categories[0].hashtags, ['travel', 'food', '2026']);
  assert.deepEqual(config.categories[0].keywords, ['1999']);
});

test('theme colors override defaults and are lowercased', () => {
  const config = parseConfig(BASE.replace('site:\n', 'site:\n  theme:\n    accent: "#ABC"\n'));
  assert.deepEqual(config.site.theme, { ...DEFAULT_THEME, accent: '#abc' });
});

test('backfill defaults to at most fetch.limit', () => {
  assert.deepEqual(parseConfig(`${BASE}fetch:\n  limit: 5\n`).fetch, { limit: 5, backfill: 5 });
});

test('empty sections fall back to defaults', () => {
  const config = parseConfig(`${BASE}output:\nfetch:\nthumbnails:\ncategories:\n`);
  assert.equal(config.output.max_items, 200);
  assert.deepEqual(config.categories, []);
});

// Each validation rule in BRIEF.md section 6, with the exact message.
const FAILURES = [
  ['typo in a top-level key', `${BASE}categoris: []\n`,
    'simple-media.yml: categoris: unknown key; expected one of: provider, site, output, fetch, thumbnails, fallback, categories (line 5)'],
  ['unknown nested key', `${BASE}output:\n  max_item: 5\n`,
    'simple-media.yml: output.max_item: unknown key; expected one of: dir, max_items (line 6)'],
  ['missing fallback', 'site:\n  title: T\n  contact_email: a@b.co\n',
    'simple-media.yml: fallback: is required'],
  ['empty fallback', BASE.replace('Everyday', '"  "'),
    'simple-media.yml: fallback: must not be empty (line 4)'],
  ['fallback too long', BASE.replace('Everyday', 'x'.repeat(41)),
    'simple-media.yml: fallback: must be 1 to 40 characters, got 41 (line 4)'],
  ['fallback not text', BASE.replace('Everyday', '[a]'),
    'simple-media.yml: fallback: must be text, got a list (line 4)'],
  ['missing site', 'fallback: X\n',
    'simple-media.yml: site: is required (with at least title and contact_email)'],
  ['site not a mapping', 'fallback: X\nsite: hello\n',
    'simple-media.yml: site: must be a mapping, got "hello" (line 2)\n' +
    'simple-media.yml: site.contact_email: is required (line 2)\n' +
    'simple-media.yml: site.title: is required (line 2)'],
  ['bad email', BASE.replace('a@b.co', 'not-an-email'),
    'simple-media.yml: site.contact_email: must be an email address, got "not-an-email" (line 3)'],
  ['bad language', `${BASE.replace('site:\n', 'site:\n  language: english!\n')}`,
    'simple-media.yml: site.language: must be a language tag like "en" or "pt-BR", got "english!" (line 2)'],
  ['profile_url not https', BASE.replace('site:\n', 'site:\n  profile_url: "javascript:alert(1)"\n'),
    'simple-media.yml: site.profile_url: must be an https:// URL, got "javascript:alert(1)" (line 2)'],
  ['bad theme color', BASE.replace('site:\n', 'site:\n  theme:\n    ink: red\n'),
    'simple-media.yml: site.theme.ink: must be a color like #rgb or #rrggbb, got "red" (line 3)'],
  ['theme color not text', BASE.replace('site:\n', 'site:\n  theme:\n    ink: 123\n'),
    'simple-media.yml: site.theme.ink: must be a color like #rgb or #rrggbb, got 123 (line 3)'],
  ['unknown theme key', BASE.replace('site:\n', 'site:\n  theme:\n    inc: "#000"\n'),
    'simple-media.yml: site.theme.inc: unknown key; expected one of: paper, ink, muted, accent, paper_dark, ink_dark, muted_dark, accent_dark (line 3)'],
  ['unsafe output dir', `${BASE}output:\n  dir: ../escape\n`,
    'simple-media.yml: output.dir: must be a relative folder like "feed" (letters, digits, - and _), got "../escape" (line 6)'],
  ['max_items too low', `${BASE}output:\n  max_items: 0\n`,
    'simple-media.yml: output.max_items: must be between 1 and 2000, got 0 (line 6)'],
  ['max_items too high', `${BASE}output:\n  max_items: 2001\n`,
    'simple-media.yml: output.max_items: must be between 1 and 2000, got 2001 (line 6)'],
  ['max_items not a whole number', `${BASE}output:\n  max_items: 2.5\n`,
    'simple-media.yml: output.max_items: must be a whole number, got 2.5 (line 6)'],
  ['fetch.limit too high', `${BASE}fetch:\n  limit: 101\n`,
    'simple-media.yml: fetch.limit: must be between 1 and 100, got 101 (line 6)'],
  ['backfill above limit', `${BASE}fetch:\n  limit: 10\n  backfill: 11\n`,
    'simple-media.yml: fetch.backfill: must be between 0 and 10, got 11 (line 7)'],
  ['thumbnail width too small', `${BASE}thumbnails:\n  width: 63\n`,
    'simple-media.yml: thumbnails.width: must be between 64 and 1080, got 63 (line 6)'],
  ['tiny_width wider than width', `${BASE}thumbnails:\n  width: 100\n  tiny_width: 101\n`,
    'simple-media.yml: thumbnails.tiny_width: must be between 16 and 100, got 101 (line 7)'],
  ['unknown thumbnail format', `${BASE}thumbnails:\n  format: png\n`,
    'simple-media.yml: thumbnails.format: must be one of: webp, jpeg; got "png" (line 6)'],
  ['unknown provider', `provider: tiktok\n${BASE}`,
    'simple-media.yml: provider: must be one of: instagram; got "tiktok" (line 1)'],
  ['categories not a list', `${BASE}categories: Travel\n`,
    'simple-media.yml: categories: must be a list, got "Travel" (line 5)'],
  ['category not a mapping', `${BASE}categories:\n  - Travel\n`,
    'simple-media.yml: categories[0]: must be a mapping with a name, got "Travel" (line 6)'],
  ['category without name', `${BASE}categories:\n  - media: [reel]\n`,
    'simple-media.yml: categories[0].name: is required (line 6)'],
  ['category name too long', `${BASE}categories:\n  - name: ${'x'.repeat(41)}\n    media: [reel]\n`,
    'simple-media.yml: categories[0].name: must be 1 to 40 characters, got 41 (line 6)'],
  ['duplicate category name', `${BASE}categories:\n  - name: Food\n    media: [reel]\n  - name: FOOD\n    media: [photo]\n`,
    'simple-media.yml: categories[1].name: "FOOD" is already used by categories[0]; names must be unique (case-insensitive) (line 8)'],
  ['category without rules', `${BASE}categories:\n  - name: Empty\n`,
    'simple-media.yml: categories[0]: category "Empty" needs at least one of: hashtags, keywords, media (line 6)'],
  ['category with only empty rules', `${BASE}categories:\n  - name: Empty\n    hashtags: []\n`,
    'simple-media.yml: categories[0]: category "Empty" needs at least one of: hashtags, keywords, media (line 6)'],
  ['category without name or rules', `${BASE}categories:\n  - media: []\n`,
    'simple-media.yml: categories[0].name: is required (line 6)\n' +
    'simple-media.yml: categories[0]: this category needs at least one of: hashtags, keywords, media (line 6)'],
  ['unknown category key', `${BASE}categories:\n  - name: A\n    hashtag: [x]\n`,
    'simple-media.yml: categories[0]: category "A" needs at least one of: hashtags, keywords, media (line 6)\n' +
    'simple-media.yml: categories[0].hashtag: unknown key; expected one of: name, hashtags, keywords, media (line 7)'],
  ['unknown media type', `${BASE}categories:\n  - name: A\n    media: [gif]\n`,
    'simple-media.yml: categories[0].media[0]: must be one of: photo, video, reel, carousel; got "gif" (line 7)'],
  ['hashtags not a list', `${BASE}categories:\n  - name: A\n    hashtags: travel\n`,
    'simple-media.yml: categories[0].hashtags: must be a list, got "travel" (line 7)'],
  ['empty hashtag', `${BASE}categories:\n  - name: A\n    hashtags: ["#"]\n`,
    'simple-media.yml: categories[0].hashtags[0]: must not be empty (line 7)'],
  ['hashtag with spaces', `${BASE}categories:\n  - name: A\n    hashtags: ["road trip"]\n`,
    'simple-media.yml: categories[0].hashtags[0]: hashtags cannot contain spaces, got "road trip" (line 7)'],
  ['keyword not text', `${BASE}categories:\n  - name: A\n    keywords: [{a: 1}]\n`,
    'simple-media.yml: categories[0].keywords[0]: must be text, got a mapping (line 7)'],
  ['config is not a mapping', '- a\n- b\n',
    'simple-media.yml: (top level): must be a mapping of settings, got a list'],
  ['empty file', '',
    'simple-media.yml: (top level): must be a mapping of settings, got null'],
  ['YAML syntax error', 'site: [oops\n',
    'simple-media.yml: YAML syntax error (line 2): Flow sequence in block collection must be sufficiently indented and end with a ]'],
  ['duplicate key', `${BASE}fallback: Other\n`,
    'simple-media.yml: YAML syntax error (line 5): Map keys must be unique'],
];

for (const [name, yaml, expected] of FAILURES) {
  test(`rejects: ${name}`, () => rejects(yaml, expected));
}

test('collects every problem in one message', () => {
  rejects(`${BASE}output:\n  max_items: 0\nfetch:\n  limit: 0\n`,
    'simple-media.yml: output.max_items: must be between 1 and 2000, got 0 (line 6)\n' +
    'simple-media.yml: fetch.limit: must be between 1 and 100, got 0 (line 8)');
});

test('validateConfig accepts a custom provider list', () => {
  const { problems } = validateConfig({ provider: 'manual', site: { title: 'T', contact_email: 'a@b.co' }, fallback: 'X' }, { providers: ['instagram', 'manual'] });
  assert.deepEqual(problems, []);
});

test('loadConfig names the file when it is missing', () => {
  assert.throws(() => loadConfig('nope.yml'), new ConfigError('nope.yml: config file not found.'));
});

test('loadConfig reports other read errors without a stack', () => {
  const readFile = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  assert.throws(() => loadConfig('x.yml', { readFile }), new ConfigError('x.yml: cannot read config file (EACCES).'));
  const readFileNoCode = () => {
    throw new Error('weird');
  };
  assert.throws(() => loadConfig('x.yml', { readFile: readFileNoCode }), new ConfigError('x.yml: cannot read config file (weird).'));
});

test('file name in messages follows the path given', () => {
  assert.throws(() => parseConfig('fallback: X\n', { file: 'site/feed.yml' }), {
    message: 'site/feed.yml: site: is required (with at least title and contact_email)',
  });
});

test('problems without a line come first', () => {
  rejects('site:\n  title: T\n  contact_email: a@b.co\noutput:\n  max_items: 0\n',
    'simple-media.yml: fallback: is required\n' +
    'simple-media.yml: output.max_items: must be between 1 and 2000, got 0 (line 5)');
});
