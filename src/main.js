import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from './log.js';
import { providerNames } from './providers/index.js';

// Thrown for problems the user can fix (bad input, bad config). main() prints
// the message alone, without a stack trace.
export class UserError extends Error {}

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

export async function run({ env = process.env, logger } = {}) {
  const inputs = readInputs(env);
  logger.addSecret(inputs.token);
  if (inputs.secretsToken) logger.addSecret(inputs.secretsToken);

  const result = { fetched: 0, added: 0, removed: 0, kept: 0, changed: false };

  logger.info(
    `simple-media-client: provider=${inputs.provider} dry_run=${inputs.dryRun}` +
      (inputs.fixtureDir ? ' fixtures=on' : ''),
  );
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
