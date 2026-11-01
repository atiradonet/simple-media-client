// The feed's only memory: feed/index.json. Parsing and planning are pure; the
// plan says what changes, and main.js carries it out.
import { readFile } from 'node:fs/promises';
import { UserError } from './errors.js';

export const STATE_VERSION = 1;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER = /^[a-z]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TEXT_FIELDS = ['type', 'category', 'title', 'permalink', 'tn'];

export const emptyState = () => ({ version: STATE_VERSION, items: [] });
export const pagePath = (provider, id) => `p/${provider}-${id}.html`;

const keyOf = (item) => `${item.provider}/${item.id}`;

// Newest first, ties by id. Plain string comparison: locale-aware ordering
// could differ between Node versions and break byte-identical output.
export function compareItems(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function itemProblem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'is not an object';
  if (typeof item.id !== 'string' || !ID.test(item.id)) return 'has an invalid id';
  if (typeof item.provider !== 'string' || !PROVIDER.test(item.provider)) return 'has an invalid provider';
  if (typeof item.timestamp !== 'string' || !TIMESTAMP.test(item.timestamp)) return 'has an invalid timestamp';
  // The page path decides which file a prune deletes, so it must be exactly
  // the one this item's id produces. A hand-edited "../../x" stops here.
  if (item.page !== pagePath(item.provider, item.id)) return 'has an unexpected page path';
  const field = TEXT_FIELDS.find((name) => typeof item[name] !== 'string');
  return field ? `has no ${field}` : null;
}

function tokenProblem(token) {
  const valid =
    token !== null &&
    typeof token === 'object' &&
    typeof token.fingerprint === 'string' &&
    typeof token.expires_at === 'string' &&
    TIMESTAMP.test(token.expires_at);
  return valid ? null : 'token is not a valid record';
}

export function parseState(text, file = 'index.json') {
  const fail = (detail) => new UserError(`${file}: ${detail}. Fix the file, or delete it to rebuild the feed.`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw fail('not valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw fail('not a JSON object');
  if (raw.version !== STATE_VERSION) throw fail(`unsupported version ${JSON.stringify(raw.version)}`);
  if (!Array.isArray(raw.items)) throw fail('items is not a list');
  raw.items.forEach((item, i) => {
    const problem = itemProblem(item);
    if (problem) throw fail(`item ${i + 1} ${problem}`);
  });
  const state = { version: STATE_VERSION, items: [...raw.items].sort(compareItems) };
  if (raw.token !== undefined) {
    const problem = tokenProblem(raw.token);
    if (problem) throw fail(problem);
    state.token = raw.token;
  }
  return state;
}

export async function loadState(path, { file = path, read = readFile } = {}) {
  let text;
  try {
    text = await read(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
  return parseState(text, file);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

// Sorted keys and a fixed indent, so an unchanged feed gives unchanged bytes.
export function serializeState(state) {
  return `${JSON.stringify(sortKeys({ ...state, items: [...state.items].sort(compareItems) }), null, 2)}\n`;
}

// Decide what a run changes (BRIEF.md section 11, steps 3, 4 and 6).
// `fetched` are normalized items; `skippedIds` are posts the adapter returned
// but could not use. They still exist, so they must not read as deleted.
export function planUpdate({ state, provider, fetched, skippedIds = [], backfill, maxItems }) {
  const known = new Set(state.items.map(keyOf));
  const returned = new Set([...fetched.map((item) => item.id), ...skippedIds]);
  const windowStart = fetched.reduce((oldest, item) => (item.timestamp < oldest ? item.timestamp : oldest), '\uffff');

  const isDeleted = (item) => item.provider === provider && item.timestamp >= windowStart && !returned.has(item.id);
  const removed = state.items.filter(isDeleted);
  const survivors = state.items.filter((item) => !isDeleted(item));

  // Posts older than the feed's oldest are not new: they are what backfill
  // left out or max_items dropped, and adding them would undo that.
  const own = survivors.filter((item) => item.provider === provider);
  const floor = own.reduce((oldest, item) => (item.timestamp < oldest ? item.timestamp : oldest), '\uffff');
  const unseen = fetched.filter((item) => !known.has(keyOf(item))).sort(compareItems);
  const candidates = own.length === 0 ? unseen.slice(0, backfill) : unseen.filter((item) => item.timestamp >= floor);

  // Capping here means a post that would be dropped at once costs no download.
  const inWindow = new Set([...survivors, ...candidates].sort(compareItems).slice(0, maxItems).map(keyOf));
  return {
    added: candidates.filter((item) => inWindow.has(keyOf(item))),
    removed,
    pruned: survivors.filter((item) => !inWindow.has(keyOf(item))),
    kept: survivors.filter((item) => inWindow.has(keyOf(item))),
  };
}
