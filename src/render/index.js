// The feed's front page: posts grouped by category, in config order.
import { escapeHtml, safeHttpsUrl } from './escape.js';
import { renderPage } from './page.js';
import { createSlugger, formatDate } from './text.js';

const PAGE_PATH = /^p\/[a-z]+-[A-Za-z0-9_-]{1,64}\.html$/;
const DATA_IMAGE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

const newestFirst = (a, b) =>
  a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// Config categories first (file order), then the fallback, then categories
// that only old items still carry, alphabetically. Empty groups are dropped.
export function groupItems(items, categoryNames, fallback) {
  const groups = new Map();
  for (const item of [...items].sort(newestFirst)) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const known = [...categoryNames, fallback];
  const leftovers = [...groups.keys()].filter((name) => !known.includes(name)).sort();
  return [...new Set([...known, ...leftovers])]
    .filter((name) => groups.has(name))
    .map((name) => ({ name, items: groups.get(name) }));
}

function entry(item) {
  if (!PAGE_PATH.test(item.page)) throw new Error(`Item ${item.id}: unexpected page path.`);
  // Decorative: the link text right next to it already says what the post is.
  const image = DATA_IMAGE.test(item.tn ?? '') ? `<img src="${item.tn}" alt="" width="56" height="56">` : '';
  return `<li><a href="${item.page}">${image}<span><span class="t">${escapeHtml(item.title)}</span> <time datetime="${escapeHtml(item.timestamp)}">${formatDate(item.timestamp)}</time></span></a></li>`;
}

export function renderIndexPage({ site, categoryNames, fallback, items }) {
  const groups = groupItems(items, categoryNames, fallback);
  const slug = createSlugger();
  const sections = groups.map((group) => ({ ...group, id: slug(group.name) }));
  const profile = site.profile_url ? safeHttpsUrl(site.profile_url) : null;

  const header = `<header>
<h1>${escapeHtml(site.title)}</h1>
${site.description ? `<p class="intro">${escapeHtml(site.description)}</p>\n` : ''}${profile ? `<p class="intro"><a href="${profile}" rel="noopener noreferrer">Profile on Instagram</a></p>\n` : ''}</header>`;

  const main =
    sections.length === 0
      ? '<p>Nothing here yet. New posts appear after the next daily update.</p>'
      : `<nav aria-label="Categories">
<ul>
${sections.map((s) => `<li><a href="#${s.id}">${escapeHtml(s.name)}</a> (${s.items.length})</li>`).join('\n')}
</ul>
</nav>
${sections
  .map(
    (s) => `<section aria-labelledby="${s.id}">
<h2 id="${s.id}">${escapeHtml(s.name)}</h2>
<ul class="feed">
${s.items.map(entry).join('\n')}
</ul>
</section>`,
  )
  .join('\n')}`;

  return renderPage({
    site,
    title: site.title,
    description: site.description || `Recent posts from ${site.title}.`,
    base: '',
    header,
    main,
  });
}
