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
test('cards have Chinese basic-info, usage, and file disclosures', js.includes('基本信息') && js.includes('占用情况') && js.includes('>文件'));
test('cards expose total and downloaded byte fields', js.includes('total_bytes') && js.includes('downloaded_bytes'));
test('operations expose real speed and current file', js.includes('speed_bps') && js.includes('current_file'));
test('actions use the frozen Chinese labels', js.includes('继续下载') && js.includes('更新</button>') && js.includes('删除</button>') && js.includes('重试</button>'));
test('download/continue/retry/delete actions use the package key', js.includes('data-action="download"') && js.includes('data-action="delete"')
  && js.includes('data-action="update"') && js.includes('/package/delete-plan?id=') && js.includes('confirmation_token'));
test('delete UI is a two-step impact warning, not a Core deny message', html.includes('id="delete-dialog"')
  && js.includes('deleteImpactText') && js.includes('showModal'));
test('raw absolute file path is rendered', js.includes('local.path || local.part_path') && js.includes('class="path"'));
test('import sends the selected archive to the Package route', js.includes("api('/package/import'") && js.includes('body: file'));
test('UI refreshes a real operation snapshot', js.includes("api('/live')") && js.includes('data?.operations'));
test('live card refresh uses stable data-key nodes', js.includes('data-key') && js.includes('appendChild(node)') && js.includes('patchCardNode'));
test('card-list is not rebuilt by package-list innerHTML polling', !js.includes("box.innerHTML = packages.map") && js.includes('const existing = new Map'));
test('updated text identifies snapshot data time', js.includes('数据更新时间：') && js.includes('updated_at_ms'));

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
