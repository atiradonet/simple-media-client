import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, compareItems, loadState, pagePath, parseState, planUpdate, serializeState } from '../../src/state.js';

const at = (day) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const fetched = (id, day) => ({ id, provider: 'instagram', timestamp: at(day), type: 'photo', caption: '', permalink: 'https://www.instagram.com/p/x/', thumbnail_url: 'https://cdn.test/x.jpg' });
const entry = (id, day, provider = 'instagram') => ({
  id, provider, timestamp: at(day), type: 'photo', category: 'C', title: 'T',
  permalink: 'https://www.instagram.com/p/x/', page: pagePath(provider, id), tn: 'data:image/webp;base64,AA==',
});
const plan = (items, posts, options = {}) =>
  planUpdate({ state: { version: 1, items }, provider: 'instagram', fetched: posts, backfill: 20, maxItems: 200, ...options });
const ids = (list) => list.map((item) => item.id);

test('dedupe: known IDs are skipped', () => {
  const result = plan([entry('a', 5)], [fetched('b', 6), fetched('a', 5)]);
  assert.deepEqual(ids(result.added), ['b']);
  assert.deepEqual(ids(result.kept), ['a']);
});

test('first-run backfill keeps only the newest N', () => {
  const posts = [fetched('old', 1), fetched('new', 3), fetched('mid', 2)];
  assert.deepEqual(ids(plan([], posts, { backfill: 2 }).added), ['new', 'mid']);
  assert.deepEqual(plan([], posts, { backfill: 0 }).added, []);
});

test('a second run does not add what backfill left out', () => {
  const posts = [fetched('new', 3), fetched('mid', 2), fetched('old', 1)];
  const result = plan([entry('new', 3), entry('mid', 2)], posts, { backfill: 2 });
  assert.deepEqual(result, { added: [], removed: [], pruned: [], kept: [entry('new', 3), entry('mid', 2)] });
});

test('a post sharing the oldest timestamp still counts as new', () => {
  assert.deepEqual(ids(plan([entry('a', 2)], [fetched('a', 2), fetched('b', 2)]).added), ['b']);
});

test('deleted items: missing inside the window is removed, older than the window is kept', () => {
  const result = plan([entry('gone', 5), entry('edge', 3), entry('old', 1)], [fetched('new', 6), fetched('keep', 3)]);
  assert.deepEqual(ids(result.removed), ['gone', 'edge']);
  assert.deepEqual(ids(result.kept), ['old']);
});

test('nothing fetched means nothing reads as deleted', () => {
  const result = plan([entry('a', 5)], []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(ids(result.kept), ['a']);
});

test('a post the adapter skipped is not treated as deleted', () => {
  const result = plan([entry('a', 5), entry('b', 4)], [fetched('a', 5), fetched('c', 3)], { skippedIds: ['b'] });
  assert.deepEqual(result.removed, []);
});

test('another provider\'s items are never deleted and do not set the floor', () => {
  const manual = entry('m', 9, 'manual');
  const result = plan([manual], [fetched('a', 1), fetched('b', 2)], { backfill: 1 });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(ids(result.added), ['b']);
  assert.deepEqual(ids(result.kept), ['m']);
});

test('when every item was deleted the feed backfills again', () => {
  assert.deepEqual(ids(plan([entry('gone', 9)], [fetched('a', 1), fetched('b', 2)], { backfill: 1 }).added), ['b']);
});

test('max_items drops the oldest and reports them; new posts past the cap are not built', () => {
  const result = plan([entry('b', 2), entry('a', 1)], [fetched('c', 3), fetched('b', 2), fetched('a', 1)], { maxItems: 2 });
  assert.deepEqual(ids(result.added), ['c']);
  assert.deepEqual(ids(result.kept), ['b']);
  assert.deepEqual(result.pruned.map((item) => item.page), ['p/instagram-a.html']);
  assert.deepEqual(plan([], [fetched('a', 1), fetched('b', 2)], { maxItems: 1 }).added.map((i) => i.id), ['b']);
});

test('sort order: newest first, ties by id, stable', () => {
  const items = [entry('b', 2), entry('a', 2), entry('c', 3), entry('a', 2)];
  assert.deepEqual(ids([...items].sort(compareItems)), ['c', 'a', 'a', 'b']);
});

test('serialization is byte-stable, with sorted keys and two-space indent', () => {
  const shuffled = { items: [entry('a', 1), entry('b', 2)], version: 1, token: { fingerprint: 'f', expires_at: at(1) } };
  const text = serializeState(shuffled);
  assert.equal(serializeState(parseState(text)), text);
  assert.ok(text.startsWith('{\n  "items": [\n    {\n      "category": "C",'));
  assert.ok(text.endsWith('"version": 1\n}\n'));
  assert.ok(text.indexOf('"b"') < text.indexOf('"a"'));
  assert.equal(serializeState({ version: 1, items: [{ id: 'x', list: [null, 1] }] }).includes('null'), true);
});

test('serialization handles primitives and already-sorted lists', () => {
  assert.equal(serializeState({ version: 1, items: [] }), '{\n  "items": [],\n  "version": 1\n}\n');
});

test('parseState sorts items and keeps a token record', () => {
  const state = parseState(JSON.stringify({ version: 1, items: [entry('a', 1), entry('b', 2)], token: { fingerprint: 'f', expires_at: at(1) } }));
  assert.deepEqual(ids(state.items), ['b', 'a']);
  assert.equal(state.token.fingerprint, 'f');
  assert.deepEqual(parseState(JSON.stringify(emptyState())), emptyState());
});

test('parseState rejects bad files with a plain message', () => {
  const cases = [
    ['{', 'not valid JSON'],
    ['[]', 'not a JSON object'],
    ['null', 'not a JSON object'],
    ['{"version":2,"items":[]}', 'unsupported version 2'],
    ['{"version":1}', 'items is not a list'],
    ['{"version":1,"items":[null]}', 'item 1 is not an object'],
    ['{"version":1,"items":[[]]}', 'item 1 is not an object'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), id: '../x' }] }), 'item 1 has an invalid id'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), id: 5 }] }), 'item 1 has an invalid id'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), provider: 'A/B' }] }), 'item 1 has an invalid provider'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), provider: 5 }] }), 'item 1 has an invalid provider'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), timestamp: 'soon' }] }), 'item 1 has an invalid timestamp'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), timestamp: 5 }] }), 'item 1 has an invalid timestamp'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), page: '../../etc/passwd' }] }), 'item 1 has an unexpected page path'],
    [JSON.stringify({ version: 1, items: [{ ...entry('a', 1), tn: 5 }] }), 'item 1 has no tn'],
    ['{"version":1,"items":[],"token":null}', 'token is not a valid record'],
    ['{"version":1,"items":[],"token":{"fingerprint":1,"expires_at":"x"}}', 'token is not a valid record'],
    ['{"version":1,"items":[],"token":{"fingerprint":"f"}}', 'token is not a valid record'],
    ['{"version":1,"items":[],"token":{"fingerprint":"f","expires_at":"x"}}', 'token is not a valid record'],
  ];
  for (const [text, detail] of cases) {
    assert.throws(() => parseState(text, 'feed/index.json'), {
      name: 'UserError',
      message: `feed/index.json: ${detail}. Fix the file, or delete it to rebuild the feed.`,
    }, text);
  }
});

test('loadState: a missing file is an empty state; other read errors surface', async () => {
  const missing = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.deepEqual(await loadState('x', { read: missing }), emptyState());
  const denied = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  await assert.rejects(loadState('x', { read: denied }), /denied/);
  assert.deepEqual(await loadState('x', { read: async () => JSON.stringify(emptyState()) }), emptyState());
  await assert.rejects(loadState('x', { read: async () => '{' }), /x: not valid JSON/);
});
