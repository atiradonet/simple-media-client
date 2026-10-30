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

function workspace(t) {
  const dir = tempDir(t);
  copyFileSync(MINIMAL_CONFIG, join(dir, 'simple-media.yml'));
  return dir;
}

test('run fails on an invalid config before doing anything else', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'simple-media.yml'), 'fallback: X\n');
  const { logger } = captureLogger();
  await assert.rejects(run({ env: actionEnv({}, { GITHUB_WORKSPACE: dir }), logger }), {
    name: 'ConfigError',
    message: 'simple-media.yml: site: is required (with at least title and contact_email)',
  });
});

test('run accepts a matching config provider and rejects an unknown one', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'feed.yml'), 'provider: instagram\nsite:\n  title: T\n  contact_email: a@b.co\nfallback: X\n');
  const { logger } = captureLogger();
  const env = actionEnv({ config: 'feed.yml' }, { GITHUB_WORKSPACE: dir });
  await assert.doesNotReject(run({ env, logger }));
  writeFileSync(join(dir, 'feed.yml'), 'provider: tiktok\nsite:\n  title: T\n  contact_email: a@b.co\nfallback: X\n');
  await assert.rejects(run({ env, logger }), { name: 'ConfigError' });
});

test('run prints a summary, writes the step summary and the changed output', async (t) => {
  const dir = workspace(t);
  const summaryPath = join(dir, 'summary.md');
  const outputPath = join(dir, 'output.txt');
  const { logger, all } = captureLogger({ summaryPath });
  const env = actionEnv({ dry_run: 'true', fixture_dir: 'x' }, { GITHUB_OUTPUT: outputPath, GITHUB_WORKSPACE: dir });

  const result = await run({ env, logger });

  assert.equal(result.changed, false);
  assert.match(all(), /provider=instagram dry_run=true fixtures=on/);
  assert.match(readText(summaryPath), /\| instagram \| true \| 0 \| 0 \| 0 \| 0 \|/);
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
