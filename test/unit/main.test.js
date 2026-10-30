import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    name: 'Error',
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

test('run prints a summary, writes the step summary and the changed output', async (t) => {
  const dir = tempDir(t);
  const summaryPath = join(dir, 'summary.md');
  const outputPath = join(dir, 'output.txt');
  const { logger, all } = captureLogger({ summaryPath });
  const env = actionEnv({ dry_run: 'true', fixture_dir: 'x' }, { GITHUB_OUTPUT: outputPath });

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
