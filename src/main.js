import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { UserError } from './errors.js';
import { createFixtureFetch } from './providers/fixtures.js';
import { getProvider, providerNames } from './providers/index.js';

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

// `fetch` and `sleep` are injectable so tests never touch the network or wait.
export async function run({ env = process.env, logger, fetch = globalThis.fetch, sleep } = {}) {
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

  const provider = getProvider(inputs.provider);
  const { items, skipped } = await provider.fetchItems({
    token: inputs.token,
    limit: config.fetch.limit,
    fetch: inputs.fixtureDir ? createFixtureFetch(resolve(workspace, inputs.fixtureDir)) : fetch,
    sleep,
  });
  for (const { id, reason } of skipped) logger.warning(`Skipped ${inputs.provider} item ${id}: ${reason}.`);

  const result = { fetched: items.length, added: 0, removed: 0, kept: 0, changed: false };
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
