// Commit and push with the git CLI. Argument arrays only, never a shell string.
import { execFile as nodeExecFile } from 'node:child_process';
import { UserError } from './errors.js';

const IDENTITY = [
  '-c', 'user.name=github-actions[bot]',
  '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
  '-c', 'commit.gpgsign=false',
];
const REMOTE = 'origin';
// A remote hook or branch protection reports "remote rejected"; rebasing won't
// help there, so only a lost race gets the retry.
const LOST_RACE = /\[rejected\]|fetch first|non-fast-forward/;

export function commitMessage({ added, removed, provider }) {
  return `feed: +${added} new, -${removed} removed (${provider})`;
}

// Git's children (hooks, credential helpers) have no use for the action's inputs.
function childEnv(env) {
  const clean = Object.entries(env).filter(([key]) => !key.startsWith('INPUT_'));
  return { ...Object.fromEntries(clean), GIT_TERMINAL_PROMPT: '0' };
}

export function createGit({ cwd, env = process.env, execFile = nodeExecFile }) {
  const options = { cwd, env: childEnv(env), encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 };
  return (...args) =>
    new Promise((resolve, reject) => {
      execFile('git', [...IDENTITY, ...args], options, (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr ?? '').trim();
          reject(err);
        } else {
          resolve(String(stdout).trim());
        }
      });
    });
}

async function currentBranch(git) {
  try {
    return await git('symbolic-ref', '--short', '-q', 'HEAD');
  } catch (err) {
    throw new UserError(
      `Cannot commit: the checkout is not on a branch (${err.stderr || 'detached HEAD'}). Run the workflow from a branch.`,
      { cause: err },
    );
  }
}

function pushFailure(err) {
  const hint = /403|denied/i.test(err.stderr) ? ' The workflow needs "permissions: contents: write".' : '';
  return new UserError(`git push failed: ${err.stderr || err.message}.${hint}`, { cause: err });
}

async function hasStagedChanges(git, dir) {
  try {
    await git('diff', '--cached', '--quiet', '--', dir);
    return false;
  } catch (err) {
    if (err.code === 1) return true;
    throw err;
  }
}

// Returns true if a commit was pushed, false if there was nothing to commit.
// No force pushes. A lost race gets one fetch, one rebase and one more push.
export async function commitAndPush({ git, dir, message, logger }) {
  try {
    await git('add', '-A', '--', dir);
    if (!(await hasStagedChanges(git, dir))) return false;
  } catch (err) {
    throw new UserError(`git failed while staging ${dir}: ${err.stderr || err.message}.`, { cause: err });
  }
  const branch = await currentBranch(git);
  await git('commit', '-q', '-m', message, '--', dir);

  const push = () => git('push', '-q', REMOTE, `HEAD:refs/heads/${branch}`);
  try {
    await push();
    return true;
  } catch (err) {
    if (!LOST_RACE.test(err.stderr)) throw pushFailure(err);
  }

  logger.info(`push rejected; rebasing once onto ${REMOTE}/${branch}`);
  try {
    await git('fetch', '-q', REMOTE, `refs/heads/${branch}`);
    await git('rebase', '-q', '--autostash', 'FETCH_HEAD');
  } catch (err) {
    await git('rebase', '--abort').catch(() => {});
    throw new UserError(`Could not rebase onto ${REMOTE}/${branch}: ${err.stderr || err.message}. Nothing was pushed.`, { cause: err });
  }
  try {
    await push();
  } catch (err) {
    throw new UserError(`git push was rejected again after one rebase: ${err.stderr || err.message}. The next run will try again.`, { cause: err });
  }
  return true;
}
