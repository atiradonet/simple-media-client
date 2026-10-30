// Fixed inputs for the golden-file tests. scripts/update-goldens.js writes
// what these render to; test/unit/render.test.js checks the output still matches.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { renderIndexPage } from '../src/render/index.js';
import { renderItemPage } from '../src/render/item.js';
import { renderDeletionPage, renderPrivacyPage } from '../src/render/legal.js';
import { deriveTitle } from '../src/render/text.js';

export const GOLDEN_DIR = join(import.meta.dirname, 'fixtures/golden');
export const FULL = 'data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAADwAQCdASoIAAgAAoBCJagCdGuAAsz2t5gA/ryMuHVAMHnxYrqvxn51+P79vCzAAAA=';
export const TINY = 'data:image/webp;base64,UklGRkIAAABXRUJQVlA4IDYAAAAwAgCdASoEAAQAAoBCJZACdGuAt/8D0QCteAD+7vPR3p9sBglatLQosP1iDWSm6uzpywOgAAA=';

export const config = parseConfig(
  readFileSync(join(import.meta.dirname, 'fixtures/config/full.yml'), 'utf8'),
);

const POSTS = [
  { id: '1001', type: 'photo', category: 'Food', timestamp: '2026-10-29T18:22:10.000Z', caption: 'Late dinner with @anna and friends #foodie\nPasta, then more pasta.' },
  { id: '1002', type: 'reel', category: 'Travel', timestamp: '2026-10-28T09:00:00.000Z', caption: 'Boarding soon ✈️ #travel' },
  { id: '1003', type: 'carousel', category: 'Everyday', timestamp: '2026-10-27T12:30:00.000Z', caption: '' },
  { id: '1004', type: 'video', category: 'Video', timestamp: '2026-10-26T20:15:00.000Z', caption: '<script>alert("x")</script> & "quotes" \'single\' javascript:alert(1) </style>' },
  { id: '1005', type: 'photo', category: 'Retired category', timestamp: '2026-10-25T07:45:00.000Z', caption: `A very long first line ${'that keeps going '.repeat(10)}until it must be cut` },
];

export const items = POSTS.map((post) => ({
  id: post.id,
  provider: 'instagram',
  timestamp: post.timestamp,
  type: post.type,
  category: post.category,
  title: deriveTitle(post),
  permalink: `https://www.instagram.com/p/GOLDEN${post.id}/`,
  page: `p/instagram-${post.id}.html`,
  tn: TINY,
}));

export function renderGoldenFiles() {
  const site = config.site;
  const files = {
    'index.html': renderIndexPage({
      site,
      categoryNames: config.categories.map((c) => c.name),
      fallback: config.fallback,
      items,
    }),
    'privacy.html': renderPrivacyPage({ site, fetchLimit: config.fetch.limit }),
    'data-deletion.html': renderDeletionPage({ site, fetchLimit: config.fetch.limit }),
  };
  for (const [i, item] of items.entries()) {
    files[item.page] = renderItemPage({ site, item, caption: POSTS[i].caption, image: FULL });
  }
  return files;
}
