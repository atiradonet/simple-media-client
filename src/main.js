import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createClassifier } from './classify.js';
import { loadConfig } from './config.js';
import { buildEntry, renderItemFile, renderSharedFiles, syncFiles } from './feed.js';
import { commitAndPush, commitMessage, createGit } from './git.js';
import { createLogger } from './log.js';
import { UserError } from './errors.js';
import { createFixtureFetch } from './providers/fixtures.js';
import { getProvider, providerNames } from './providers/index.js';
import { compareItems, loadState, planUpdate } from './state.js';
import { createThumbnailer, preflight } from './thumbs.js';
import { assessToken, expiryFailure, storeSecret } from './token.js';

export { UserError };

function getInput(env, name, { required = false, fallback = '' } = {}) {
  const value = (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  if (required && value === '') throw new UserError(`Input "${name}" is required.`);
  return value === '' ? fallback : value;
}

function parseBoolean(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new UserError(`Input "${name}" must be "true" or "false", got "${value}".`);
}

export function readInputs(env) {
  const inputs = {
    provider: getInput(env, 'provider', { required: true }),
    token: getInput(env, 'token', { required: true }),
    config: getInput(env, 'config', { fallback: 'simple-media.yml' }),
    dryRun: parseBoolean('dry_run', getInput(env, 'dry_run', { fallback: 'false' })),
    secretsToken: getInput(env, 'secrets_token') || null,
    fixtureDir: getInput(env, 'fixture_dir') || null,
  };
  if (!providerNames().includes(inputs.provider)) {
    throw new UserError(
      `Input "provider" must be one of: ${providerNames().join(', ')}. Got "${inputs.provider}".`,
    );
  }
  return inputs;
}

function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// Refresh the token and store it if it changed. Returns the state record to
// keep and, if the owner must act, a message that fails the run at the end, so
// a token problem never costs today's feed update.
async function maintainToken({ provider, inputs, state, env, logger, fetch, sleep, execFile, now }) {
  let refreshed = null;
  try {
    refreshed = await provider.refreshToken({ token: inputs.token, fetch, sleep });
    logger.addSecret(refreshed.token);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    // Normal for a token under 24 hours old.
    logger.warning(`Could not refresh the access token: ${err.message}`);
  }
  const secretName = provider.TOKEN_SECRET;
  const assessed = assessToken({
    token: inputs.token,
    refreshed,
    secretsToken: inputs.secretsToken,
    record: state.token,
    now,
  });
  let failure = null;
  if (assessed.store) {
    try {
      await storeSecret({
        name: secretName,
        value: refreshed.token,
        repository: env.GITHUB_REPOSITORY,
        secretsToken: inputs.secretsToken,
        env,
        execFile,
      });
      logger.info(`token: stored the refreshed token in ${secretName}`);
    } catch (err) {
      failure = `Could not store the refreshed token in ${secretName}: ${err.stderr || err.code || err.message}. Check that secrets_token has Secrets write access to this repository.`;
    }
  }
  if (assessed.untracked) {
    logger.warning(
      `Instagram returned a new token string and secrets_token is not set, so it cannot be saved. The ${secretName} secret is treated as expiring on ${assessed.expiresAt.slice(0, 10)}.`,
    );
  }
  if (assessed.expiresAt) logger.info(`token: expires ${assessed.expiresAt.slice(0, 10)}`);
  return {
    record: assessed.record,
    failure: failure ?? expiryFailure({ expiresAt: assessed.expiresAt, now, secretName }),
  };
}

// `fetch`, `sleep`, `execFile` and `now` are injectable so tests never touch
// the network, wait, or need a particular ImageMagick or clock.
export async function run({ env = process.env, logger, fetch = globalThis.fetch, sleep, execFile, now = Date.now } = {}) {
  const inputs = readInputs(env);
  logger.addSecret(inputs.token);
  if (inputs.secretsToken) logger.addSecret(inputs.secretsToken);

  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const config = loadConfig(resolve(workspace, inputs.config), {
    file: inputs.config,
    providers: providerNames(),
  });
  if (config.provider && config.provider !== inputs.provider) {
    throw new UserError(
      `${inputs.config}: provider is "${config.provider}" but the workflow input is "${inputs.provider}". Make them match.`,
    );
  }

  logger.info(
    `simple-media-client: provider=${inputs.provider} dry_run=${inputs.dryRun}` +
      (inputs.fixtureDir ? ' fixtures=on' : ''),
  );

  // Before any network call, so a missing tool fails the run immediately.
  const tool = await preflight({ execFile, format: config.thumbnails.format });
  if (tool.format !== config.thumbnails.format) {
    logger.warning('ImageMagick cannot write WebP here; thumbnails will be JPEG.');
  }

  const root = join(workspace, config.output.dir);
  const loaded = await loadState(join(root, 'index.json'), { file: `${config.output.dir}/index.json` });
  // Deleting an item's page from the repo is how an owner removes an old post
  // by hand, so an entry without a page leaves the index too.
  const pageless = loaded.items.filter((item) => !existsSync(join(root, item.page)));
  const state = { ...loaded, items: loaded.items.filter((item) => !pageless.includes(item)) };

  const providerFetch = inputs.fixtureDir ? createFixtureFetch(resolve(workspace, inputs.fixtureDir)) : fetch;
  const provider = getProvider(inputs.provider);
  const { items, skipped } = await provider.fetchItems({
    token: inputs.token,
    limit: config.fetch.limit,
    fetch: providerFetch,
    sleep,
  });
  for (const { id, reason } of skipped) logger.warning(`Skipped ${inputs.provider} item ${id}: ${reason}.`);

  const plan = planUpdate({
    state,
    provider: inputs.provider,
    fetched: items,
    skippedIds: skipped.map(({ id }) => id),
    backfill: config.fetch.backfill,
    maxItems: config.output.max_items,
  });

  // A dry run changes nothing, and a refresh may rotate the token. Fixture runs
  // have no real token to refresh.
  const maintenance =
    inputs.dryRun || inputs.fixtureDir
      ? { record: state.token ?? null, failure: null }
      : await maintainToken({ provider, inputs, state, env, logger, fetch, sleep, execFile, now: now() });

  const classify = createClassifier(config);
  const thumbnail = createThumbnailer({ settings: config.thumbnails, tool, fetch: providerFetch, execFile });
  const writes = {};
  const entries = [];
  let thumbBytes = 0;
  for (const item of plan.added) {
    const thumb = await thumbnail(item);
    thumbBytes += thumb.bytes;
    const entry = buildEntry(item, classify(item), thumb.tiny);
    entries.push(entry);
    writes[entry.page] = renderItemFile(config.site, entry, item.caption, thumb.full);
    logger.info(`new: ${entry.page} [${entry.category}]`);
  }
  logger.info(`thumbnails: ${plan.added.length} built with ${tool.command} as ${tool.format}, ${thumbBytes} bytes`);

  const next = { version: state.version, items: [...plan.kept, ...entries].sort(compareItems) };
  if (maintenance.record) next.token = maintenance.record;
  Object.assign(writes, renderSharedFiles(config, next));

  const gone = [...pageless, ...plan.removed, ...plan.pruned];
  const synced = await syncFiles(root, { writes, deletes: gone.map((item) => item.page) }, { dryRun: inputs.dryRun });
  logger.info(
    `${inputs.dryRun ? 'dry run, would write' : 'wrote'} ${synced.written} files (${synced.bytes} bytes), ` +
      `${inputs.dryRun ? 'would delete' : 'deleted'} ${synced.deleted}`,
  );

  const result = {
    fetched: items.length,
    added: plan.added.length,
    removed: gone.length,
    kept: plan.kept.length,
    changed: false,
  };
  if (!inputs.dryRun) {
    result.changed = await commitAndPush({
      git: createGit({ cwd: workspace, env, execFile }),
      dir: config.output.dir,
      message: commitMessage({ added: result.added, removed: result.removed, provider: inputs.provider }),
      logger,
    });
    if (!result.changed) logger.info('no changes');
  }

  logger.notice(
    `${inputs.provider}: fetched ${result.fetched}, +${result.added} new, ` +
      `-${result.removed} removed, ${result.kept} kept`,
  );
  logger.summary(
    [
      '### simple-media-client',
      '',
      '| Provider | Dry run | Fetched | New | Removed | Kept |',
      '|---|---|---|---|---|---|',
      `| ${inputs.provider} | ${inputs.dryRun} | ${result.fetched} | ${result.added} | ${result.removed} | ${result.kept} |`,
    ].join('\n'),
  );
  setOutput(env, 'changed', String(result.changed));
  if (maintenance.failure) throw new UserError(maintenance.failure);
  return result;
}

export async function main(env = process.env) {
  const logger = createLogger({
    summaryPath: env.GITHUB_STEP_SUMMARY || null,
    mask: env.GITHUB_ACTIONS === 'true',
  });
  try {
    await run({ env, logger });
  } catch (err) {
    // UserErrors carry a message written for the reader; anything else is a
    // bug, but we still avoid dumping a stack that could hold request data.
    const message = err instanceof UserError ? err.message : `Unexpected error: ${err.message}`;
    logger.error(message);
    process.exitCode = 1;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) await main();
