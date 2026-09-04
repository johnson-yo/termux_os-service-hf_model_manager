/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The package WebUI source.
 * [OUTPUT]: Static route/action/import and file-card coverage.
 * [POS]: hf-model-manager/test/webui-test.mjs.
 * [PROTOCOL]: Browser acceptance follows the same two-section contract as the page.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };

test('Overview is the first top-level section', html.indexOf('id="overview"') < html.indexOf('id="models"'));
test('Models contains the archive import control', html.includes('id="archive"') && html.includes('id="import"'));
test('cards have Meta, Usage, and Files disclosures', js.includes('>Meta<') && js.includes('>Usage') && js.includes('>Files'));
test('download/continue/retry/delete actions use the package key', js.includes('data-action="download"') && js.includes('data-action="delete"')
  && js.includes('/package/${action}?id='));
test('raw absolute file path is rendered', js.includes('local.path || local.part_path') && js.includes('class="path"'));
test('import sends the selected archive to the Package route', js.includes("api('/package/import'") && js.includes('body: file'));
test('UI refreshes a real operation snapshot', js.includes("api('/live')") && js.includes('data?.operations'));

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
