import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_THEME } from '../../src/config.js';
import { cssColor, cssSafe, escapeHtml, safeHttpsUrl } from '../../src/render/escape.js';
import { groupItems, renderIndexPage } from '../../src/render/index.js';
import { renderItemPage } from '../../src/render/item.js';
import { themeCss } from '../../src/render/theme.js';
import { altText, cleanCaption, createSlugger, deriveTitle, excerpt, formatDate } from '../../src/render/text.js';
import { FULL, GOLDEN_DIR, config, items, renderGoldenFiles } from '../golden-cases.js';

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [relative(GOLDEN_DIR, path)];
  });
}

test('golden files: rendering matches the stored output byte for byte', () => {
  const rendered = renderGoldenFiles();
  assert.deepEqual(listFiles(GOLDEN_DIR).sort(), Object.keys(rendered).sort());
  for (const [path, html] of Object.entries(rendered)) {
    assert.equal(html, readFileSync(join(GOLDEN_DIR, path), 'utf8'), `${path} differs; run npm run golden:update and review the diff`);
  }
});

test('rendering twice gives identical output', () => {
  assert.deepEqual(renderGoldenFiles(), renderGoldenFiles());
});

// --- escape.js

test('escapeHtml escapes the five significant characters', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&amp;</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('safeHttpsUrl allows only absolute https URLs', () => {
  assert.equal(safeHttpsUrl('https://www.instagram.com/p/A/?a=1&b="2"'), 'https://www.instagram.com/p/A/?a=1&amp;b=%222%22');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'http://x.example/', '/relative', 'not a url', '']) {
    assert.equal(safeHttpsUrl(bad), null, bad);
  }
});

test('cssColor and cssSafe refuse anything that could leave the CSS context', () => {
  assert.equal(cssColor('#ABC'), '#abc');
  for (const bad of ['red', '#12345', '#000;}</style><script>', 'expression(1)']) assert.throws(() => cssColor(bad));
  assert.throws(() => cssSafe('a{}</STYLE><script>'));
  assert.equal(cssSafe('a{}'), 'a{}');
});

// --- injection

const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</style><script>alert(1)</script>',
  'javascript:alert(1)',
  '&lt;already-escaped&gt;',
];

test('hostile captions render inert in every context', () => {
  for (const caption of HOSTILE) {
    const item = { ...items[0], title: deriveTitle({ caption, type: 'photo', timestamp: items[0].timestamp }) };
    const html = renderItemPage({ site: config.site, item, caption, image: FULL });
    assert.ok(!/<script/i.test(html), caption);
    assert.ok(!/<img src=x/i.test(html), caption);
    // Escaped text has no raw '<', so every tag here is one we wrote; none may carry a handler.
    const tags = html.match(/<[a-z][^>]*>/gi);
    // Look at attribute names only: quoted values may legitimately contain the text.
    assert.ok(tags.every((tag) => !/\son\w+=/i.test(tag.replace(/"[^"]*"/g, '""'))), caption);
    assert.equal((html.match(/<\/style>/g) ?? []).length, 1, caption);
    assert.ok(!/href="javascript:/i.test(html), caption);
  }
});

test('hostile config strings cannot break out of their context', () => {
  const site = { ...config.site, title: '</title><script>x</script>', description: '"><script>y</script>', contact_email: 'a@b.co' };
  const html = renderIndexPage({ site, categoryNames: ['<b>bold</b>'], fallback: 'F"><x', items: [{ ...items[0], category: '<b>bold</b>' }] });
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(html.includes('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>'));
});

test('a javascript: profile_url is never linked', () => {
  const site = { ...config.site, profile_url: 'javascript:alert(1)' };
  const html = renderIndexPage({ site, categoryNames: [], fallback: 'X', items: [] });
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('Profile on Instagram'));
});

test('renderers refuse unsafe inputs instead of emitting them', () => {
  const base = { site: config.site, item: items[0], caption: 'x' };
  assert.throws(() => renderItemPage({ ...base, image: 'https://evil.example/x.png' }), /not an embeddable data URI/);
  assert.throws(() => renderItemPage({ ...base, image: 'data:image/svg+xml;base64,PHN2Zz4=' }), /not an embeddable data URI/);
  assert.throws(() => renderItemPage({ ...base, item: { ...items[0], permalink: 'javascript:alert(1)' }, image: FULL }), /not an https URL/);
  assert.throws(
    () => renderIndexPage({ site: config.site, categoryNames: [], fallback: 'X', items: [{ ...items[0], page: '../../etc/passwd.html' }] }),
    /unexpected page path/,
  );
});

test('index entries without a usable thumbnail render without an image', () => {
  const html = renderIndexPage({ site: config.site, categoryNames: [], fallback: 'Everyday', items: [{ ...items[0], tn: 'https://evil.example/x' }] });
  assert.ok(!html.includes('evil.example'));
  assert.ok(html.includes('<li><a href="p/instagram-1001.html"><span>'));
});

// --- empty captions, alt text, titles

test('an empty caption gives valid alt text and title', () => {
  const photo = { caption: '', type: 'photo', timestamp: '2026-10-27T12:30:00.000Z' };
  assert.equal(deriveTitle(photo), 'Photo from 2026-10-27');
  assert.equal(deriveTitle({ ...photo, type: 'reel' }), 'Reel from 2026-10-27');
  assert.equal(deriveTitle({ ...photo, type: 'unknown' }), 'Post from 2026-10-27');
  assert.equal(deriveTitle({ ...photo, caption: '#only #hashtags' }), 'Photo from 2026-10-27');
  assert.equal(altText({ title: 'Photo from 2026-10-27', caption: '', type: 'photo' }), 'Photo');
  assert.equal(altText({ title: 'x', caption: '  ', type: 'carousel' }), 'Photo');
  assert.equal(altText({ title: 'x', caption: '', type: 'video' }), 'Video thumbnail');
  assert.equal(altText({ title: 'x', caption: '', type: 'reel' }), 'Video thumbnail');
  assert.equal(altText({ title: 'Sunset', caption: 'Sunset', type: 'reel' }), 'Sunset');

  const html = renderItemPage({ site: config.site, item: items[2], caption: '', image: FULL });
  assert.match(html, /<img src="data:[^"]+" alt="Photo">/);
  assert.match(html, /<title>Photo set from 2026-10-27 \(2026-10-27\) · Brini Bruni<\/title>/);
  assert.match(html, /<meta name="description" content="Photo set from 2026-10-27, posted 2026-10-27\.">/);
  assert.ok(!html.includes('class="caption"'));
});

test('deriveTitle uses the first non-empty line without hashtags and cuts at a word', () => {
  const ts = '2026-10-01T00:00:00.000Z';
  assert.equal(deriveTitle({ caption: '\n\n#tag\nSecond line here\nthird', type: 'photo', timestamp: ts }), 'Second line here');
  const long = deriveTitle({ caption: 'word '.repeat(40), type: 'photo', timestamp: ts });
  assert.ok(long.length <= 80 && long.endsWith('word…'), long);
  const unbroken = deriveTitle({ caption: 'x'.repeat(200), type: 'photo', timestamp: ts });
  assert.equal(unbroken, `${'x'.repeat(79)}…`);
});

test('cleanCaption removes other people\'s handles but keeps emails and line breaks', () => {
  assert.equal(cleanCaption('Dinner with @anna.b and @Tom_99!\r\nMail me: me@example.com'), 'Dinner with and !\nMail me: me@example.com');
  assert.equal(cleanCaption('@lead at start'), 'at start');
  assert.equal(cleanCaption('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(cleanCaption(undefined), '');
});

test('excerpt collapses whitespace and shortens', () => {
  assert.equal(excerpt('a\n b'), 'a b');
  assert.ok(excerpt('word '.repeat(100)).length <= 160);
});

test('formatDate is UTC ISO date', () => {
  assert.equal(formatDate('2026-10-29T23:59:59.000Z'), '2026-10-29');
});

test('slugger makes unique anchors for clashing names', () => {
  const slug = createSlugger();
  assert.deepEqual(['Café', 'cafe', 'CAFÉ', '!!!', '东京'].map(slug), ['c-cafe', 'c-cafe-2', 'c-cafe-3', 'c-category', 'c-东京']);
});

// --- index grouping

test('groupItems orders config categories, then fallback, then leftovers; newest first; empty groups dropped', () => {
  const at = (id, category, timestamp) => ({ id, category, timestamp });
  const groups = groupItems(
    [at('a', 'Old', '2026-01-01'), at('b', 'Food', '2026-01-02'), at('c', 'Food', '2026-01-03'), at('d', 'Everyday', '2026-01-01'), at('e', 'Food', '2026-01-03'), at('f', 'Ancient', '2026-01-01')],
    ['Travel', 'Food'],
    'Everyday',
  );
  assert.deepEqual(groups.map((g) => [g.name, g.items.map((i) => i.id)]), [
    ['Food', ['c', 'e', 'b']],
    ['Everyday', ['d']],
    ['Ancient', ['f']],
    ['Old', ['a']],
  ]);
});

test('an empty feed renders a friendly placeholder and no category nav', () => {
  const html = renderIndexPage({ site: { ...config.site, description: '', profile_url: null }, categoryNames: [], fallback: 'X', items: [] });
  assert.match(html, /Nothing here yet/);
  assert.ok(!html.includes('aria-label="Categories"'));
  assert.match(html, /<meta name="description" content="Recent posts from Brini Bruni\.">/);
});

// --- theme

test('theme override changes only the intended CSS variables', () => {
  const base = themeCss(DEFAULT_THEME);
  const changed = themeCss({ ...DEFAULT_THEME, accent: '#123456', paper_dark: '#000' });
  const baseLines = base.split('\n');
  const changedLines = changed.split('\n');
  const differing = baseLines.map((line, i) => [line, changedLines[i]]).filter(([a, b]) => a !== b);
  assert.equal(differing.length, 2);
  assert.equal(differing[0][1], differing[0][0].replace('--accent:#b5441d;', '--accent:#123456;'));
  assert.equal(differing[1][1], differing[1][0].replace('--paper:#14110f;', '--paper:#000;'));
});

test('theme CSS has the dark scheme and reduced-motion handling', () => {
  const css = themeCss(DEFAULT_THEME);
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{:root\{--paper:#14110f;--ink:#f1e9dc;--muted:#8f8374;--accent:#f0714a;\}\}/);
  assert.match(css, /prefers-reduced-motion:no-preference/);
});
