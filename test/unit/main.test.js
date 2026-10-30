import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, readInputs, run, UserError } from '../../src/main.js';
import { actionEnv, captureLogger, FAKE_TOKEN, readText, tempDir } from '../helpers.js';

test('readInputs applies defaults', () => {
  assert.deepEqual(readInputs(actionEnv()), {
    provider: 'instagram',
    token: FAKE_TOKEN,
    config: 'simple-media.yml',
    dryRun: false,
    secretsToken: null,
    fixtureDir: null,
  });
});

test('readInputs rejects a missing token', () => {
  assert.throws(() => readInputs(actionEnv({ token: '  ' })), {
    name: 'UserError',
    message: 'Input "token" is required.',
  });
});

test('readInputs rejects an unknown provider', () => {
  assert.throws(
    () => readInputs(actionEnv({ provider: 'myspace' })),
    new UserError('Input "provider" must be one of: instagram. Got "myspace".'),
  );
});

test('readInputs rejects a non-boolean dry_run', () => {
  assert.throws(
    () => readInputs(actionEnv({ dry_run: 'yes' })),
    new UserError('Input "dry_run" must be "true" or "false", got "yes".'),
  );
});

const MINIMAL_CONFIG = join(import.meta.dirname, '../fixtures/config/minimal.yml');
const INSTAGRAM_FIXTURES = join(import.meta.dirname, '../fixtures/instagram');

// No test may reach the network; this fails loudly if one tries.
const noNetwork = () => {
  throw new Error('network access in a test');
};

function workspace(t) {
  const dir = tempDir(t);
  copyFileSync(MINIMAL_CONFIG, join(dir, 'simple-media.yml'));
  return dir;
}

test('run fails on an invalid config before doing anything else', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'simple-media.yml'), 'fallback: X\n');
  const { logger } = captureLogger();
  await assert.rejects(run({ env: actionEnv({}, { GITHUB_WORKSPACE: dir }), logger, fetch: noNetwork }), {
    name: 'ConfigError',
    message: 'simple-media.yml: site: is required (with at least title and contact_email)',
  });
});

test('run accepts a matching config provider and rejects an unknown one', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'feed.yml'), 'provider: instagram\nsite:\n  title: T\n  contact_email: a@b.co\nfallback: X\n');
  const { logger } = captureLogger();
  const env = actionEnv({ config: 'feed.yml', fixture_dir: INSTAGRAM_FIXTURES }, { GITHUB_WORKSPACE: dir });
  await assert.doesNotReject(run({ env, logger, fetch: noNetwork }));
  writeFileSync(join(dir, 'feed.yml'), 'provider: tiktok\nsite:\n  title: T\n  contact_email: a@b.co\nfallback: X\n');
  await assert.rejects(run({ env, logger, fetch: noNetwork }), { name: 'ConfigError' });
});

test('run prints a summary, writes the step summary and the changed output', async (t) => {
  const dir = workspace(t);
  const summaryPath = join(dir, 'summary.md');
  const outputPath = join(dir, 'output.txt');
  const { logger, all } = captureLogger({ summaryPath });
  const env = actionEnv(
    { dry_run: 'true', fixture_dir: INSTAGRAM_FIXTURES },
    { GITHUB_OUTPUT: outputPath, GITHUB_WORKSPACE: dir },
  );

  const result = await run({ env, logger, fetch: noNetwork });

  assert.equal(result.changed, false);
  assert.equal(result.fetched, 6);
  assert.match(all(), /provider=instagram dry_run=true fixtures=on/);
  assert.match(readText(summaryPath), /\| instagram \| true \| 6 \| 0 \| 0 \| 0 \|/);
  assert.equal(readText(outputPath), 'changed=false\n');
  assert.equal(all().includes(FAKE_TOKEN), false);
});

test('main reports a user error without a stack trace and sets the exit code', async (t) => {
  const dir = tempDir(t);
  const summaryPath = join(dir, 'summary.md');
  const writes = [];
  const restore = [process.stdout.write, process.stderr.write];
  process.stdout.write = process.stderr.write = (chunk) => writes.push(String(chunk));
  t.after(() => {
    [process.stdout.write, process.stderr.write] = restore;
    process.exitCode = 0;
  });

  await main(actionEnv({ token: '' }, { GITHUB_STEP_SUMMARY: summaryPath }));

  [process.stdout.write, process.stderr.write] = restore;
  assert.equal(process.exitCode, 1);
  assert.deepEqual(writes, ['::error::Input "token" is required.\n', 'Input "token" is required.\n']);
});

test('run warns about skipped items without failing', async (t) => {
  const dir = workspace(t);
  const { logger, stdout } = captureLogger();
  const page = {
    data: [
      { id: '../x', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/A/', timestamp: '2026-10-01T00:00:00+0000', media_url: 'https://cdn.example/a.jpg' },
    ],
  };
  const fetch = async () => new Response(JSON.stringify(page));
  const result = await run({ env: actionEnv({}, { GITHUB_WORKSPACE: dir }), logger, fetch });
  assert.equal(result.fetched, 0);
  assert.match(stdout.text(), /::warning::Skipped instagram item \.\.\/x: id has characters that are not allowed in a file name\./);
});

test('run fails on missing ImageMagick before any network request', async (t) => {
  const dir = workspace(t);
  const { logger } = captureLogger();
  const execFile = (command, args, options, callback) => callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(run({ env: actionEnv({}, { GITHUB_WORKSPACE: dir }), logger, fetch: noNetwork, execFile }), {
    name: 'UserError',
    message: /^ImageMagick is not installed\./,
  });
});

test('run warns when thumbnails fall back to JPEG', async (t) => {
  const dir = workspace(t);
  const { logger, stdout } = captureLogger();
  // ImageMagick without a WebP encoder; every encode returns a tiny fake image.
  const execFile = (command, args, options, callback) =>
    callback(null, Buffer.from(args[0] === '-version' ? 'ImageMagick 6' : args[0] === '-list' ? '' : 'img'), Buffer.from(''));
  const env = actionEnv({ fixture_dir: INSTAGRAM_FIXTURES }, { GITHUB_WORKSPACE: dir });
  await run({ env, logger, fetch: noNetwork, execFile });
  assert.match(stdout.text(), /::warning::ImageMagick cannot write WebP here; thumbnails will be JPEG\./);
  assert.match(stdout.text(), /thumbnails: 6 built with magick as jpeg, 36 bytes/);
});
