import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_VERSION,
  FIELDS,
  RETRY_DELAYS_MS,
  TOKEN_MESSAGE,
  fetchItems,
  mediaUrl,
  normalizeMedia,
  requestJson,
} from '../../src/providers/instagram.js';
import { createFixtureFetch } from '../../src/providers/fixtures.js';
import { FAKE_TOKEN } from '../helpers.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/instagram');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

// A fetch stand-in that answers from a queue and records every URL.
function mockFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fetch = async (url) => {
    calls.push(new URL(url));
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return new Response(body, { status });
  };
  return { fetch, calls };
}

// Records waits instead of waiting.
function recordingSleep() {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  return { sleep, waits };
}

const page = (data, paging) => JSON.stringify(paging ? { data, paging } : { data });
const media = (overrides = {}) => ({
  id: '1001',
  caption: 'hello',
  media_type: 'IMAGE',
  media_url: 'https://cdn.example/a.jpg',
  permalink: 'https://www.instagram.com/p/A/',
  timestamp: '2026-10-01T10:00:00+0000',
  ...overrides,
});

test('requests the exact field list, API version, limit and token', async () => {
  const { fetch, calls } = mockFetch([[200, page([])]]);
  await fetchItems({ token: FAKE_TOKEN, limit: 25, fetch });
  assert.equal(calls.length, 1);
  const [url] = calls;
  assert.equal(url.origin, 'https://graph.instagram.com');
  assert.equal(url.pathname, `/${API_VERSION}/me/media`);
  assert.equal(url.searchParams.get('fields'), 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp');
  assert.deepEqual(FIELDS.join(','), url.searchParams.get('fields'));
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('access_token'), FAKE_TOKEN);
  assert.equal(url.searchParams.has('after'), false);
});

test('maps every fixture type and picks the right thumbnail source', async () => {
  const { fetch, calls } = mockFetch([
    [200, fixture('media.json')],
    [200, fixture('media-after-PAGE2.json')],
  ]);
  const { items, skipped } = await fetchItems({ token: FAKE_TOKEN, limit: 50, fetch });
  assert.deepEqual(skipped, []);
  assert.equal(calls[1].searchParams.get('after'), 'PAGE2');
  assert.deepEqual(items, [
    {
      id: '17900000000000006', provider: 'instagram', type: 'photo',
      caption: 'Late dinner with friends #foodie',
      permalink: 'https://www.instagram.com/p/FIXTURE006/',
      timestamp: '2026-10-29T18:22:10.000Z',
      thumbnail_url: 'https://fixtures.invalid/images/photo.jpg',
    },
    {
      id: '17900000000000005', provider: 'instagram', type: 'reel',
      caption: 'Boarding soon ✈️ #travel',
      permalink: 'https://www.instagram.com/reel/FIXTURE005/',
      timestamp: '2026-10-28T09:00:00.000Z',
      thumbnail_url: 'https://fixtures.invalid/images/reel.jpg', // thumbnail_url, never the .mp4
    },
    {
      id: '17900000000000004', provider: 'instagram', type: 'carousel',
      caption: 'Weekend in three pictures',
      permalink: 'https://www.instagram.com/p/FIXTURE004/',
      timestamp: '2026-10-27T12:30:00.000Z',
      thumbnail_url: 'https://fixtures.invalid/images/carousel.jpg',
    },
    {
      id: '17900000000000003', provider: 'instagram', type: 'video',
      caption: 'Studio session',
      permalink: 'https://www.instagram.com/p/FIXTURE003/',
      timestamp: '2026-10-26T20:15:00.000Z',
      thumbnail_url: 'https://fixtures.invalid/images/video.jpg', // media_url absent (licensed audio)
    },
    {
      id: '17900000000000002', provider: 'instagram', type: 'photo',
      caption: '', // caption field absent
      permalink: 'https://www.instagram.com/p/FIXTURE002/',
      timestamp: '2026-10-25T07:45:00.000Z',
      thumbnail_url: 'https://fixtures.invalid/images/empty-caption.jpg',
    },
    {
      id: '17900000000000001', provider: 'instagram', type: 'reel', // no media_product_type; /reel/ permalink
      caption: '',
      permalink: 'https://www.instagram.com/reel/FIXTURE001/',
      timestamp: '2026-10-24T16:00:00.000Z',
      thumbnail_url: 'https://fixtures.invalid/images/reel.jpg',
    },
  ]);
});

test('pagination stops at the limit without requesting the next page', async () => {
  const { fetch, calls } = mockFetch([[200, fixture('media.json')]]);
  const { items } = await fetchItems({ token: FAKE_TOKEN, limit: 2, fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual(items.map((item) => item.id), ['17900000000000006', '17900000000000005']);
});

test('pagination counts skipped entries toward the limit', async () => {
  const { fetch, calls } = mockFetch([[200, page([media({ id: '../bad' }), media({ id: '2' })], { next: 'x', cursors: { after: 'C' } })]]);
  const { items, skipped } = await fetchItems({ token: FAKE_TOKEN, limit: 1, fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual(items, []);
  assert.equal(skipped.length, 1);
});

test('pagination stops on an empty page or a missing cursor', async () => {
  for (const paging of [{ next: 'x', cursors: { after: '' } }, { next: 'x' }, { cursors: { after: 'C' } }]) {
    const { fetch, calls } = mockFetch([[200, page([media()], paging)]]);
    await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch });
    assert.equal(calls.length, 1, JSON.stringify(paging));
  }
  const { fetch, calls } = mockFetch([[200, page([], { next: 'x', cursors: { after: 'C' } })]]);
  await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch });
  assert.equal(calls.length, 1);
});

test('the next page URL is built from the cursor, never taken from paging.next', async () => {
  const evil = 'https://evil.example/steal?x=1';
  const { fetch, calls } = mockFetch([
    [200, page([media()], { next: evil, cursors: { after: 'C2' } })],
    [200, page([])],
  ]);
  await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch });
  assert.equal(calls[1].origin, 'https://graph.instagram.com');
  assert.equal(calls[1].searchParams.get('after'), 'C2');
});

test('duplicate IDs across pages are kept once', async () => {
  const { fetch } = mockFetch([
    [200, page([media({ id: '1' })], { next: 'x', cursors: { after: 'C' } })],
    [200, page([media({ id: '1' }), media({ id: '2' })])],
  ]);
  const { items } = await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch });
  assert.deepEqual(items.map((item) => item.id), ['1', '2']);
});

const SKIPS = [
  ['path traversal id', { id: '../x' }, 'id has characters that are not allowed in a file name'],
  ['id with a slash', { id: 'a/b' }, 'id has characters that are not allowed in a file name'],
  ['id longer than 64', { id: 'a'.repeat(65) }, 'id has characters that are not allowed in a file name'],
  ['non-Instagram permalink', { permalink: 'https://evil.example/p/A/' }, 'permalink is not an https://www.instagram.com/ URL'],
  ['javascript: permalink', { permalink: 'javascript:alert(1)' }, 'permalink is not an https://www.instagram.com/ URL'],
  ['unparseable permalink', { permalink: 'not a url' }, 'permalink is not an https://www.instagram.com/ URL'],
  ['story', { media_product_type: 'STORY' }, 'stories are not part of the feed'],
  ['unknown media type', { media_type: 'HOLOGRAM' }, 'unsupported media type "HOLOGRAM"'],
  ['image without media_url', { media_url: undefined }, 'no thumbnail URL available'],
  ['image with http media_url', { media_url: 'http://cdn.example/a.jpg' }, 'no thumbnail URL available'],
  ['image with garbage media_url', { media_url: '::' }, 'no thumbnail URL available'],
  ['video with only media_url (never download video)', { media_type: 'VIDEO', media_url: 'https://cdn.example/v.mp4' }, 'no thumbnail URL available'],
];

for (const [description, overrides, reason] of SKIPS) {
  test(`skips: ${description}`, () => {
    assert.deepEqual(normalizeMedia(media(overrides)), { skip: reason });
  });
}

test('64-character IDs with - and _ are accepted', () => {
  const id = `${'a'.repeat(62)}-_`;
  assert.equal(normalizeMedia(media({ id })).item.id, id);
});

test('a non-string caption becomes empty', () => {
  assert.equal(normalizeMedia(media({ caption: 42 })).item.caption, '');
});

test('instagram.com without www is a valid permalink', () => {
  assert.equal(normalizeMedia(media({ permalink: 'https://instagram.com/p/A/' })).item.permalink, 'https://instagram.com/p/A/');
});

test('video with a FEED product type stays video even with a /reel/ permalink', () => {
  const raw = media({ media_type: 'VIDEO', media_product_type: 'FEED', thumbnail_url: 'https://cdn.example/t.jpg', permalink: 'https://www.instagram.com/reel/A/' });
  assert.equal(normalizeMedia(raw).item.type, 'video');
});

const MALFORMED = [
  ['entry is not an object', 'oops', 'a media entry is not an object'],
  ['entry is null', null, 'a media entry is not an object'],
  ['entry is a list', [], 'a media entry is not an object'],
  ['missing id', media({ id: undefined }), 'a media entry has no id'],
  ['numeric id', media({ id: 5 }), 'a media entry has no id'],
  ['missing media_type', media({ media_type: undefined }), 'a media entry has no media_type'],
  ['empty permalink', media({ permalink: '' }), 'a media entry has no permalink'],
  ['missing timestamp', media({ timestamp: undefined }), 'a media entry has no timestamp'],
  ['bad timestamp format', media({ timestamp: 'yesterday' }), 'a media entry has an invalid timestamp'],
  ['impossible date', media({ timestamp: '2026-13-45T99:00:00+0000' }), 'a media entry has an invalid timestamp'],
];

for (const [description, raw, detail] of MALFORMED) {
  test(`malformed: ${description}`, () => {
    assert.throws(() => normalizeMedia(raw), {
      name: 'UserError',
      message: `Instagram API returned a malformed response (${detail}). Nothing was written.`,
    });
  });
}

test('malformed JSON fails the run', async () => {
  const { fetch } = mockFetch([[200, fixture('malformed.txt')]]);
  await assert.rejects(fetchItems({ token: FAKE_TOKEN, limit: 10, fetch }), {
    message: 'Instagram API returned a malformed response (body is not a JSON object). Nothing was written.',
  });
});

test('JSON without a data list fails the run', async () => {
  for (const body of ['{"items": []}', '"text"', 'null']) {
    const { fetch } = mockFetch([[200, body]]);
    await assert.rejects(fetchItems({ token: FAKE_TOKEN, limit: 10, fetch }), { name: 'UserError' }, body);
  }
});

test('expired token maps to the actionable message without retrying', async () => {
  const { fetch, calls } = mockFetch([[400, fixture('error-expired-token.json')]]);
  const { sleep, waits } = recordingSleep();
  await assert.rejects(fetchItems({ token: FAKE_TOKEN, limit: 10, fetch, sleep }), {
    name: 'UserError',
    message: TOKEN_MESSAGE,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('429 retries three times with the backoff schedule, then fails', async () => {
  const body = fixture('error-rate-limit.json');
  const { fetch, calls } = mockFetch([[429, body], [429, body], [429, body], [429, body]]);
  const { sleep, waits } = recordingSleep();
  await assert.rejects(requestJson(mediaUrl(FAKE_TOKEN, 5), { fetch, sleep }), {
    message: 'Instagram API request failed after 4 attempts (HTTP 429, code 4).',
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 4000, 16000]);
  assert.deepEqual(RETRY_DELAYS_MS, [1000, 4000, 16000]);
});

test('5xx retries and then succeeds', async () => {
  const { fetch, calls } = mockFetch([[500, fixture('error-server.json')], [503, 'Service Unavailable'], [200, page([media()])]]);
  const { sleep, waits } = recordingSleep();
  const { items } = await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch, sleep });
  assert.equal(items.length, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 4000]);
});

test('throttling codes reported as HTTP 400 are retried', async () => {
  const { fetch, calls } = mockFetch([[400, fixture('error-rate-limit.json')], [200, page([])]]);
  const { sleep } = recordingSleep();
  await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch, sleep });
  assert.equal(calls.length, 2);
});

test('network errors are retried, then reported by code', async () => {
  const failure = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
  const { fetch } = mockFetch([failure, failure, failure, new TypeError('fetch failed')]);
  const { sleep } = recordingSleep();
  await assert.rejects(requestJson(mediaUrl(FAKE_TOKEN, 5), { fetch, sleep }), {
    message: 'Instagram API request failed after 4 attempts (network error: TypeError).',
  });
});

test('other 4xx fail immediately with Meta\'s message', async () => {
  const { fetch, calls } = mockFetch([[400, fixture('error-bad-request.json')]]);
  const { sleep, waits } = recordingSleep();
  await assert.rejects(fetchItems({ token: FAKE_TOKEN, limit: 10, fetch, sleep }), {
    message: 'Instagram API request failed (HTTP 400, code 100): Tried accessing nonexisting field (bogus) on node type (Media)',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('4xx without a JSON error body fails immediately', async () => {
  const { fetch } = mockFetch([[404, 'Not Found']]);
  await assert.rejects(fetchItems({ token: FAKE_TOKEN, limit: 10, fetch }), {
    message: 'Instagram API request failed (HTTP 404)',
  });
});

test('error messages never contain the token or the request URL', async () => {
  const echo = JSON.stringify({ error: { code: 100, message: `bad request for ${FAKE_TOKEN}` } });
  const cases = [[[400, echo]], [[500, 'x'], [500, 'x'], [500, 'x'], [500, 'x']], [[200, 'not json']]];
  for (const responses of cases) {
    const { fetch } = mockFetch(responses);
    const { sleep } = recordingSleep();
    const err = await fetchItems({ token: FAKE_TOKEN, limit: 10, fetch, sleep }).catch((e) => e);
    assert.ok(!err.message.includes('graph.instagram.com'), err.message);
    // Meta's own message may echo input; the logger redacts it (see log.test.js).
    if (!responses[0][1].includes(FAKE_TOKEN)) assert.ok(!err.message.includes(FAKE_TOKEN));
  }
});

test('fake timers: the default sleep waits 1 s, 4 s, 16 s between attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fetch, calls } = mockFetch([[429, '{}'], [429, '{}'], [429, '{}'], [429, '{}']]);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const result = requestJson(mediaUrl(FAKE_TOKEN, 5), { fetch }).catch((err) => err);

  for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
    for (let k = 0; k < 5; k++) await settle();
    assert.equal(calls.length, i + 1);
    t.mock.timers.tick(delay - 1);
    for (let k = 0; k < 5; k++) await settle();
    assert.equal(calls.length, i + 1, `retried before ${delay} ms`);
    t.mock.timers.tick(1);
  }
  const err = await result;
  assert.equal(calls.length, 4);
  assert.equal(err.message, 'Instagram API request failed after 4 attempts (HTTP 429).');
});

test('fixture fetch serves pages, cursors and thumbnail files', async () => {
  const fetch = createFixtureFetch(FIXTURES);
  const { items } = await fetchItems({ token: 'fixture', limit: 50, fetch });
  assert.equal(items.length, 6);
  const missing = await fetch('https://fixtures.invalid/images/none.jpg');
  assert.equal(missing.status, 404);
});

test('fixture fetch refuses paths that leave the fixture folder', async () => {
  const fetch = createFixtureFetch(FIXTURES);
  for (const url of ['https://fixtures.invalid/a%2F..%2F..%2Fsecret', 'https://graph.instagram.com/v1/me/media?after=../../x']) {
    assert.equal((await fetch(url)).status, 400, url);
  }
  // The URL parser resolves dot segments before we see them, so these stay inside.
  for (const url of ['https://fixtures.invalid/../secret', 'https://fixtures.invalid/%2e%2e/secret']) {
    assert.equal((await fetch(url)).status, 404, url);
  }
});

test('fixture fetch rethrows read errors other than missing files', async () => {
  const readFile = async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  const fetch = createFixtureFetch(FIXTURES, { readFile });
  await assert.rejects(fetch('https://fixtures.invalid/x.jpg'), { code: 'EACCES' });
});
