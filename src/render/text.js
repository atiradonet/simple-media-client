// Turning captions into the short strings pages need: titles, alt text,
// dates, anchors. Plain functions over plain data.
import { normalize } from '../normalize.js';

export const PROVIDER_LABELS = { instagram: 'Instagram', manual: 'the original post' };
const TYPE_LABELS = { photo: 'Photo', carousel: 'Photo set', video: 'Video', reel: 'Reel' };
const TITLE_MAX = 80;

// Other people's handles are not ours to publish (BRIEF.md section 3). An
// @ preceded by a word character is part of an email address and stays.
const MENTION = /(^|[^\p{L}\p{N}_@.])@[A-Za-z0-9._]{1,30}/gu;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;

export function cleanCaption(caption) {
  return String(caption ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(MENTION, '$1')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/u, '')}…`;
}

// Dates render as ISO yyyy-mm-dd in UTC: language-neutral, and independent of
// the ICU data in whatever Node version runs the action.
export function formatDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// First line of the cleaned caption without hashtags, shortened at a word.
export function deriveTitle({ caption, type, timestamp }) {
  const firstLine =
    cleanCaption(caption)
      .split('\n')
      .map((line) => line.replace(HASHTAG, '').replace(/\s+/g, ' ').trim())
      .find((line) => line !== '') ?? '';
  if (firstLine) return truncate(firstLine, TITLE_MAX);
  return `${TYPE_LABELS[type] ?? 'Post'} from ${formatDate(timestamp)}`;
}

export function altText({ title, caption, type }) {
  if (cleanCaption(caption) !== '' && title) return title;
  return type === 'video' || type === 'reel' ? 'Video thumbnail' : 'Photo';
}

export function excerpt(text, max = 160) {
  return truncate(cleanCaption(text).replace(/\s+/g, ' '), max);
}

// Anchor IDs for category headings. Unique within a page: a clash gets -2, -3.
export function createSlugger() {
  const used = new Set();
  return (name) => {
    const base = `c-${normalize(name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'category'}`;
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  };
}
