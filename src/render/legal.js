// Plain-language privacy and data-deletion pages. A starting point, not legal
// advice; the README says so.
import { escapeHtml } from './escape.js';
import { renderPage, siteHeader } from './page.js';

function contact(site) {
  const email = escapeHtml(site.contact_email);
  return `<a href="mailto:${email}">${email}</a>`;
}

export function renderPrivacyPage({ site, fetchLimit }) {
  const name = escapeHtml(site.title);
  const main = `<h1>Privacy</h1>
<h2>What this feed shows</h2>
<p>This feed shows public posts from ${name}’s own Instagram account. It is updated once a day.</p>
<h2>What is stored</h2>
<p>For each post, the feed keeps the caption, the date, the link to the post on Instagram, and two small thumbnail images. It does not keep full-size photos or videos. It does not collect comments, likes, or anyone else’s posts, and it removes other people’s usernames from captions.</p>
<h2>Visitors</h2>
<p>This feed collects no data about visitors. It uses no cookies, analytics, or tracking, and its pages load nothing from other websites. The site is hosted on GitHub Pages, and GitHub may keep its own server logs.</p>
<h2>Removing a post</h2>
<p>If ${name} deletes a post on Instagram, the next daily update removes it here, as long as it is one of the account’s ${fetchLimit} most recent posts. For anything else, or to ask for a post to be removed, email ${contact(site)}.</p>
<p>See also: <a href="data-deletion.html">how to request data deletion</a>.</p>`;
  return renderPage({
    site,
    title: `Privacy · ${site.title}`,
    description: `What the ${site.title} feed stores, and how to have something removed.`,
    base: '',
    header: siteHeader(site, ''),
    main,
  });
}

export function renderDeletionPage({ site, fetchLimit }) {
  const name = escapeHtml(site.title);
  const main = `<h1>Data deletion</h1>
<p>This feed stores only what is described on the <a href="privacy.html">privacy page</a>: captions, dates, links, and small thumbnails of ${name}’s own public Instagram posts. It holds no data about visitors.</p>
<h2>How to request deletion</h2>
<ol>
<li>Email ${contact(site)} with a link to the post or a description of what you want removed.</li>
<li>The post and its thumbnails are removed from this feed, and you get a reply when it is done.</li>
</ol>
<h2>If you are the account holder</h2>
<p>Delete the post on Instagram. The next daily update removes it here, as long as it is one of your ${fetchLimit} most recent posts. Older posts can be removed by deleting their page from the site’s repository.</p>`;
  return renderPage({
    site,
    title: `Data deletion · ${site.title}`,
    description: `How to have data removed from the ${site.title} feed.`,
    base: '',
    header: siteHeader(site, ''),
    main,
  });
}
