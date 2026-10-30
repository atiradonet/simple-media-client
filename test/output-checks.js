// Checks shared by the golden-output tests and, from M6, the integration tests
// that inspect a written feed folder. Each returns a list of problems.
import { HtmlValidate } from 'html-validate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const validator = new HtmlValidate(
  JSON.parse(readFileSync(join(import.meta.dirname, '../.htmlvalidate.json'), 'utf8')),
);

export async function validationErrors(html, name) {
  const report = await validator.validateString(html, name);
  return report.results.flatMap((result) =>
    result.messages.map((m) => `${name}:${m.line}:${m.column} ${m.ruleId}: ${m.message}`),
  );
}

// The only external URLs a page may contain: the post on Instagram and the
// profile, both as plain links.
const ALLOWED_EXTERNAL = /^https:\/\/(?:www\.)?instagram\.com\//;

export function externalReferences(html) {
  const problems = [];
  for (const [, tag, attr, value] of html.matchAll(/<(\w+)[^>]*?\s(src|href|srcset|poster|action|data)="([^"]*)"/g)) {
    const isLink = tag === 'a' && attr === 'href';
    if (value.startsWith('data:image/') && attr === 'src') continue;
    if (isLink && (value.startsWith('#') || value.startsWith('mailto:'))) continue;
    if (isLink && /^(?:\.\.\/)?[\w./-]+\.html(?:#[\w-]+)?$/.test(value) && !value.includes('//')) continue;
    if (isLink && ALLOWED_EXTERNAL.test(value)) continue;
    problems.push(`<${tag} ${attr}="${value.slice(0, 60)}">`);
  }
  for (const [, url] of html.matchAll(/url\(\s*['"]?([^'")]*)/g)) problems.push(`url(${url.slice(0, 60)})`);
  if (/<script\b/i.test(html)) problems.push('<script>');
  if (/<(?:link|iframe|object|embed|base)\b/i.test(html)) problems.push('external-capable element');
  if (/@import/i.test(html)) problems.push('@import');
  return problems;
}

export function accessibilityProblems(html) {
  const problems = [];
  if (!/<html lang="[a-z]{2,3}(?:-[A-Za-z0-9]+)*">/.test(html)) problems.push('missing lang');
  const h1s = html.match(/<h1\b/g) ?? [];
  if (h1s.length !== 1) problems.push(`expected one h1, found ${h1s.length}`);
  for (const landmark of ['header', 'main', 'nav', 'footer']) {
    if (!new RegExp(`<${landmark}\\b`).test(html)) problems.push(`missing <${landmark}>`);
  }
  for (const [img] of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt="[^"]*"/.test(img)) problems.push(`img without alt: ${img.slice(0, 60)}`);
  }
  // Headings must not skip levels on the way down.
  let previous = 0;
  for (const [, level] of html.matchAll(/<h([1-6])\b/g)) {
    if (Number(level) > previous + 1) problems.push(`heading jumps from h${previous} to h${level}`);
    previous = Number(level);
  }
  return problems;
}
