/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Current Manager production source and WebUI files.
 * [OUTPUT]: Raw-only boundary and two-section UI regression checks.
 * [POS]: hf-model-manager/test/boundary-test.mjs.
 * [PROTOCOL]: This test audits production files only; deleted runtime modules are absent by construction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const production = ['package.mjs', 'service/main.mjs', 'service/framework.mjs', 'service/cf.mjs',
  'service/model-packages.mjs', 'service/operations.mjs', 'service/transfer-sources.mjs', 'web/index.html', 'web/app.js'];
const source = production.map(read).join('\n');

test('service is below the handoff line limit', read('service/main.mjs').split('\n').length < 1453);
for (const retired of ['service/app.mjs', 'service/modelstate.mjs', 'service/resolve-descriptor.mjs', 'service/logical.mjs', 'service/references.mjs', 'service/status.mjs']) {
  test(`${retired} is structurally removed`, !fs.existsSync(path.join(root, retired)));
}
for (const forbidden of ['/model/use', '/model/resolve', '/unmanaged', 'termux-os.app.api', 'APP_MODEL_CACHE_ROOT', 'ctxKey']) {
  test(`production does not expose ${forbidden}`, !source.includes(forbidden));
}
const html = read('web/index.html');
test('WebUI has exactly two top-level sections', (html.match(/<section\b/g) ?? []).length === 2);
test('WebUI names 概览 and 模型', html.includes('<h2>概览</h2>') && html.includes('<h2>模型</h2>'));
for (const forbidden of ['advanced', 'executable', 'HTP', 'QNN', 'data-action="use"', '删除本地文件']) {
  test(`WebUI does not show ${forbidden}`, !source.includes(forbidden));
}
test('package route registers raw archive import', read('package.mjs').includes("streamProxy('POST', '/package/import')"));
test('package capability has no runtime action names', !read('package.mjs').includes("case 'use'") && !read('package.mjs').includes("case 'resolve'"));

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
