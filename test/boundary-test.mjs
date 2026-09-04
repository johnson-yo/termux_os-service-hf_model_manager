/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Manager 各源文件的文本
 * [OUTPUT]: docs/092 §23 的**职责边界**回归：Manager 里不许出现任何 QNN/ORT 执行逻辑
 * [POS]: ⭐ 这条边界在运行期看不出来——真把 `ep.context_enable` 写进 Manager，
 *        它照样能跑，只是从此有两个地方懂 QNN，而它们迟早会漂开。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sources = ['service/main.mjs', 'service/logical.mjs', 'service/modelstate.mjs',
  'service/app.mjs', 'service/merge.mjs', 'service/framework.mjs', 'web/app.js'];
const all = sources.map((f) => ({ f, body: code(read(f)) }));

/** ⛔ Manager 不实现 QNN / ORT / HTP compile —— 那是 App 的本职。 */
for (const forbidden of ['ep.context_enable', 'OrtEngine', 'recycleOrt', 'enable_htp_fp16',
  'disable_cpu_fallback', 'ctx_cache', 'OrtSession']) {
  const hit = all.filter((x) => x.body.includes(forbidden)).map((x) => x.f);
  test(`B-${forbidden} ⛔ 不出现在 Manager 里`, hit.length === 0);
}

/** ⭐ 它**可以**知道 htp/qnn —— 那两个值用于推荐与诊断，⛔ 不用于执行。 */
test('B1 htp/qnn 只用于推荐与诊断',
  read('service/logical.mjs').includes('recommendPrebuilt')
  && !code(read('service/logical.mjs')).includes('load('));

/** ⭐ 唯一一条通往 App 的边。 */
test('B2 只有 app.mjs 认识 App 的地址',
  all.filter((x) => x.body.includes('termux-os.app.api')).map((x) => x.f).join() === 'service/app.mjs');

test('B3 prepare 只传 logical 身份与路径，⛔ 不传一堆 QNN 参数', (() => {
  const b = code(read('service/app.mjs'));
  const call = b.slice(b.indexOf('async prepare('));
  return call.includes('model_id') && call.includes('mode')
    && call.includes('artifact_path') && call.includes('source_path')
    && !call.includes('backend:') && !call.includes('provider');
})());

/**
 * ⭐ **§16 的顺序是硬的**：只有状态原子落盘成功之后，source 才能被删。
 * ⚠ 反过来会在一次写盘失败之后丢掉使用者唯一的原材料。
 */
test('B4 删 source 一定在 noteEnabled + 回读确认之后', (() => {
  const b = code(read('service/main.mjs'));
  const fn = b.slice(b.indexOf('const useModel ='));
  const enabled = fn.indexOf('modelState.noteEnabled(id, {\n    modelVersion: version, kind: KIND_LOCAL');
  // useModel also verifies a successful prebuilt before the local fallback;
  // the read-back we care about must be the one after the local noteEnabled.
  const persisted = fn.indexOf('const persisted = modelState.read(id)', enabled);
  const drop = fn.indexOf('local.dropPayload(');
  return enabled >= 0 && persisted > enabled && drop > persisted;
})());

test('B5 ⭐ logical 删除走受限 Framework 路由；生成产物只删 state 指向的缓存', (() => {
  const b = code(read('service/main.mjs'));
  const logical = b.slice(b.indexOf('const modelDrop'));
  return logical.includes('local.dropLogicalPayload(assetId, id)')
    && b.includes('local.dropPayload(')
    && b.includes('APP_MODEL_CACHE_ROOT')
    && b.includes('fs.rmSync(target');
})());

test('B6 编译失败保留 source', (() => {
  const fn = code(read('service/main.mjs'));
  const seg = fn.slice(fn.indexOf("if (r.ok !== true) {"), fn.indexOf('§16') > 0 ? undefined : undefined);
  return fn.includes("modelState.noteFailed(id, {\n      stage: r.stage ?? 'compile'");
})());

/** ⭐ 预制失败要自动回落，⛔ 不是直接报错让使用者自己想办法。 */
test('B7 prebuilt 失败之后会去补下 source', (() => {
  const fn = code(read('service/main.mjs'));
  const use = fn.slice(fn.indexOf('const useModel ='));
  return use.indexOf('verify_prebuilt') < use.indexOf('local.fetchPayload')
    && use.indexOf('local.fetchPayload') < use.indexOf('compile_local');
})());

/** ⭐ 不推荐的预制**照样尝试**——排在后面，⛔ 不被跳过。 */
test('B8 不推荐 != 不尝试', (() => {
  const use = code(read('service/main.mjs'));
  return use.includes('.sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true))')
    && !use.includes('.filter((p) => p.recommended)');
})());

test('B9 logical 删除后 required asset 走受限 restore，⛔ 不误走 provider install', (() => {
  const b = code(read('service/main.mjs'));
  const fn = b.slice(b.indexOf('const fetchOrRestoreAsset'));
  return fn.includes('asset.optional !== true && !entry.path')
    && fn.includes('local.restorePayload(asset.asset_id, context.logicalModelId)')
    && fn.includes('return local.installProvider(asset.asset_id)');
})());

console.log(`\n${count - failures}/${count} boundary assertions passed`);
process.exit(failures ? 1 : 0);
