// One standalone page per post, written once when the post is first seen.
import { escapeHtml, safeHttpsUrl } from './escape.js';
import { renderPage, siteHeader } from './page.js';
import { altText, cleanCaption, excerpt, formatDate, PROVIDER_LABELS } from './text.js';

const DATA_IMAGE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

// `item` is the index.json record; `caption` and `image` (the 480px data URI)
// are only needed here, so they are passed separately.
export function renderItemPage({ site, item, caption, image }) {
  if (!DATA_IMAGE.test(image)) throw new Error(`Item ${item.id}: thumbnail is not an embeddable data URI.`);
  const permalink = safeHttpsUrl(item.permalink);
  if (!permalink) throw new Error(`Item ${item.id}: permalink is not an https URL.`);

  const text = cleanCaption(caption);
  const date = formatDate(item.timestamp);
  const provider = PROVIDER_LABELS[item.provider] ?? item.provider;
  const main = `<article>
<p class="label">${escapeHtml(item.category)} · <time datetime="${escapeHtml(item.timestamp)}">${date}</time></p>
<h1>${escapeHtml(item.title)}</h1>
<figure>
<img src="${image}" alt="${escapeHtml(altText({ title: item.title, caption: text, type: item.type }))}">
</figure>
${text ? `<p class="caption">${escapeHtml(text)}</p>\n` : ''}<p><a href="${permalink}" rel="noopener noreferrer">View on ${escapeHtml(provider)}</a></p>
</article>`;

  return renderPage({
    site,
    title: `${item.title} (${date}) · ${site.title}`,
    description: text ? excerpt(text) : `${item.title}, posted ${date}.`,
    base: '../',
    header: siteHeader(site, '../'),
    main,
  });
}
