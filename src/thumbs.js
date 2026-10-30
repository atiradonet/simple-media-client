// Thumbnail pipeline: download once at ingest (CDN URLs expire), resize with
// ImageMagick, strip metadata, and return data: URIs ready to embed.
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserError } from './errors.js';

export const INSTALL_HINT =
  'Add this step before the action in your workflow:\n' +
  '  - run: sudo apt-get update && sudo apt-get install -y imagemagick';
export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
export const QUALITY_STEP = 10;
export const QUALITY_FLOOR = 30;
// ImageMagick 6 (what Ubuntu ships) ignores -quality for WebP, so for WebP the
// retries also ask libwebp for a target size a little under the cap.
// See docs/decisions.md, "Thumbnail choices".
export const TARGET_SIZE_RATIO = 0.95;
const EXEC_OPTIONS = { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 };
const MIME = { webp: 'image/webp', jpeg: 'image/jpeg' };

// ImageMagick chooses a decoder from the file's contents, and some decoders
// (SVG, MSL, text) are risky on untrusted input. We accept only these
// formats and name the decoder explicitly.
const SIGNATURES = [
  { coder: 'jpeg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { coder: 'png', matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { coder: 'webp', matches: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

export function detectCoder(bytes) {
  return SIGNATURES.find((signature) => signature.matches(bytes))?.coder ?? null;
}

// Always argument arrays, never a shell string: nothing here is ever parsed
// by a shell, so a hostile file name or URL cannot inject a command.
function exec(execFile, command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, EXEC_OPTIONS, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr ?? '').trim();
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// `-list format` prints rows like "     WEBP* WEBP      rw+   WebP Image Format".
export function supportsWebpWrite(listing) {
  const row = String(listing).match(/^\s*WEBP\*?\s+\S+\s+([r-])([w-])/m);
  return row?.[2] === 'w';
}

// Find ImageMagick 7 (`magick`) or 6 (`convert`, what Ubuntu ships), and
// check for a WebP encoder. Fails early with the exact fix.
export async function preflight({ execFile = nodeExecFile, format = 'webp' } = {}) {
  let command = null;
  for (const candidate of ['magick', 'convert']) {
    try {
      const version = String(await exec(execFile, candidate, ['-version']));
      // On some systems `convert` is an unrelated tool; insist on ImageMagick.
      if (version.includes('ImageMagick')) {
        command = candidate;
        break;
      }
    } catch {
      // Not installed under this name; try the next one.
    }
  }
  if (!command) throw new UserError(`ImageMagick is not installed. ${INSTALL_HINT}`);

  let output = format;
  if (format === 'webp') {
    const listing = await exec(execFile, command, ['-list', 'format']).catch(() => '');
    if (!supportsWebpWrite(listing)) output = 'jpeg';
  }
  return { command, format: output };
}

export function encodeArgs({ input, coder, width, format, quality, targetSize = null }) {
  return [
    `${coder}:${input}[0]`, // explicit decoder; first frame only
    '-auto-orient', // apply EXIF rotation before -strip removes it
    '-resize',
    `${width}x>`, // shrink to width, never enlarge
    '-strip',
    '-quality',
    String(quality),
    ...(targetSize && format === 'webp' ? ['-define', `webp:target-size=${targetSize}`] : []),
    `${format}:-`,
  ];
}

async function download(fetch, url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`download failed (${err.code ?? err.name})`, { cause: err });
  }
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`image is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`image is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
  return bytes;
}

const dataUri = (format, bytes) => `data:${MIME[format]};base64,${bytes.toString('base64')}`;

// Returns async (item) => ({ full, tiny, bytes }). `tool` comes from preflight().
// Any failure throws a UserError naming the item, which fails the whole run:
// a run never commits a partial set of items.
export function createThumbnailer({ settings, tool, fetch = globalThis.fetch, execFile = nodeExecFile, tempRoot = tmpdir() }) {
  const { format, command } = tool;

  async function encode(input, coder, width, quality, targetSize) {
    return exec(execFile, command, encodeArgs({ input, coder, width, format, quality, targetSize }));
  }

  return async function thumbnail(item) {
    const fail = (reason) => new UserError(`Thumbnail for ${item.provider} item ${item.id} failed: ${reason}.`);
    // URLs carry signed query strings; they never go into messages.
    let bytes;
    try {
      bytes = await download(fetch, item.thumbnail_url);
    } catch (err) {
      throw fail(err.message);
    }
    const coder = detectCoder(bytes);
    if (!coder) throw fail('the file is not a JPEG, PNG, or WebP image');

    const dir = await mkdtemp(join(tempRoot, 'smc-thumb-'));
    try {
      const input = join(dir, `source.${coder}`);
      await writeFile(input, bytes);

      let quality = settings.quality;
      let full = await encode(input, coder, settings.width, quality).catch((err) => {
        throw fail(`ImageMagick could not convert it (${err.stderr || err.code || err.message})`);
      });
      // Re-encode at lower quality until it fits, down to a floor.
      const targetSize = Math.floor(settings.max_bytes * TARGET_SIZE_RATIO);
      while (full.length > settings.max_bytes && quality > QUALITY_FLOOR) {
        quality = Math.max(QUALITY_FLOOR, quality - QUALITY_STEP);
        full = await encode(input, coder, settings.width, quality, targetSize);
      }
      if (full.length > settings.max_bytes) {
        throw fail(
          `the ${settings.width}px image is ${full.length} bytes at quality ${quality}, over thumbnails.max_bytes ` +
            `(${settings.max_bytes}). Raise thumbnails.max_bytes or lower thumbnails.width`,
        );
      }
      const tiny = await encode(input, coder, settings.tiny_width, settings.quality);
      return { full: dataUri(format, full), tiny: dataUri(format, tiny), bytes: full.length + tiny.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
