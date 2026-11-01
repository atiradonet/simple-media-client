// BRIEF.md 14.3 and 14.5: the real entrypoint, a real temporary git repo with a
// local bare remote, real ImageMagick, and a mock provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run } from '../../src/main.js';
import { parseState } from '../../src/state.js';
import { fingerprint } from '../../src/token.js';
import { accessibilityProblems, externalReferences, validationErrors } from '../output-checks.js';
import { actionEnv, captureLogger, FAKE_TOKEN, tempDir } from '../helpers.js';

const IMAGES = join(import.meta.dirname, '../fixtures/instagram/images');
const MAIN = join(import.meta.dirname, '../../src/main.js');
const NOW = Date.parse('2026-11-02T00:00:00.000Z');
const SIXTY_DAYS = 60 * 86400;

const CONFIG = (extra = '') => `site:
  title: Test Feed
  contact_email: owner@example.com
  profile_url: https://www.instagram.com/example/
fallback: Everyday
output:
  dir: feed
  max_items: 10
fetch:
  limit: 50
  backfill: 3
categories:
  - name: Food
    hashtags: [foodie]
  - name: Video
    media: [reel, video]
${extra}`;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A site repo with one commit, cloned from a local bare remote.
function siteRepo(t, config = CONFIG()) {
  const base = tempDir(t);
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(base, 'clone', '-q', remote, work);
  git(work, 'switch', '-q', '-c', 'main');
  writeFileSync(join(work, 'simple-media.yml'), config);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { base, remote, work };
}

const post = (id, day, caption = `Post ${id}`) => ({
  id,
  media_type: 'IMAGE',
  media_product_type: 'FEED',
  caption,
  media_url: `https://cdn.test/${id}.jpg`,
  permalink: `https://www.instagram.com/p/${id}/`,
  timestamp: `2026-10-${String(day).padStart(2, '0')}T12:00:00+0000`,
});

// A mock Instagram: `posts` can change between runs.
function mockProvider({ posts, refresh = { access_token: FAKE_TOKEN, token_type: 'bearer', expires_in: SIXTY_DAYS }, failImage = null }) {
  const server = { posts, refresh, failImage, images: 0 };
  server.fetch = async (url) => {
    const { host, pathname } = new URL(url);
    if (host === 'graph.instagram.com') {
      if (pathname === '/refresh_access_token') {
        return server.refresh ? new Response(JSON.stringify(server.refresh)) : new Response('{"error":{"code":100,"message":"too young"}}', { status: 400 });
      }
      return new Response(JSON.stringify({ data: server.posts }));
    }
    server.images += 1;
    if (pathname === `/${server.failImage}.jpg`) return new Response('gone', { status: 404 });
    return new Response(readFileSync(join(IMAGES, 'photo.jpg')));
  };
  return server;
}

async function runAction(repo, server, { inputs = {}, extra = {}, execFile, logger: given } = {}) {
  const capture = given ?? captureLogger();
  const env = { ...actionEnv(inputs, { GITHUB_WORKSPACE: repo.work, GITHUB_REPOSITORY: 'o/r', PATH: process.env.PATH, HOME: process.env.HOME, ...extra }) };
  const result = await run({ env, logger: capture.logger, fetch: server.fetch, sleep: async () => {}, execFile, now: () => NOW });
  return { result, ...capture };
}

function tree(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tree(path) : [path];
  });
}
const feedFiles = (repo) => tree(join(repo.work, 'feed')).map((path) => relative(join(repo.work, 'feed'), path)).sort();
const commitCount = (repo) => Number(git(repo.work, 'rev-list', '--count', 'HEAD'));
const remoteHead = (repo) => git(repo.remote, 'rev-parse', 'main');
const shared = ['data-deletion.html', 'index.html', 'index.json', 'privacy.html'];
const pages = (...ids) => ids.map((id) => `p/instagram-${id}.html`);
const threePosts = () => [post('c', 3), post('b', 2), post('a', 1)];

test('1. first run: backfill written, one commit pushed, expected tree', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: [post('e', 5), post('d', 4), ...threePosts()] });
  const outputPath = join(repo.base, 'output.txt');
  const { result, all } = await runAction(repo, server, { extra: { GITHUB_OUTPUT: outputPath } });

  assert.deepEqual(result, { fetched: 5, added: 3, removed: 0, kept: 0, changed: true });
  assert.deepEqual(feedFiles(repo), [...shared, ...pages('c', 'd', 'e')].sort());
  assert.equal(commitCount(repo), 2);
  assert.equal(git(repo.work, 'log', '-1', '--format=%s|%an'), 'feed: +3 new, -0 removed (instagram)|github-actions[bot]');
  assert.equal(remoteHead(repo), git(repo.work, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(outputPath, 'utf8'), 'changed=true\n');
  assert.equal(server.images, 3);
  assert.ok(!all().includes(FAKE_TOKEN));
});

test('generated files pass the validity, self-containment, size and accessibility checks', async (t) => {
  const repo = siteRepo(t);
  const hostile = post('h', 4, '<script>alert(1)</script> "><img src=x onerror=alert(1)> </style> javascript:alert(1)');
  await runAction(repo, mockProvider({ posts: [hostile, ...threePosts()] }));
  for (const file of feedFiles(repo).filter((name) => name.endsWith('.html'))) {
    const html = readFileSync(join(repo.work, 'feed', file), 'utf8');
    assert.deepEqual(await validationErrors(html, file), [], file);
    assert.deepEqual(externalReferences(html), [], file);
    assert.deepEqual(accessibilityProblems(html), [], file);
    assert.ok(Buffer.byteLength(html) < 60 * 1024, file);
    assert.ok(!html.includes('<script'), file);
  }
});

test('2. idempotence: identical data gives no commit, no file changes', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: [post('e', 5), post('d', 4), ...threePosts()] });
  await runAction(repo, server);
  const before = commitCount(repo);
  const snapshot = feedFiles(repo).map((name) => readFileSync(join(repo.work, 'feed', name), 'utf8'));
  server.images = 0;

  const { result, stdout } = await runAction(repo, server);

  assert.equal(result.changed, false);
  assert.equal(result.added, 0);
  assert.equal(commitCount(repo), before);
  assert.deepEqual(feedFiles(repo).map((name) => readFileSync(join(repo.work, 'feed', name), 'utf8')), snapshot);
  assert.equal(server.images, 0);
  assert.match(stdout.text(), /no changes/);
  assert.equal(git(repo.work, 'status', '--porcelain'), '');
});

test('3. new post: one new page, index updated, one commit', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts() });
  await runAction(repo, server);
  const before = commitCount(repo);

  server.posts = [post('z', 9, 'Dinner #foodie'), ...threePosts()];
  const { result } = await runAction(repo, server);

  assert.equal(result.added, 1);
  assert.equal(commitCount(repo), before + 1);
  assert.ok(feedFiles(repo).includes('p/instagram-z.html'));
  assert.equal(git(repo.work, 'log', '-1', '--format=%s'), 'feed: +1 new, -0 removed (instagram)');
  const state = parseState(readFileSync(join(repo.work, 'feed/index.json'), 'utf8'));
  assert.deepEqual(state.items.map((i) => i.id), ['z', 'c', 'b', 'a']);
  assert.equal(state.items[0].category, 'Food');
  assert.ok(readFileSync(join(repo.work, 'feed/index.html'), 'utf8').includes('p/instagram-z.html'));
});

test('4. deleted post: page deleted, index updated', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts() });
  await runAction(repo, server);

  server.posts = [post('c', 3), post('a', 1)];
  const { result } = await runAction(repo, server);

  assert.deepEqual(result, { fetched: 2, added: 0, removed: 1, kept: 2, changed: true });
  assert.ok(!feedFiles(repo).includes('p/instagram-b.html'));
  assert.ok(!readFileSync(join(repo.work, 'feed/index.html'), 'utf8').includes('instagram-b.html'));
  assert.equal(git(repo.work, 'log', '-1', '--format=%s'), 'feed: +0 new, -1 removed (instagram)');
  assert.equal(git(repo.remote, 'ls-tree', '-r', '--name-only', 'main', 'feed/p/instagram-b.html'), '');
});

test('5. rolling window: the oldest pages go past max_items', async (t) => {
  const repo = siteRepo(t, CONFIG().replace('max_items: 10', 'max_items: 3'));
  const server = mockProvider({ posts: threePosts() });
  await runAction(repo, server);

  server.posts = [post('e', 5), post('d', 4), ...threePosts()];
  const { result } = await runAction(repo, server);

  assert.equal(result.added, 2);
  assert.equal(result.removed, 2);
  assert.deepEqual(feedFiles(repo), [...shared, ...pages('c', 'd', 'e')].sort());
});

test('6. dry run: nothing written, nothing committed, no refresh, summary printed', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts() });
  const summaryPath = join(repo.base, 'summary.md');
  const refreshes = [];
  const fetch = server.fetch;
  server.fetch = async (url) => {
    if (url.includes('refresh_access_token')) refreshes.push(url);
    return fetch(url);
  };
  const before = commitCount(repo);
  const { logger, stdout } = captureLogger({ summaryPath });

  const { result } = await runAction(repo, server, { inputs: { dry_run: 'true' }, logger: { logger, stdout, all: () => stdout.text() } });

  assert.equal(result.changed, false);
  assert.equal(result.added, 3);
  assert.deepEqual(feedFiles(repo), []);
  assert.equal(commitCount(repo), before);
  assert.equal(git(repo.work, 'status', '--porcelain'), '');
  assert.deepEqual(refreshes, []);
  assert.match(readFileSync(summaryPath, 'utf8'), /\| instagram \| true \| 3 \| 3 \| 0 \| 0 \|/);
  assert.match(stdout.text(), /dry run, would write 7 files/);
});

test('7. failure atomicity: a thumbnail failure on the second of three writes nothing', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts(), failImage: 'b' });
  const before = commitCount(repo);

  await assert.rejects(runAction(repo, server), { name: 'UserError', message: 'Thumbnail for instagram item b failed: download failed (HTTP 404).' });

  assert.equal(server.images, 2);
  assert.deepEqual(feedFiles(repo), []);
  assert.equal(commitCount(repo), before);
  assert.equal(git(repo.work, 'status', '--porcelain'), '');
});

// Lands a competing commit on the remote just before the chosen pushes.
function racingExecFile(repo, raceOnPushes) {
  const other = join(repo.base, 'other');
  git(repo.base, 'clone', '-q', repo.remote, other);
  let pushes = 0;
  const execFile = (command, args, options, callback) => {
    if (command === 'git' && args.includes('push')) {
      pushes += 1;
      execFile.pushes = pushes;
      if (raceOnPushes.includes(pushes)) {
        writeFileSync(join(other, `race-${pushes}.txt`), 'someone else\n');
        git(other, 'pull', '-q', '--rebase', 'origin', 'main');
        git(other, 'add', '.');
        git(other, 'commit', '-q', '-m', `race ${pushes}`);
        git(other, 'push', '-q', 'origin', 'main');
      }
    }
    return nodeExecFile(command, args, options, callback);
  };
  return execFile;
}

test('8a. push race: one rebase, then success, without force', async (t) => {
  const repo = siteRepo(t);
  const execFile = racingExecFile(repo, [1]);
  const { result, stdout } = await runAction(repo, mockProvider({ posts: threePosts() }), { execFile });

  assert.equal(result.changed, true);
  assert.equal(execFile.pushes, 2);
  assert.match(stdout.text(), /push rejected; rebasing once onto origin\/main/);
  const log = git(repo.remote, 'log', '--format=%s', 'main').split('\n');
  assert.deepEqual(log, ['feed: +3 new, -0 removed (instagram)', 'race 1', 'init']);
});

test('8b. push race lost twice: a clear failure after exactly one retry', async (t) => {
  const repo = siteRepo(t);
  const execFile = racingExecFile(repo, [1, 2]);
  await assert.rejects(runAction(repo, mockProvider({ posts: threePosts() }), { execFile }), {
    name: 'UserError',
    message: /^git push was rejected again after one rebase: .*The next run will try again\.$/s,
  });
  assert.equal(execFile.pushes, 2);
  assert.ok(!git(repo.remote, 'log', '--format=%s', 'main').includes('feed:'));
});

test('8c. push race works from the shallow clone actions/checkout makes', async (t) => {
  const repo = siteRepo(t);
  const shallow = join(repo.base, 'shallow');
  git(repo.base, 'clone', '-q', '--depth', '1', `file://${repo.remote}`, shallow);
  const work = { ...repo, work: shallow };
  const execFile = racingExecFile(repo, [1]);
  const { result } = await runAction(work, mockProvider({ posts: threePosts() }), { execFile });
  assert.equal(result.changed, true);
  assert.deepEqual(git(repo.remote, 'log', '--format=%s', 'main').split('\n'), ['feed: +3 new, -0 removed (instagram)', 'race 1', 'init']);
});

test('a rebase conflict fails clearly and pushes nothing', async (t) => {
  const repo = siteRepo(t);
  const other = join(repo.base, 'other');
  git(repo.base, 'clone', '-q', repo.remote, other);
  const execFile = (command, args, options, callback) => {
    if (command === 'git' && args.includes('push') && !execFile.raced) {
      execFile.raced = true;
      execFileSync('mkdir', ['-p', join(other, 'feed')]);
      writeFileSync(join(other, 'feed/index.json'), 'conflict\n');
      git(other, 'add', '.');
      git(other, 'commit', '-q', '-m', 'conflict');
      git(other, 'push', '-q', 'origin', 'main');
    }
    return nodeExecFile(command, args, options, callback);
  };
  await assert.rejects(runAction(repo, mockProvider({ posts: threePosts() }), { execFile }), { name: 'UserError', message: /^Could not rebase onto origin\/main: .*Nothing was pushed\.$/s });
});

test('a push the remote refuses outright is not retried', async (t) => {
  const repo = siteRepo(t);
  writeFileSync(join(repo.remote, 'hooks/pre-receive'), '#!/bin/sh\necho "permission denied" >&2\nexit 1\n', { mode: 0o755 });
  const calls = [];
  const execFile = (command, args, options, callback) => {
    if (args.includes('fetch')) calls.push(args);
    return nodeExecFile(command, args, options, callback);
  };
  await assert.rejects(runAction(repo, mockProvider({ posts: threePosts() }), { execFile }), { name: 'UserError', message: /^git push failed: .*contents: write/s });
  assert.deepEqual(calls, []);
});

test('a detached checkout fails with a plain message', async (t) => {
  const repo = siteRepo(t);
  git(repo.work, 'checkout', '-q', '--detach');
  await assert.rejects(runAction(repo, mockProvider({ posts: threePosts() })), { name: 'UserError', message: /^Cannot commit: the checkout is not on a branch/ });
});

test('outside a git repo the failure says so', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'simple-media.yml'), CONFIG());
  await assert.rejects(runAction({ work: dir }, mockProvider({ posts: threePosts() })), { name: 'UserError', message: /^git failed while staging feed: / });
});

function runEntrypoint(repo, inputs, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_WORKSPACE: repo.work, ...actionEnv(inputs), ...extra };
  return spawnSync(process.execPath, [MAIN], { cwd: repo.work, env, encoding: 'utf8' });
}

test('9. config error: non-zero exit, plain message, no repo changes', (t) => {
  const repo = siteRepo(t, 'fallbak: X\n');
  const head = remoteHead(repo);
  const child = runEntrypoint(repo, {});
  assert.equal(child.status, 1);
  assert.match(child.stderr, /simple-media\.yml: fallbak: /);
  assert.ok(!child.stderr.includes('    at '));
  assert.equal(git(repo.work, 'status', '--porcelain'), '');
  assert.equal(remoteHead(repo), head);
});

test('the real entrypoint runs end to end in fixture mode and pushes', (t) => {
  const repo = siteRepo(t);
  const child = runEntrypoint(repo, { fixture_dir: join(import.meta.dirname, '../fixtures/instagram') });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(git(repo.remote, 'log', '-1', '--format=%s', 'main'), 'feed: +3 new, -0 removed (instagram)');
  assert.ok(!(child.stdout + child.stderr).includes(FAKE_TOKEN));
});

test('10. token near expiry without secrets_token: fails with the date, after pushing the feed', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts(), refresh: { access_token: FAKE_TOKEN, expires_in: 10 * 86400 } });
  const outputPath = join(repo.base, 'output.txt');
  await assert.rejects(runAction(repo, server, { extra: { GITHUB_OUTPUT: outputPath } }), {
    name: 'UserError',
    message: /^The access token expires on 2026-11-12 \(10 days left\)\. Generate a new long-lived token and update the INSTAGRAM_TOKEN secret/,
  });
  assert.equal(git(repo.remote, 'log', '-1', '--format=%s', 'main'), 'feed: +3 new, -0 removed (instagram)');
  assert.equal(readFileSync(outputPath, 'utf8'), 'changed=true\n');
});

test('a new token string without secrets_token is tracked in state and fails 46 days later', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts(), refresh: { access_token: 'IGAARotatedToken0123456789abcdefgh', expires_in: SIXTY_DAYS } });
  const { stdout, all } = await runAction(repo, server);
  assert.match(stdout.text(), /::warning::Instagram returned a new token string and secrets_token is not set/);
  assert.ok(!all().includes('IGAARotatedToken'));

  const text = readFileSync(join(repo.work, 'feed/index.json'), 'utf8');
  assert.deepEqual(parseState(text).token, { fingerprint: fingerprint(FAKE_TOKEN), expires_at: '2027-01-01T00:00:00.000Z' });
  assert.ok(!text.includes(FAKE_TOKEN));

  // The next day nothing changes: the record keeps its first date, so no commit.
  const before = commitCount(repo);
  const next = await run({
    env: actionEnv({}, { GITHUB_WORKSPACE: repo.work }), logger: captureLogger().logger,
    fetch: server.fetch, sleep: async () => {}, now: () => NOW + 86400_000,
  });
  assert.equal(next.changed, false);
  assert.equal(commitCount(repo), before);

  await assert.rejects(
    run({ env: actionEnv({}, { GITHUB_WORKSPACE: repo.work }), logger: captureLogger().logger, fetch: server.fetch, sleep: async () => {}, now: () => NOW + 46 * 86400_000 }),
    { name: 'UserError', message: /^The access token expires on 2027-01-01 \(14 days left\)/ },
  );
});

function fakeGh(result) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    if (command !== 'gh') return nodeExecFile(command, args, options, callback);
    const call = { args, options };
    calls.push(call);
    setImmediate(() => callback(result, '', result ? 'HTTP 403: Resource not accessible\n' : ''));
    return { stdin: { end: (value) => { call.stdin = value; } } };
  };
  return { execFile, calls };
}

test('a new token string with secrets_token is stored through gh and never logged', async (t) => {
  const repo = siteRepo(t);
  const fresh = 'IGAARotatedToken0123456789abcdefgh';
  const { execFile, calls } = fakeGh(null);
  const server = mockProvider({ posts: threePosts(), refresh: { access_token: fresh, expires_in: SIXTY_DAYS } });
  const { stdout, all } = await runAction(repo, server, { inputs: { secrets_token: 'github_pat_FakeForTests0123456789' }, execFile });

  assert.deepEqual(calls[0].args, ['secret', 'set', 'INSTAGRAM_TOKEN', '--repo', 'o/r']);
  assert.equal(calls[0].stdin, fresh);
  assert.match(stdout.text(), /stored the refreshed token in INSTAGRAM_TOKEN/);
  assert.ok(!all().includes(fresh));
  assert.ok(!all().includes('github_pat_FakeForTests'));
  assert.equal(parseState(readFileSync(join(repo.work, 'feed/index.json'), 'utf8')).token, undefined);
});

test('a failed secret store fails the run but still publishes the feed', async (t) => {
  const repo = siteRepo(t);
  const { execFile } = fakeGh(new Error('exit 1'));
  const server = mockProvider({ posts: threePosts(), refresh: { access_token: 'IGAARotatedToken0123456789abcdefgh', expires_in: SIXTY_DAYS } });
  await assert.rejects(runAction(repo, server, { inputs: { secrets_token: 'pat' }, execFile }), {
    name: 'UserError',
    message: /^Could not store the refreshed token in INSTAGRAM_TOKEN: HTTP 403.*Secrets write access/,
  });
  assert.equal(git(repo.remote, 'log', '-1', '--format=%s', 'main'), 'feed: +3 new, -0 removed (instagram)');
});

test('a refused refresh is a warning, not a failure', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts(), refresh: null });
  const { result, stdout } = await runAction(repo, server);
  assert.equal(result.changed, true);
  assert.match(stdout.text(), /::warning::Could not refresh the access token: Instagram API request failed \(HTTP 400, code 100\)/);
});

test('deleting an old page by hand removes the post from the index', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts() });
  await runAction(repo, server);
  rmSync(join(repo.work, 'feed/p/instagram-a.html'));
  server.posts = [post('c', 3), post('b', 2)];
  const { result } = await runAction(repo, server);
  assert.equal(result.removed, 1);
  assert.ok(!readFileSync(join(repo.work, 'feed/index.html'), 'utf8').includes('instagram-a.html'));
});

// --- 14.5 security

test('path traversal: a hostile id is rejected before any file operation', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: [post('../../evil', 3), post('ok', 2)] });
  const { result, stdout } = await runAction(repo, server);
  assert.equal(result.added, 1);
  assert.match(stdout.text(), /Skipped instagram item \.\.\/\.\.\/evil/);
  assert.deepEqual(tree(repo.base).filter((path) => path.includes('evil')), []);
});

test('path traversal: a tampered index.json cannot aim a delete outside the feed', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts() });
  await runAction(repo, server);
  const victim = join(repo.work, 'simple-media.yml');
  const path = join(repo.work, 'feed/index.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.items[0].page = '../simple-media.yml';
  writeFileSync(path, JSON.stringify(state));
  await assert.rejects(runAction(repo, server), { name: 'UserError', message: /index\.json: item 1 has an unexpected page path/ });
  assert.ok(existsSync(victim));
});

test('shell safety: every subprocess gets an argument array and no shell', async (t) => {
  const repo = siteRepo(t);
  const seen = [];
  const execFile = (command, args, options, callback) => {
    seen.push({ command, args, shell: options?.shell });
    return nodeExecFile(command, args, options, callback);
  };
  const server = mockProvider({ posts: [post('a', 1, '$(touch pwned); `touch pwned` && rm -rf /')] });
  await runAction(repo, server, { execFile });
  assert.ok(seen.some(({ command }) => command === 'git'));
  for (const { args, shell } of seen) {
    assert.ok(Array.isArray(args));
    assert.ok(!shell);
  }
  assert.ok(!existsSync(join(repo.work, 'pwned')));
});

test('secret hygiene: the token appears in no log, no file, and no git history', async (t) => {
  const repo = siteRepo(t);
  const server = mockProvider({ posts: threePosts() });
  const summaryPath = join(repo.base, 'summary.md');
  const capture = captureLogger({ summaryPath });
  await runAction(repo, server, { logger: capture });
  assert.ok(!capture.all().includes(FAKE_TOKEN));
  assert.ok(!readFileSync(summaryPath, 'utf8').includes(FAKE_TOKEN));
  for (const file of tree(join(repo.work, 'feed'))) assert.ok(!readFileSync(file, 'utf8').includes(FAKE_TOKEN), file);
  assert.ok(!git(repo.remote, 'log', '-p', 'main').includes(FAKE_TOKEN));
});

test('git subprocesses do not inherit the action inputs', async (t) => {
  const repo = siteRepo(t);
  const envs = [];
  const execFile = (command, args, options, callback) => {
    if (command === 'git') envs.push(options.env);
    return nodeExecFile(command, args, options, callback);
  };
  await runAction(repo, mockProvider({ posts: threePosts() }), { execFile });
  assert.ok(envs.length > 0);
  for (const env of envs) {
    assert.deepEqual(Object.keys(env).filter((key) => key.startsWith('INPUT_')), []);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  }
});
