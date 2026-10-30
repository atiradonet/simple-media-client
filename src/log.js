import { appendFileSync } from 'node:fs';

// Shapes of credentials we never want in a log line, even if they were not
// registered as secrets (for example a refreshed token echoed in an error).
const TOKEN_PATTERNS = [
  /\bIG[A-Za-z0-9_-]{20,}/g, // Instagram user access tokens
  /\bEA[A-Za-z0-9]{20,}/g, // Facebook-style access tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
];
const ACCESS_TOKEN_PARAM = /(access_token=)[^&\s"']+/gi;
const REDACTED = '***';

// Workflow commands treat these characters specially; escape them so a
// caption or error message cannot inject a command of its own.
function escapeCommandData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function createLogger({
  stdout = process.stdout,
  stderr = process.stderr,
  summaryPath = null,
  mask = false,
} = {}) {
  const secrets = new Set();

  function redact(value) {
    let text = String(value);
    // Longest first, so a secret that contains another is fully replaced.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join(REDACTED);
    }
    text = text.replace(ACCESS_TOKEN_PARAM, `$1${REDACTED}`);
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
    return text;
  }

  function annotate(kind, message) {
    stdout.write(`::${kind}::${escapeCommandData(redact(message))}\n`);
  }

  return {
    redact,
    addSecret(secret) {
      if (typeof secret !== 'string' || secret.length === 0) return;
      secrets.add(secret);
      // Only on a real runner: the mask command must carry the raw value.
      if (mask) stdout.write(`::add-mask::${secret}\n`);
    },
    info(message) {
      stdout.write(`${redact(message)}\n`);
    },
    notice: (message) => annotate('notice', message),
    warning: (message) => annotate('warning', message),
    error(message) {
      annotate('error', message);
      stderr.write(`${redact(message)}\n`);
    },
    summary(markdown) {
      if (summaryPath) appendFileSync(summaryPath, `${redact(markdown)}\n`);
    },
  };
}
