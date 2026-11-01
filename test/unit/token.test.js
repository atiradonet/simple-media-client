import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_HOST, refreshToken } from '../../src/providers/instagram.js';
import { assessToken, expiryFailure, fingerprint, storeSecret } from '../../src/token.js';
import { FAKE_TOKEN } from '../helpers.js';

const NOW = Date.parse('2026-11-02T00:00:00.000Z');
const SIXTY_DAYS = 60 * 86400;
const base = { token: FAKE_TOKEN, secretsToken: null, record: null, now: NOW };
const NEW_TOKEN = 'IGAANewTokenFromRefresh0123456789';

test('an unchanged string means the token itself was extended', () => {
  const result = assessToken({ ...base, refreshed: { token: FAKE_TOKEN, expiresIn: SIXTY_DAYS } });
  assert.deepEqual(result, { record: null, store: false, expiresAt: '2027-01-01T00:00:00.000Z' });
});

test('a new string with secrets_token is stored', () => {
  const result = assessToken({ ...base, secretsToken: 'x', refreshed: { token: NEW_TOKEN, expiresIn: SIXTY_DAYS } });
  assert.deepEqual(result, { record: null, store: true, expiresAt: '2027-01-01T00:00:00.000Z' });
});

test('a new string without secrets_token starts counting from first sight, and keeps that date', () => {
  const refreshed = { token: NEW_TOKEN, expiresIn: SIXTY_DAYS };
  const first = assessToken({ ...base, refreshed });
  assert.equal(first.untracked, true);
  assert.equal(first.store, false);
  assert.deepEqual(first.record, { fingerprint: fingerprint(FAKE_TOKEN), expires_at: '2027-01-01T00:00:00.000Z' });

  const later = assessToken({ ...base, refreshed, record: first.record, now: NOW + 30 * 86400_000 });
  assert.equal(later.untracked, false);
  assert.equal(later.expiresAt, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(later.record, first.record);
});

test('rotating the secret starts a new count', () => {
  const old = { fingerprint: fingerprint('previous-token'), expires_at: '2026-11-05T00:00:00.000Z' };
  const result = assessToken({ ...base, record: old, refreshed: { token: NEW_TOKEN, expiresIn: SIXTY_DAYS } });
  assert.equal(result.expiresAt, '2027-01-01T00:00:00.000Z');
});

test('a failed refresh keeps the record and reports only a date it knows', () => {
  const mine = { fingerprint: fingerprint(FAKE_TOKEN), expires_at: '2026-11-05T00:00:00.000Z' };
  assert.deepEqual(assessToken({ ...base, record: mine, refreshed: null }), { record: mine, store: false, expiresAt: mine.expires_at });
  const other = { ...mine, fingerprint: 'other' };
  assert.deepEqual(assessToken({ ...base, record: other, refreshed: null }), { record: other, store: false, expiresAt: null });
  assert.deepEqual(assessToken({ ...base, refreshed: null }), { record: null, store: false, expiresAt: null });
});

test('the fingerprint does not contain the token', () => {
  assert.equal(fingerprint(FAKE_TOKEN).length, 16);
  assert.ok(!FAKE_TOKEN.includes(fingerprint(FAKE_TOKEN)));
});

test('expiryFailure fires at 14 days or fewer and names the date', () => {
  const at = (days) => new Date(NOW + days * 86400_000).toISOString();
  assert.equal(expiryFailure({ expiresAt: null, now: NOW, secretName: 'S' }), null);
  assert.equal(expiryFailure({ expiresAt: at(15), now: NOW, secretName: 'S' }), null);
  assert.match(expiryFailure({ expiresAt: at(14), now: NOW, secretName: 'S' }), /^The access token expires on 2026-11-16 \(14 days left\)\. .*update the S secret, or set the secrets_token input/);
});

test('refreshToken calls the documented endpoint and maps the response', async () => {
  let called;
  const fetch = async (url) => {
    called = new URL(url);
    return new Response(JSON.stringify({ access_token: NEW_TOKEN, token_type: 'bearer', expires_in: SIXTY_DAYS }));
  };
  assert.deepEqual(await refreshToken({ token: FAKE_TOKEN, fetch }), { token: NEW_TOKEN, expiresIn: SIXTY_DAYS });
  assert.equal(called.host, API_HOST);
  assert.equal(called.pathname, '/refresh_access_token');
  assert.equal(called.searchParams.get('grant_type'), 'ig_refresh_token');
});

test('refreshToken rejects a malformed response', async () => {
  for (const body of [{ expires_in: 5 }, { access_token: '', expires_in: 5 }, { access_token: 'x' }, { access_token: 'x', expires_in: 0 }]) {
    await assert.rejects(refreshToken({ token: FAKE_TOKEN, fetch: async () => new Response(JSON.stringify(body)) }), { name: 'UserError', message: /malformed/ });
  }
});

test('storeSecret passes the value over stdin, not argv, with a minimal environment', async () => {
  const calls = [];
  let stdin = '';
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    setImmediate(() => callback(null, '', ''));
    return { stdin: { end: (value) => { stdin = value; } } };
  };
  await storeSecret({
    name: 'INSTAGRAM_TOKEN', value: NEW_TOKEN, repository: 'o/r', secretsToken: 'pat',
    env: { PATH: '/bin', HOME: '/h', INPUT_TOKEN: FAKE_TOKEN }, execFile,
  });
  assert.equal(stdin, NEW_TOKEN);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, ['secret', 'set', 'INSTAGRAM_TOKEN', '--repo', 'o/r']);
  assert.ok(!calls[0].args.includes(NEW_TOKEN));
  assert.deepEqual(calls[0].options.env, { PATH: '/bin', HOME: '/h', GH_TOKEN: 'pat' });
});

test('storeSecret reports gh failures', async () => {
  const execFile = (command, args, options, callback) => {
    setImmediate(() => callback(new Error('exit 1'), '', 'HTTP 403\n'));
    return { stdin: { end() {} } };
  };
  await assert.rejects(storeSecret({ name: 'S', value: 'v', repository: 'o/r', secretsToken: 'p', env: {}, execFile }), { stderr: 'HTTP 403' });
});
