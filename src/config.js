import { readFileSync } from 'node:fs';
import { LineCounter, parseDocument } from 'yaml';
import { UserError } from './errors.js';

export class ConfigError extends UserError {
  get name() {
    return 'ConfigError';
  }
}

export const MEDIA_TYPES = ['photo', 'video', 'reel', 'carousel'];
export const THUMB_FORMATS = ['webp', 'jpeg'];

export const DEFAULT_THEME = {
  paper: '#f3ede2',
  ink: '#1c1814',
  muted: '#7a6f63',
  accent: '#d9542b',
  paper_dark: '#14110f',
  ink_dark: '#f1e9dc',
  muted_dark: '#8f8374',
  accent_dark: '#f0714a',
};

const TOP_KEYS = ['provider', 'site', 'output', 'fetch', 'thumbnails', 'fallback', 'categories'];
const SITE_KEYS = ['title', 'description', 'language', 'profile_url', 'contact_email', 'theme'];
const OUTPUT_KEYS = ['dir', 'max_items'];
const FETCH_KEYS = ['limit', 'backfill'];
const THUMB_KEYS = ['width', 'tiny_width', 'format', 'quality', 'max_bytes'];
const CATEGORY_KEYS = ['name', 'hashtags', 'keywords', 'media'];

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
// Deliberately loose: it only has to catch obvious slips, not prove deliverability.
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
// A relative path of plain segments, so output can never escape the repo.
const OUTPUT_DIR = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

function formatPath(path) {
  return path
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : i === 0 ? part : `.${part}`))
    .join('');
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validation walks plain JS values and records problems with their key path;
// the YAML document is only consulted afterwards to attach line numbers.
function createValidator() {
  const problems = [];
  const fail = (path, message) => problems.push({ path, message });

  function mapping(value, path, allowedKeys) {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
      fail(path, `must be a mapping, got ${describe(value)}`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) {
        fail([...path, key], `unknown key; expected one of: ${allowedKeys.join(', ')}`);
      }
    }
    return value;
  }

  function string(value, path, { required = false, fallback = '', min = 0, max = 500 } = {}) {
    if (value === undefined || value === null) {
      if (required) fail(path, 'is required');
      return fallback;
    }
    if (typeof value !== 'string') {
      fail(path, `must be text, got ${describe(value)}`);
      return fallback;
    }
    const text = value.trim();
    if (required && text === '') {
      fail(path, 'must not be empty');
      return fallback;
    }
    if (text.length < min || text.length > max) {
      fail(path, `must be ${min} to ${max} characters, got ${text.length}`);
      return fallback;
    }
    return text;
  }

  function integer(value, path, { fallback, min, max }) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value)) {
      fail(path, `must be a whole number, got ${describe(value)}`);
      return fallback;
    }
    if (value < min || value > max) {
      fail(path, `must be between ${min} and ${max}, got ${value}`);
      return fallback;
    }
    return value;
  }

  function oneOf(value, path, { fallback, allowed }) {
    if (value === undefined || value === null) return fallback;
    if (!allowed.includes(value)) {
      fail(path, `must be one of: ${allowed.join(', ')}; got ${describe(value)}`);
      return fallback;
    }
    return value;
  }

  function list(value, path) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      fail(path, `must be a list, got ${describe(value)}`);
      return [];
    }
    return value;
  }

  return { problems, fail, mapping, string, integer, oneOf, list };
}

function validateTheme(v, raw) {
  const path = ['site', 'theme'];
  const theme = v.mapping(raw, path, Object.keys(DEFAULT_THEME));
  const result = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME)) {
    const value = theme[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !COLOR.test(value)) {
      v.fail([...path, key], `must be a color like #rgb or #rrggbb, got ${describe(value)}`);
      continue;
    }
    result[key] = value.toLowerCase();
  }
  return result;
}

function validateSite(v, raw) {
  if (raw === undefined || raw === null) {
    v.fail(['site'], 'is required (with at least title and contact_email)');
    return { title: '', description: '', language: 'en', profile_url: null, contact_email: '', theme: { ...DEFAULT_THEME } };
  }
  const site = v.mapping(raw, ['site'], SITE_KEYS);

  const language = v.string(site.language, ['site', 'language'], { fallback: 'en', max: 35 });
  if (language && !LANGUAGE.test(language)) {
    v.fail(['site', 'language'], `must be a language tag like "en" or "pt-BR", got "${language}"`);
  }

  const profileUrl = v.string(site.profile_url, ['site', 'profile_url'], { max: 500 });
  if (profileUrl && !/^https:\/\/[^\s"'<>]+$/.test(profileUrl)) {
    v.fail(['site', 'profile_url'], `must be an https:// URL, got "${profileUrl}"`);
  }

  const email = v.string(site.contact_email, ['site', 'contact_email'], { required: true, max: 254 });
  if (email && !EMAIL.test(email)) {
    v.fail(['site', 'contact_email'], `must be an email address, got "${email}"`);
  }

  return {
    title: v.string(site.title, ['site', 'title'], { required: true, max: 100 }),
    description: v.string(site.description, ['site', 'description'], { max: 300 }),
    language,
    profile_url: profileUrl || null,
    contact_email: email,
    theme: validateTheme(v, site.theme),
  };
}

function validateTerms(v, raw, path, { stripHash = false } = {}) {
  const terms = [];
  v.list(raw, path).forEach((entry, i) => {
    const entryPath = [...path, i];
    // YAML reads `[2024]` as a number; a year is a reasonable hashtag or keyword.
    let term = typeof entry === 'number' ? String(entry) : entry;
    if (typeof term !== 'string') {
      v.fail(entryPath, `must be text, got ${describe(entry)}`);
      return;
    }
    term = term.trim();
    if (stripHash) term = term.replace(/^#/, '');
    if (term === '') {
      v.fail(entryPath, 'must not be empty');
      return;
    }
    if (stripHash && /\s/.test(term)) {
      v.fail(entryPath, `hashtags cannot contain spaces, got "${term}"`);
      return;
    }
    terms.push(term);
  });
  return terms;
}

function validateCategories(v, raw) {
  const seen = new Map();
  return v.list(raw, ['categories']).flatMap((entry, i) => {
    const path = ['categories', i];
    if (!isPlainObject(entry)) {
      v.fail(path, `must be a mapping with a name, got ${describe(entry)}`);
      return [];
    }
    v.mapping(entry, path, CATEGORY_KEYS);
    const name = v.string(entry.name, [...path, 'name'], { required: true, min: 1, max: 40 });
    if (name) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        v.fail([...path, 'name'], `"${name}" is already used by categories[${seen.get(key)}]; names must be unique (case-insensitive)`);
      } else {
        seen.set(key, i);
      }
    }

    const problemsBefore = v.problems.length;
    const hashtags = validateTerms(v, entry.hashtags, [...path, 'hashtags'], { stripHash: true });
    const keywords = validateTerms(v, entry.keywords, [...path, 'keywords']);
    const media = [];
    v.list(entry.media, [...path, 'media']).forEach((value, j) => {
      const type = v.oneOf(value, [...path, 'media', j], { fallback: null, allowed: MEDIA_TYPES });
      if (type) media.push(type);
    });

    // Skip when a rule was already reported as invalid: one message is enough.
    if (hashtags.length + keywords.length + media.length === 0 && v.problems.length === problemsBefore) {
      v.fail(path, `${name ? `category "${name}"` : 'this category'} needs at least one of: hashtags, keywords, media`);
    }
    return [{ name, hashtags, keywords, media }];
  });
}

export function validateConfig(raw, { providers = ['instagram'] } = {}) {
  const v = createValidator();
  if (!isPlainObject(raw)) {
    v.fail([], `must be a mapping of settings, got ${describe(raw ?? null)}`);
    return { config: null, problems: v.problems };
  }
  v.mapping(raw, [], TOP_KEYS);

  const output = v.mapping(raw.output, ['output'], OUTPUT_KEYS);
  const fetch = v.mapping(raw.fetch, ['fetch'], FETCH_KEYS);
  const thumbs = v.mapping(raw.thumbnails, ['thumbnails'], THUMB_KEYS);

  const dir = v.string(output.dir, ['output', 'dir'], { fallback: 'feed', max: 100 });
  if (dir && !OUTPUT_DIR.test(dir)) {
    v.fail(['output', 'dir'], `must be a relative folder like "feed" (letters, digits, - and _), got "${dir}"`);
  }

  const limit = v.integer(fetch.limit, ['fetch', 'limit'], { fallback: 50, min: 1, max: 100 });
  const width = v.integer(thumbs.width, ['thumbnails', 'width'], { fallback: 480, min: 64, max: 1080 });

  const config = {
    provider: v.oneOf(raw.provider, ['provider'], { fallback: null, allowed: providers }),
    site: validateSite(v, raw.site),
    output: {
      dir,
      max_items: v.integer(output.max_items, ['output', 'max_items'], { fallback: 200, min: 1, max: 2000 }),
    },
    fetch: {
      limit,
      backfill: v.integer(fetch.backfill, ['fetch', 'backfill'], { fallback: Math.min(20, limit), min: 0, max: limit }),
    },
    thumbnails: {
      width,
      tiny_width: v.integer(thumbs.tiny_width, ['thumbnails', 'tiny_width'], { fallback: 96, min: 16, max: width }),
      format: v.oneOf(thumbs.format, ['thumbnails', 'format'], { fallback: 'webp', allowed: THUMB_FORMATS }),
      quality: v.integer(thumbs.quality, ['thumbnails', 'quality'], { fallback: 75, min: 1, max: 100 }),
      max_bytes: v.integer(thumbs.max_bytes, ['thumbnails', 'max_bytes'], { fallback: 40000, min: 1000, max: 1000000 }),
    },
    fallback: v.string(raw.fallback, ['fallback'], { required: true, min: 1, max: 40 }),
    categories: validateCategories(v, raw.categories),
  };
  return { config, problems: v.problems };
}

function lineOf(doc, lineCounter, path) {
  // Walk up to the nearest ancestor that exists in the file (a missing key has
  // no line of its own; its parent does).
  for (let depth = path.length; depth > 0; depth--) {
    const node = doc.getIn(path.slice(0, depth), true);
    if (node?.range) return lineCounter.linePos(node.range[0]).line;
  }
  return 0; // top level, or a missing top-level key: no line to point at
}

export function parseConfig(text, { file = 'simple-media.yml', providers } = {}) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    // With a LineCounter attached, the parser always reports a position.
    const line = first.linePos[0].line;
    const detail = first.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new ConfigError(`${file}: YAML syntax error (line ${line}): ${detail}`);
  }

  const { config, problems } = validateConfig(doc.toJS(), { providers });
  if (problems.length > 0) {
    // List problems in file order, so the message reads top to bottom like the file.
    const located = problems.map(({ path, message }) => ({
      where: path.length > 0 ? formatPath(path) : '(top level)',
      line: lineOf(doc, lineCounter, path),
      message,
    }));
    located.sort((a, b) => a.line - b.line);
    const lines = located.map(({ where, line, message }) =>
      `${file}: ${where}: ${message}${line ? ` (line ${line})` : ''}`,
    );
    throw new ConfigError(lines.join('\n'));
  }
  return config;
}

// `file` is the name shown in messages: the path as the user wrote it.
export function loadConfig(path, { file = path, readFile = readFileSync, providers } = {}) {
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConfigError(`${file}: config file not found.`);
    throw new ConfigError(`${file}: cannot read config file (${err.code ?? err.message}).`);
  }
  return parseConfig(text, { file, providers });
}
