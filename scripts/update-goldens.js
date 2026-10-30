// Rewrites test/fixtures/golden from the current renderer. Run it on purpose
// (npm run golden:update) and review the diff; tests never update goldens.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GOLDEN_DIR, renderGoldenFiles } from '../test/golden-cases.js';

rmSync(GOLDEN_DIR, { recursive: true, force: true });
for (const [path, html] of Object.entries(renderGoldenFiles())) {
  const target = join(GOLDEN_DIR, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  console.log(`wrote ${path}`);
}
