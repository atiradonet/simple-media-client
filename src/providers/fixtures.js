// Fixture mode: a stand-in for fetch that answers from files on disk, used by
// tests and the e2e workflow so no real token or network is needed.
//
//   https://<api host>/.../<name>?after=<cursor>  ->  <dir>/<name>-after-<cursor>.json
//   https://<api host>/.../<name>                 ->  <dir>/<name>.json
//   https://fixtures.invalid/<path>               ->  <dir>/<path>   (thumbnails)
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FIXTURE_HOST = 'fixtures.invalid';
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function fixturePath(url) {
  if (url.hostname === FIXTURE_HOST) return url.pathname.slice(1).split('/');
  const base = url.pathname.split('/').pop();
  const after = url.searchParams.get('after');
  return [after ? `${base}-after-${after}.json` : `${base}.json`];
}

export function createFixtureFetch(dir, { readFile = fsReadFile } = {}) {
  return async (input) => {
    const segments = fixturePath(new URL(input));
    // Fixture names come from URLs in fixture data; keep them inside `dir`.
    if (!segments.every((segment) => SAFE_SEGMENT.test(segment))) {
      return new Response('bad fixture path', { status: 400 });
    }
    try {
      return new Response(await readFile(join(dir, ...segments)), { status: 200 });
    } catch (err) {
      if (err.code === 'ENOENT') return new Response('no such fixture', { status: 404 });
      throw err;
    }
  };
}
