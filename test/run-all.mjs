/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 无
 * [OUTPUT]: 跑完全部纯逻辑测试文件，任一红即非零退出
 * [POS]: ⚠ 一个新测试文件如果没人跑它，它就不是测试。⛔ 新增文件必须加进 FILES。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['self-test.mjs', 'contract-test.mjs', 'reference-test.mjs', 'boot-test.mjs',
  'logical-model-test.mjs', 'boundary-test.mjs', 'user-status-test.mjs'];

let failed = 0;
let total = 0;
for (const f of FILES) {
  const r = spawnSync(process.execPath, [path.join(here, f)], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/(\d+)\/(\d+) \w+ assertions passed/);
  if (m) total += Number(m[2]);
  if (r.status !== 0) {
    failed += 1;
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
  }
  console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${f}${m ? ` — ${m[0]}` : ''}`);
}
console.log(`\n${FILES.length - failed}/${FILES.length} files green, ${total} assertions total`);
process.exit(failed ? 1 : 0);
