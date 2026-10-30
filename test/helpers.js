import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/log.js';

export const FAKE_TOKEN = 'IGAAFakeTokenForTestsOnly0123456789abcdef';

// A stream stand-in that keeps everything written to it.
export function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

export function captureLogger(options = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const logger = createLogger({ stdout, stderr, ...options });
  return { logger, stdout, stderr, all: () => stdout.text() + stderr.text() };
}

export function tempDir(t, prefix = 'smc-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function readText(path) {
  return readFileSync(path, 'utf8');
}

export function actionEnv(inputs = {}, extra = {}) {
  const env = { ...extra };
  for (const [key, value] of Object.entries({ provider: 'instagram', token: FAKE_TOKEN, ...inputs })) {
    env[`INPUT_${key.toUpperCase()}`] = value;
  }
  return env;
}
