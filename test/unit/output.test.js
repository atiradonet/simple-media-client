// Output validity (BRIEF.md 14.4) over every golden page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME } from '../../src/config.js';
import { renderIndexPage } from '../../src/render/index.js';
import { renderItemPage } from '../../src/render/item.js';
import { contrastRatio } from '../../src/render/theme.js';
import { config, items, renderGoldenFiles } from '../golden-cases.js';
import { accessibilityProblems, externalReferences, validationErrors } from '../output-checks.js';

const files = Object.entries(renderGoldenFiles());

test('every page passes the HTML validator with zero errors', async () => {
  for (const [name, html] of files) assert.deepEqual(await validationErrors(html, name), [], name);
});

test('every page is self-contained', () => {
  for (const [name, html] of files) assert.deepEqual(externalReferences(html), [], name);
});

test('every page passes the accessibility smoke check', () => {
  for (const [name, html] of files) assert.deepEqual(accessibilityProblems(html), [], name);
});

test('the checks themselves catch problems', async () => {
  const bad = '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="https://cdn.example/x.css"></head>' +
    '<body><h2>skip</h2><h1>a</h1><h1>b</h1><img src="https://evil.example/t.png"><a href="//evil.example/">x</a>' +
    '<a href="https://www.instagram.com/p/A/">ok</a><div style="background:url(https://evil.example/x)"></div><script>1</script></body></html>';
  assert.deepEqual(externalReferences(bad), [
    '<link href="https://cdn.example/x.css">',
    '<img src="https://evil.example/t.png">',
    '<a href="//evil.example/">',
    'url(https://evil.example/x)',
    '<script>',
    'external-capable element',
  ]);
  assert.deepEqual(accessibilityProblems(bad), [
    'missing lang', 'expected one h1, found 2', 'missing <header>', 'missing <main>', 'missing <nav>', 'missing <footer>',
    'img without alt: <img src="https://evil.example/t.png">', 'heading jumps from h0 to h2',
  ]);
  assert.ok((await validationErrors(bad, 'bad.html')).length > 0);
});

test('size budget: a worst-case item page stays under 60 KB', () => {
  // A thumbnail at the max_bytes cap plus a 2,200-character caption.
  const image = `data:image/webp;base64,${Buffer.alloc(config.thumbnails.max_bytes, 7).toString('base64')}`;
  const html = renderItemPage({ site: config.site, item: { ...items[0], title: 'x'.repeat(80) }, caption: 'word '.repeat(440), image });
  assert.ok(Buffer.byteLength(html) < 60 * 1024, `${Buffer.byteLength(html)} bytes`);
});

test('size budget: index.html grows within 6 KB per item up to max_items', () => {
  // A 96px thumbnail is about 2 KB at worst; base64 adds a third.
  const tn = `data:image/webp;base64,${Buffer.alloc(3000, 7).toString('base64')}`;
  const many = Array.from({ length: config.output.max_items }, (_, i) => ({
    ...items[i % items.length], id: `id${i}`, page: `p/instagram-id${i}.html`, title: 'x'.repeat(80), tn,
  }));
  const html = renderIndexPage({ site: config.site, categoryNames: config.categories.map((c) => c.name), fallback: config.fallback, items: many });
  const budget = 8 * 1024 + config.output.max_items * 6 * 1024;
  assert.ok(Buffer.byteLength(html) < budget, `${Buffer.byteLength(html)} bytes, budget ${budget}`);
});

test('golden thumbnails are under max_bytes', () => {
  for (const [name, html] of files) {
    for (const [, data] of html.matchAll(/src="data:image\/\w+;base64,([^"]+)"/g)) {
      assert.ok(Buffer.from(data, 'base64').length <= config.thumbnails.max_bytes, name);
    }
  }
});

test('default theme meets WCAG AA (4.5:1) for all text colors in both schemes', () => {
  for (const suffix of ['', '_dark']) {
    for (const color of ['ink', 'muted', 'accent']) {
      const ratio = contrastRatio(DEFAULT_THEME[`${color}${suffix}`], DEFAULT_THEME[`paper${suffix}`]);
      assert.ok(ratio >= 4.5, `${color}${suffix} on paper${suffix}: ${ratio.toFixed(2)}`);
    }
  }
});

test('no generated page contains a build timestamp', () => {
  const year = String(new Date().getUTCFullYear());
  for (const [name, html] of files) {
    // Dates may appear only as post dates from the fixtures (2026-10-2x).
    const stamps = [...html.matchAll(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?/g)].map((m) => m[0]);
    assert.ok(stamps.every((s) => s.startsWith('2026-10-2')), `${name}: ${stamps.join(', ')}`);
    assert.ok(!/generated|built at|last updated/i.test(html), name);
    assert.ok(year === '2026' || !html.includes(year), name);
  }
});
