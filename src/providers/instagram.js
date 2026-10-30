// Instagram adapter: Instagram API with Instagram Login (graph.instagram.com).
// Field and error-code findings are in docs/decisions.md (section 17.1).
import { UserError } from '../errors.js';

export const name = 'instagram';
export const API_HOST = 'graph.instagram.com';
export const API_VERSION = 'v26.0';
export const FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_product_type',
  'media_url',
  'thumbnail_url',
  'permalink',
  'timestamp',
];
export const RETRY_DELAYS_MS = [1000, 4000, 16000];
export const TOKEN_MESSAGE =
  'Token expired or invalid; regenerate it and update the INSTAGRAM_TOKEN secret.';

const TOKEN_ERROR_CODE = 190;
// Graph reports throttling with these codes, often as HTTP 400 rather than 429.
const THROTTLE_CODES = new Set([4, 17, 32, 613]);
// IDs become file names, so anything outside this set is rejected.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const PERMALINK_HOSTS = new Set(['www.instagram.com', 'instagram.com']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function malformed(detail) {
  return new UserError(`Instagram API returned a malformed response (${detail}). Nothing was written.`);
}

export function mediaUrl(token, limit, after = null) {
  const url = new URL(`https://${API_HOST}/${API_VERSION}/me/media`);
  url.searchParams.set('fields', FIELDS.join(','));
  url.searchParams.set('limit', String(limit));
  if (after) url.searchParams.set('after', after);
  url.searchParams.set('access_token', token);
  return url.toString();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// One GET with the retry policy from the brief: 429, 5xx, throttling codes and
// network failures retry after 1 s, 4 s, 16 s; anything else fails at once.
// Never puts the URL or the raw body into an error: the URL holds the token.
export async function requestJson(url, { fetch, sleep = defaultSleep }) {
  for (let attempt = 0; ; attempt++) {
    let failure;
    let response = null;
    try {
      response = await fetch(url);
    } catch (err) {
      failure = `network error: ${err.code ?? err.name}`;
    }

    if (response) {
      const body = parseJson(await response.text());
      const error = body?.error;
      if (error?.code === TOKEN_ERROR_CODE) throw new UserError(TOKEN_MESSAGE);
      if (response.ok) {
        if (body === null || typeof body !== 'object') throw malformed('body is not a JSON object');
        return body;
      }
      failure = `HTTP ${response.status}${Number.isInteger(error?.code) ? `, code ${error.code}` : ''}`;
      const retryable =
        response.status === 429 || response.status >= 500 || THROTTLE_CODES.has(error?.code);
      if (!retryable) {
        const detail = typeof error?.message === 'string' ? `: ${error.message.slice(0, 200)}` : '';
        throw new UserError(`Instagram API request failed (${failure})${detail}`);
      }
    }

    if (attempt >= RETRY_DELAYS_MS.length) {
      throw new UserError(`Instagram API request failed after ${attempt + 1} attempts (${failure}).`);
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

function mapType(raw) {
  switch (raw.media_type) {
    case 'IMAGE':
      return 'photo';
    case 'CAROUSEL_ALBUM':
      return 'carousel';
    case 'VIDEO':
      // media_product_type may be missing with Instagram Login (decisions.md 17.1);
      // the permalink path still tells a Reel apart.
      if (raw.media_product_type === 'REELS') return 'reel';
      if (raw.media_product_type === undefined && new URL(raw.permalink).pathname.startsWith('/reel/')) {
        return 'reel';
      }
      return 'video';
    default:
      return null;
  }
}

function isHttps(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isInstagramPermalink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && PERMALINK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// Returns { item } for a usable post, { skip } with a reason for one we leave
// out, and throws when the entry is not shaped like Instagram media at all.
export function normalizeMedia(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw malformed('a media entry is not an object');
  }
  for (const field of ['id', 'media_type', 'permalink', 'timestamp']) {
    if (typeof raw[field] !== 'string' || raw[field] === '') {
      throw malformed(`a media entry has no ${field}`);
    }
  }
  if (!TIMESTAMP.test(raw.timestamp) || Number.isNaN(Date.parse(raw.timestamp))) {
    throw malformed('a media entry has an invalid timestamp');
  }

  const id = raw.id;
  if (!ID_PATTERN.test(id)) return { skip: 'id has characters that are not allowed in a file name' };
  if (!isInstagramPermalink(raw.permalink)) return { skip: 'permalink is not an https://www.instagram.com/ URL' };
  if (raw.media_product_type === 'STORY') return { skip: 'stories are not part of the feed' };

  const type = mapType(raw);
  if (!type) return { skip: `unsupported media type ${JSON.stringify(raw.media_type).slice(0, 40)}` };

  // Never fall back to media_url for videos: that is the video file itself.
  const thumbnail = type === 'video' || type === 'reel' ? raw.thumbnail_url : raw.media_url;
  if (!isHttps(thumbnail)) return { skip: 'no thumbnail URL available' };

  return {
    item: {
      id,
      provider: name,
      permalink: raw.permalink,
      caption: typeof raw.caption === 'string' ? raw.caption : '',
      timestamp: new Date(raw.timestamp).toISOString(),
      type,
      thumbnail_url: thumbnail,
    },
  };
}

// Fetch up to `limit` newest posts. Returns normalized items newest-first as
// the API gives them, plus the entries that were skipped and why.
export async function fetchItems({ token, limit, fetch = globalThis.fetch, sleep = defaultSleep }) {
  const items = [];
  const skipped = [];
  const seen = new Set();
  let url = mediaUrl(token, limit);

  while (url) {
    const body = await requestJson(url, { fetch, sleep });
    if (!Array.isArray(body.data)) throw malformed('no data list');

    for (const raw of body.data) {
      if (seen.size >= limit) break;
      const result = normalizeMedia(raw);
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      if (result.item) items.push(result.item);
      else skipped.push({ id: raw.id.slice(0, 64), reason: result.skip });
    }

    // Build the next URL from the cursor ourselves instead of following
    // paging.next, so the token only ever goes to a URL we constructed.
    const after = body.paging?.cursors?.after;
    const hasNext = typeof body.paging?.next === 'string' && typeof after === 'string' && after !== '';
    url = hasNext && seen.size < limit && body.data.length > 0 ? mediaUrl(token, limit, after) : null;
  }
  return { items, skipped };
}
