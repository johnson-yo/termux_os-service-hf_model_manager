/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The Manager's explicit local test files.
 * [OUTPUT]: One fail-fast aggregate result with every child assertion counted.
 * [POS]: hf-model-manager/test/run-all.mjs.
 * [PROTOCOL]: Adding a test requires adding it to FILES; a missing summary is a failure.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['model-package-test.mjs', 'adapter-test.mjs', 'boundary-test.mjs', 'webui-test.mjs', 'boot-test.mjs'];
let failed = 0;
let total = 0;
for (const file of FILES) {
  const result = spawnSync(process.execPath, [path.join(here, file)], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  const match = output.match(/(\d+)\/(\d+) assertions passed/);
  if (!match) { failed++; console.log(`FAIL ${file}: assertion summary missing`); }
  else total += Number(match[2]);
  if (result.status !== 0) failed++;
}
console.log(`\n${FILES.length - failed}/${FILES.length} files green, ${total} assertions total`);
process.exit(failed ? 1 : 0);
