// Access-token upkeep. Meta documents no way to look up a token's expiry and
// does not say whether the old token survives a refresh, so this assumes the
// worst of both. See docs/decisions.md, section 17.2.
import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// Enough to notice the secret was rotated. One-way, and the token has far too
// much entropy to guess from it.
export function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// Pure. `refreshed` is { token, expiresIn } or null if the refresh failed.
// Returns the record to keep in state (or null), whether to store a new token,
// and when the token this workflow will use next actually expires, if known.
export function assessToken({ token, refreshed, secretsToken, record, now }) {
  const tracked = record?.fingerprint === fingerprint(token) ? record : null;
  if (!refreshed) return { record: record ?? null, store: false, expiresAt: tracked?.expires_at ?? null };

  const refreshedUntil = new Date(now + refreshed.expiresIn * 1000).toISOString();
  const changed = refreshed.token !== token;
  if (!changed || secretsToken) return { record: null, store: changed, expiresAt: refreshedUntil };

  // A new string we cannot store: the secret still holds the old token, which
  // this refresh may not have extended. Count from the first day we saw it.
  const kept = tracked ?? { fingerprint: fingerprint(token), expires_at: refreshedUntil };
  return { record: kept, store: false, expiresAt: kept.expires_at, untracked: !tracked };
}

export function expiryFailure({ expiresAt, now, secretName }) {
  if (!expiresAt) return null;
  const days = Math.floor((Date.parse(expiresAt) - now) / DAY_MS);
  if (days > EXPIRY_WARNING_DAYS) return null;
  return (
    `The access token expires on ${expiresAt.slice(0, 10)} (${days} days left). Generate a new long-lived token and ` +
    `update the ${secretName} secret, or set the secrets_token input so the action stores refreshed tokens itself. ` +
    'Steps are in docs/setup-instagram.md.'
  );
}

// `gh secret set` encrypts the value the way the GitHub API requires, and it is
// on every GitHub-hosted runner, so no crypto dependency is needed. The value
// goes over stdin, never argv, where it would show up in a process listing.
export function storeSecret({ name, value, repository, secretsToken, env = process.env, execFile = nodeExecFile }) {
  const options = {
    env: { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: secretsToken },
    encoding: 'utf8',
    timeout: 60_000,
  };
  return new Promise((resolve, reject) => {
    const child = execFile('gh', ['secret', 'set', name, '--repo', repository], options, (err, _stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr ?? '').trim();
        reject(err);
      } else {
        resolve();
      }
    });
    child.stdin.end(value);
  });
}
