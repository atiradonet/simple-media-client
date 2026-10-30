// The document shell every generated page shares.
import { escapeHtml } from './escape.js';
import { themeCss } from './theme.js';

// Belt and braces for self-containment: even if a bug let markup through,
// the browser would refuse to load or run anything external.
const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function renderPage({ site, title, description, base, header, main }) {
  const link = (href, text) => `<li><a href="${base}${href}">${text}</a></li>`;
  return `<!doctype html>
<html lang="${escapeHtml(site.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>
${themeCss(site.theme)}
</style>
</head>
<body>
<div class="wrap">
${header}
<main>
${main}
</main>
<footer>
<nav aria-label="Site">
<ul>
${link('index.html', 'All posts')}
${link('privacy.html', 'Privacy')}
${link('data-deletion.html', 'Data deletion')}
</ul>
</nav>
</footer>
</div>
</body>
</html>
`;
}

export function siteHeader(site, base) {
  return `<header>
<a class="site" href="${base}index.html">${escapeHtml(site.title)}</a>
</header>`;
}
