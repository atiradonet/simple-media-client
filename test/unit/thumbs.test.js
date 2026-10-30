import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INSTALL_HINT,
  MAX_DOWNLOAD_BYTES,
  createThumbnailer,
  detectCoder,
  encodeArgs,
  preflight,
  supportsWebpWrite,
} from '../../src/thumbs.js';
import { createFixtureFetch } from '../../src/providers/fixtures.js';
import { tempDir } from '../helpers.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/instagram');
const IMAGES = join(FIXTURES, 'images');
const SETTINGS = { width: 480, tiny_width: 96, format: 'webp', quality: 75, max_bytes: 40000 };

// Tests that run the real ImageMagick skip themselves when it is missing; CI installs it.
const tool = await preflight().catch(() => null);
const needsMagick = { skip: tool ? false : 'ImageMagick not installed' };

function identify(bytes) {
  const [command, args] = tool.command === 'magick' ? ['magick', ['identify']] : ['identify', []];
  return execFileSync(command, [...args, '-format', '%m %w %h', '-'], { input: bytes }).toString();
}

const decode = (uri) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
const item = (name, extra = {}) => ({
  id: name,
  provider: 'instagram',
  thumbnail_url: `https://fixtures.invalid/images/${name}`,
  ...extra,
});

// execFile stand-in: records calls, answers from `respond(command, args)`.
function stubExecFile(respond) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    Promise.resolve()
      .then(() => respond(command, args))
      .then((out) => callback(null, Buffer.from(out), Buffer.from('')))
      .catch((err) => callback(err, Buffer.from(''), Buffer.from(err.stderr ?? '')));
  };
  return { execFile, calls };
}

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const WEBP_LISTING = '   Format  Module    Mode  Description\n     WEBP* WEBP      rw+   WebP Image Format (libwebp 1.6.0)\n';

test('detectCoder recognizes JPEG, PNG and WebP by their bytes only', () => {
  assert.equal(detectCoder(readFileSync(join(IMAGES, 'photo.jpg'))), 'jpeg');
  assert.equal(detectCoder(readFileSync(join(IMAGES, 'small.png'))), 'png');
  assert.equal(detectCoder(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(detectCoder(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(detectCoder(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null);
  assert.equal(detectCoder(Buffer.alloc(0)), null);
});

test('supportsWebpWrite reads the mode column', () => {
  assert.equal(supportsWebpWrite(WEBP_LISTING), true);
  assert.equal(supportsWebpWrite('     WEBP  WEBP      r--   WebP Image Format'), false);
  assert.equal(supportsWebpWrite('     JPEG* JPEG      rw-   Joint Photographic'), false);
  assert.equal(supportsWebpWrite(''), false);
});

test('preflight prefers magick and keeps WebP when it can write it', async () => {
  const { execFile } = stubExecFile((command, args) => (args[0] === '-version' ? 'Version: ImageMagick 7.1' : WEBP_LISTING));
  assert.deepEqual(await preflight({ execFile }), { command: 'magick', format: 'webp' });
});

test('preflight falls back to convert (ImageMagick 6)', async () => {
  const { execFile, calls } = stubExecFile((command, args) => {
    if (command === 'magick') throw enoent();
    return args[0] === '-version' ? 'Version: ImageMagick 6.9.12' : WEBP_LISTING;
  });
  assert.deepEqual(await preflight({ execFile }), { command: 'convert', format: 'webp' });
  assert.deepEqual(calls.map((c) => c.command), ['magick', 'convert', 'convert']);
});

test('preflight fails with the install step when ImageMagick is missing', async () => {
  const { execFile } = stubExecFile(() => {
    throw enoent();
  });
  await assert.rejects(preflight({ execFile }), {
    name: 'UserError',
    message: `ImageMagick is not installed. ${INSTALL_HINT}`,
  });
});

test('preflight rejects a convert that is not ImageMagick', async () => {
  const { execFile } = stubExecFile((command) => {
    if (command === 'magick') throw enoent();
    return 'Converts FAT volumes to NTFS.';
  });
  await assert.rejects(preflight({ execFile }), { message: /^ImageMagick is not installed\./ });
});

test('preflight falls back to JPEG when WebP cannot be written', async () => {
  const noWebp = stubExecFile((command, args) => (args[0] === '-version' ? 'ImageMagick' : '     JPEG* JPEG rw-'));
  assert.deepEqual(await preflight({ execFile: noWebp.execFile }), { command: 'magick', format: 'jpeg' });
  const listFails = stubExecFile((command, args) => {
    if (args[0] === '-version') return 'ImageMagick';
    throw new Error('boom');
  });
  assert.deepEqual(await preflight({ execFile: listFails.execFile }), { command: 'magick', format: 'jpeg' });
});

test('preflight skips the format check when JPEG is configured', async () => {
  const { execFile, calls } = stubExecFile(() => 'ImageMagick');
  assert.deepEqual(await preflight({ execFile, format: 'jpeg' }), { command: 'magick', format: 'jpeg' });
  assert.equal(calls.length, 1);
});

test('encodeArgs names the decoder, orients, shrinks only, strips and writes to stdout', () => {
  assert.deepEqual(encodeArgs({ input: '/tmp/x/source.png', coder: 'png', width: 480, format: 'webp', quality: 75 }), [
    'png:/tmp/x/source.png[0]', '-auto-orient', '-resize', '480x>', '-strip', '-quality', '75', 'webp:-',
  ]);
});

test('encodeArgs adds a libwebp target size for WebP only', () => {
  const base = { input: 'in', coder: 'jpeg', width: 480, quality: 65, targetSize: 38000 };
  assert.deepEqual(encodeArgs({ ...base, format: 'webp' }).slice(-3), ['-define', 'webp:target-size=38000', 'webp:-']);
  assert.ok(!encodeArgs({ ...base, format: 'jpeg' }).includes('-define'));
});

test('shell safety: every subprocess call gets a command and an argument array', async (t) => {
  const { execFile, calls } = stubExecFile((command, args) => (args[0] === '-version' ? 'ImageMagick' : 'x'.repeat(100)));
  const stubTool = await preflight({ execFile, format: 'jpeg' });
  const thumbnail = createThumbnailer({
    settings: SETTINGS, tool: stubTool, execFile, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t),
  });
  // A hostile-looking ID must not reach any argument.
  await thumbnail(item('photo.jpg', { id: '$(rm -rf ~)' }));
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(typeof call.command, 'string');
    assert.ok(Array.isArray(call.args), 'args must be an array');
    assert.ok(call.args.every((arg) => typeof arg === 'string'));
    assert.ok(!call.args.some((arg) => arg.includes('$(')), JSON.stringify(call.args));
    assert.equal(call.options.shell, undefined);
  }
});

test('max_bytes: lowers quality in steps of 10 down to the floor, then fails', async (t) => {
  // Output size tracks quality: 1000 bytes per quality point.
  const { execFile, calls } = stubExecFile((command, args) => 'x'.repeat(Number(args[args.indexOf('-quality') + 1]) * 1000));
  const thumbnail = createThumbnailer({
    settings: { ...SETTINGS, max_bytes: 20000 }, tool: { command: 'magick', format: 'webp' },
    execFile, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t),
  });
  await assert.rejects(thumbnail(item('photo.jpg')), {
    name: 'UserError',
    message: 'Thumbnail for instagram item photo.jpg failed: the 480px image is 30000 bytes at quality 30, ' +
      'over thumbnails.max_bytes (20000). Raise thumbnails.max_bytes or lower thumbnails.width.',
  });
  const qualities = calls.map((c) => c.args[c.args.indexOf('-quality') + 1]);
  assert.deepEqual(qualities, ['75', '65', '55', '45', '35', '30']);
  // The first attempt uses quality alone; every retry also sets the WebP target size.
  const targets = calls.map((c) => c.args.find((a) => a.startsWith('webp:target-size=')) ?? null);
  assert.deepEqual(targets, [null, ...Array(5).fill('webp:target-size=19000')]);
});

test('max_bytes: stops at the first quality that fits; tiny uses the configured quality', async (t) => {
  const { execFile, calls } = stubExecFile((command, args) => 'x'.repeat(Number(args[args.indexOf('-quality') + 1]) * 1000));
  const thumbnail = createThumbnailer({
    settings: { ...SETTINGS, max_bytes: 56000 }, tool: { command: 'magick', format: 'webp' },
    execFile, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t),
  });
  const result = await thumbnail(item('photo.jpg'));
  const steps = calls.map((c) => [c.args[3], c.args[6]]);
  assert.deepEqual(steps, [['480x>', '75'], ['480x>', '65'], ['480x>', '55'], ['96x>', '75']]);
  assert.equal(result.bytes, 55000 + 75000);
});

const DOWNLOAD_FAILURES = [
  ['HTTP error', async () => new Response('gone', { status: 404 }), 'download failed (HTTP 404)'],
  ['network error', async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }); }, 'download failed (ECONNRESET)'],
  ['network error without a code', async () => { throw new TypeError('fetch failed'); }, 'download failed (TypeError)'],
  ['declared too large', async () => new Response('x', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } }), `image is larger than ${MAX_DOWNLOAD_BYTES} bytes`],
  ['actually too large', async () => new Response(Buffer.alloc(MAX_DOWNLOAD_BYTES + 1)), `image is larger than ${MAX_DOWNLOAD_BYTES} bytes`],
  ['not an image', async () => new Response('<svg onload="alert(1)"/>'), 'the file is not a JPEG, PNG, or WebP image'],
];

for (const [description, fetch, reason] of DOWNLOAD_FAILURES) {
  test(`download failure: ${description}`, async (t) => {
    const { execFile, calls } = stubExecFile(() => 'x');
    const thumbnail = createThumbnailer({ settings: SETTINGS, tool: { command: 'magick', format: 'webp' }, execFile, fetch, tempRoot: tempDir(t) });
    await assert.rejects(thumbnail(item('a.jpg', { thumbnail_url: 'https://cdn.example/a.jpg?sig=SIGNED' })), {
      message: `Thumbnail for instagram item a.jpg failed: ${reason}.`,
    });
    assert.equal(calls.length, 0, 'ImageMagick must not run');
  });
}

test('ImageMagick failure is reported with its stderr and the temp folder is removed', async (t) => {
  const root = tempDir(t);
  const { execFile } = stubExecFile(() => {
    throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'improper image header' });
  });
  const thumbnail = createThumbnailer({ settings: SETTINGS, tool: { command: 'magick', format: 'webp' }, execFile, fetch: createFixtureFetch(FIXTURES), tempRoot: root });
  await assert.rejects(thumbnail(item('photo.jpg')), {
    message: 'Thumbnail for instagram item photo.jpg failed: ImageMagick could not convert it (improper image header).',
  });
  assert.deepEqual(readdirSync(root), []);
});

test('ImageMagick failure without stderr falls back to the exit code or message', async (t) => {
  for (const [err, shown] of [[Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'ETIMEDOUT'], [new Error('killed'), 'killed']]) {
    const { execFile } = stubExecFile(() => {
      throw err;
    });
    const thumbnail = createThumbnailer({ settings: SETTINGS, tool: { command: 'magick', format: 'webp' }, execFile, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t) });
    await assert.rejects(thumbnail(item('photo.jpg')), { message: new RegExp(`\\(${shown}\\)\\.$`) });
  }
});

// Real ImageMagick from here on.

test('resizes to the configured widths and encodes WebP', needsMagick, async (t) => {
  const thumbnail = createThumbnailer({ settings: SETTINGS, tool, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t) });
  const result = await thumbnail(item('photo.jpg'));
  assert.match(result.full, /^data:image\/(webp|jpeg);base64,/);
  const format = tool.format === 'webp' ? 'WEBP' : 'JPEG';
  assert.equal(identify(decode(result.full)), `${format} 480 600`);
  assert.equal(identify(decode(result.tiny)), `${format} 96 120`);
  assert.ok(decode(result.full).length <= SETTINGS.max_bytes);
  assert.equal(result.bytes, decode(result.full).length + decode(result.tiny).length);
});

test('encodes JPEG when configured, and never enlarges a small PNG', needsMagick, async (t) => {
  const thumbnail = createThumbnailer({ settings: SETTINGS, tool: { ...tool, format: 'jpeg' }, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t) });
  const result = await thumbnail(item('small.png'));
  assert.match(result.full, /^data:image\/jpeg;base64,/);
  assert.equal(identify(decode(result.full)), 'JPEG 320 240');
  assert.equal(identify(decode(result.tiny)), 'JPEG 96 72');
});

test('EXIF is stripped', needsMagick, async (t) => {
  const source = readFileSync(join(IMAGES, 'exif.jpg'));
  assert.ok(source.includes('FIXTURE-EXIF-MARKER'), 'fixture must carry EXIF');
  for (const format of ['webp', 'jpeg']) {
    const thumbnail = createThumbnailer({ settings: SETTINGS, tool: { ...tool, format }, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t) });
    const { full, tiny } = await thumbnail(item('exif.jpg'));
    for (const bytes of [decode(full), decode(tiny)]) {
      assert.equal(bytes.includes('FIXTURE-EXIF-MARKER'), false, format);
      assert.equal(bytes.includes('Exif\0\0'), false, format);
      assert.equal(bytes.includes('EXIF'), false, format);
    }
  }
});

test('the same input produces byte-identical output', needsMagick, async (t) => {
  const thumbnail = createThumbnailer({ settings: SETTINGS, tool, fetch: createFixtureFetch(FIXTURES), tempRoot: tempDir(t) });
  const first = await thumbnail(item('reel.jpg'));
  const second = await thumbnail(item('reel.jpg'));
  assert.deepEqual(second, first);
});

test('real max_bytes: a large image is re-encoded smaller to fit, or fails when it cannot', needsMagick, async (t) => {
  const dir = tempDir(t);
  execFileSync(tool.command, ['-seed', '7', '-size', '1080x1080', 'plasma:', '-quality', '95', join(dir, 'noise.jpg')]);
  const fetch = createFixtureFetch(dir);
  const noise = { id: 'noise', provider: 'instagram', thumbnail_url: 'https://fixtures.invalid/noise.jpg' };

  // Uncapped size first; then a cap well below it must still be met. This
  // holds on ImageMagick 6, which ignores -quality for WebP, via target size.
  const uncapped = createThumbnailer({ settings: { ...SETTINGS, max_bytes: 1e6 }, tool, fetch, tempRoot: dir });
  const natural = decode((await uncapped(noise)).full).length;
  const cap = Math.floor(natural * 0.6);
  const fits = createThumbnailer({ settings: { ...SETTINGS, max_bytes: cap }, tool, fetch, tempRoot: dir });
  const fitted = decode((await fits(noise)).full).length;
  assert.ok(fitted <= cap, `${fitted} bytes, cap ${cap} (uncapped ${natural})`);

  const impossible = createThumbnailer({ settings: { ...SETTINGS, max_bytes: 1000 }, tool, fetch, tempRoot: dir });
  await assert.rejects(impossible(noise), { message: /^Thumbnail for instagram item noise failed: the 480px image is \d+ bytes at quality 30, over thumbnails\.max_bytes \(1000\)\./ });
});
