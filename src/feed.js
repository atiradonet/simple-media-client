// Turns a plan into the bytes of the feed, then puts them on disk. Everything
// is built in memory first, so a failure part way through writes nothing.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderIndexPage } from './render/index.js';
import { renderItemPage } from './render/item.js';
import { renderDeletionPage, renderPrivacyPage } from './render/legal.js';
import { deriveTitle } from './render/text.js';
import { pagePath, serializeState } from './state.js';

export function buildEntry(item, category, tn) {
  return {
    id: item.id,
    provider: item.provider,
    timestamp: item.timestamp,
    type: item.type,
    category,
    title: deriveTitle(item),
    permalink: item.permalink,
    page: pagePath(item.provider, item.id),
    tn,
  };
}

export function renderItemFile(site, entry, caption, image) {
  return renderItemPage({ site, item: entry, caption, image });
}

// The files every run rewrites. Unchanged bytes are not written (see syncFiles).
export function renderSharedFiles(config, state) {
  const { site, categories, fallback, fetch } = config;
  return {
    'index.json': serializeState(state),
    'index.html': renderIndexPage({
      site,
      categoryNames: categories.map((category) => category.name),
      fallback,
      items: state.items,
    }),
    'privacy.html': renderPrivacyPage({ site, fetchLimit: fetch.limit }),
    'data-deletion.html': renderDeletionPage({ site, fetchLimit: fetch.limit }),
  };
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Writes only files whose bytes differ. With `dryRun` it reports the same
// counts and touches nothing.
export async function syncFiles(root, { writes, deletes }, { dryRun = false } = {}) {
  const result = { written: 0, deleted: 0, bytes: 0 };
  for (const [relative, content] of Object.entries(writes)) {
    const path = join(root, relative);
    const bytes = Buffer.from(content);
    const current = await readIfPresent(path);
    if (current?.equals(bytes)) continue;
    result.written += 1;
    result.bytes += bytes.length;
    if (dryRun) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  for (const relative of deletes) {
    const path = join(root, relative);
    if ((await readIfPresent(path)) === null) continue;
    result.deleted += 1;
    if (!dryRun) await rm(path);
  }
  return result;
}
