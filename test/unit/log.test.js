import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureLogger, FAKE_TOKEN, readText, tempDir } from '../helpers.js';

test('registered secrets never reach any stream', () => {
  const { logger, all } = captureLogger();
  logger.addSecret(FAKE_TOKEN);
  logger.info(`token is ${FAKE_TOKEN}`);
  logger.notice(`notice ${FAKE_TOKEN}`);
  logger.warning(`warning ${FAKE_TOKEN}`);
  logger.error(`error ${FAKE_TOKEN}`);
  logger.error(new Error(`thrown ${FAKE_TOKEN}`).message);
  assert.equal(all().includes(FAKE_TOKEN), false);
  assert.match(all(), /token is \*\*\*/);
});

test('token-shaped strings are redacted even when not registered', () => {
  const { logger, all } = captureLogger();
  logger.info('IGQWRNtokenlookingvalue1234567890abc');
  logger.info('EAAGtokenlookingvalue1234567890abcdef');
  logger.info('ghp_abcdefghijklmnopqrstuvwxyz0123');
  logger.info('github_pat_11ABCDEFG0123456789_abcdefghijk');
  logger.info('GET https://graph.instagram.com/me/media?fields=id&access_token=secretvalue&limit=5');
  assert.equal(
    all(),
    [
      '***',
      '***',
      '***',
      '***',
      'GET https://graph.instagram.com/me/media?fields=id&access_token=***&limit=5',
      '',
    ].join('\n'),
  );
});

test('a secret containing another secret is fully redacted', () => {
  const { logger, all } = captureLogger();
  logger.addSecret('abc');
  logger.addSecret('xxabcxx');
  logger.info('xxabcxx and abc');
  assert.equal(all(), '*** and ***\n');
});

test('empty and non-string secrets are ignored', () => {
  const { logger, all } = captureLogger();
  logger.addSecret('');
  logger.addSecret(undefined);
  logger.info('plain');
  assert.equal(all(), 'plain\n');
});

test('annotations escape workflow-command characters', () => {
  const { logger, stdout } = captureLogger();
  logger.warning('100% done\r\n::error::injected');
  assert.equal(stdout.text(), '::warning::100%25 done%0D%0A::error::injected\n');
});

test('error writes an annotation and a plain stderr line', () => {
  const { logger, stdout, stderr } = captureLogger();
  logger.error('boom');
  assert.equal(stdout.text(), '::error::boom\n');
  assert.equal(stderr.text(), 'boom\n');
});

test('mask mode emits add-mask for the runner', () => {
  const { logger, stdout } = captureLogger({ mask: true });
  logger.addSecret('s3cret-value');
  assert.equal(stdout.text(), '::add-mask::s3cret-value\n');
});

test('summary appends redacted markdown to the summary file', (t) => {
  const dir = tempDir(t);
  const summaryPath = join(dir, 'summary.md');
  const { logger } = captureLogger({ summaryPath });
  logger.addSecret(FAKE_TOKEN);
  logger.summary(`| a | ${FAKE_TOKEN} |`);
  assert.equal(readText(summaryPath), '| a | *** |\n');
});

test('summary is a no-op without a summary path', () => {
  const { logger, all } = captureLogger();
  logger.summary('ignored');
  assert.equal(all(), '');
});
