/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: ReferenceRegistry + declaredReferences + removalDecision
 * [OUTPUT]: 引用生命周期的回归——它决定「能不能删」，答错就是真删了别人还在用的字节
 * [POS]: ⭐ 声明式引用是**推导量**（随 manifest 走），显式引用是**持久量**（随重启活）。
 *        两者的寿命不同，这是本文件反复钉的那件事。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReferenceRegistry, declaredReferences, removalDecision, DECLARED, EXPLICIT } from '../service/references.mjs';

let failures = 0; let count = 0;
const test = (name, cond) => {
  count += 1; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
const file = path.join(tmp, 'nested', 'references.json');
const ASSET = 'github.termux-os.asset.campplus';

const speech = { id: 'github.termux-os.service.termux-speech',
  manifest: { assets: { requires: [{ id: ASSET, version: '1.0.0' }] } } };
const other = { id: 'github.termux-os.app.termux-interpreter',
  manifest: { assets: { requires: [{ id: ASSET, required: false }] } } };

// ── R1 声明式：从 manifest 推出来，不需要谁来登记 ─────────────────────────
{
  const d = declaredReferences([speech, other]);
  test('R1 声明式引用直接从 assets.requires 推出', d.length === 2 && d.every((r) => r.reference_type === DECLARED));
  test('R2 optional 依赖如实标记（required=false 不等于没有引用）',
    d.find((r) => r.consumer_package_id === other.id).required === false);
}

// ── R3 显式：登记 → 重启 → 还在 ───────────────────────────────────────────
{
  const a = new ReferenceRegistry({ file });
  a.add({ consumer_package_id: 'pkg.a', asset_id: ASSET });
  test('R3 显式登记立刻可见', a.referencesFor(ASSET, []).length === 1);
  test('R4 持久化文件真的落盘了（父目录会被建出来）', fs.existsSync(file));

  const b = new ReferenceRegistry({ file });   // ⭐ 模拟服务重启
  const survived = b.referencesFor(ASSET, []);
  test('R5 ⭐ 显式引用挺过重启（否则重启一次就变成「没人用」，可以删了）',
    survived.length === 1 && survived[0].reference_type === EXPLICIT);
  test('R6 created_at 不被重复登记冲掉', (() => {
    const first = b.explicit.get(`pkg.a|${ASSET}`).created_at;
    b.add({ consumer_package_id: 'pkg.a', asset_id: ASSET, requested_version: '2.0.0' });
    const r = b.explicit.get(`pkg.a|${ASSET}`);
    return r.created_at === first && r.requested_version === '2.0.0' && r.updated_at >= first;
  })());
  test('R7 撤销之后不再出现，且撤销是持久的', (() => {
    b.remove({ consumer_package_id: 'pkg.a', asset_id: ASSET });
    return b.referencesFor(ASSET, []).length === 0
      && new ReferenceRegistry({ file }).referencesFor(ASSET, []).length === 0;
  })());
  test('R8 撤销一条不存在的引用返回 false，⛔ 不假装成功',
    b.remove({ consumer_package_id: 'nobody', asset_id: ASSET }) === false);
}

// ── R9 声明式随 manifest 走：卸载 / 改声明立刻反映 ─────────────────────────
{
  const reg = new ReferenceRegistry({ file: path.join(tmp, 'r2.json') });
  test('R9 ⭐ 包被卸载 ⇒ 它的声明式引用当场消失（推导量不需要清理动作）',
    reg.referencesFor(ASSET, declaredReferences([other])).length === 1);
  test('R10 ⭐ manifest 改了声明 ⇒ 重新推导即生效，⛔ 不留旧引用的残影',
    reg.referencesFor(ASSET, declaredReferences([
      { id: other.id, manifest: { assets: { requires: [] } } },
    ])).length === 0);
  test('R11 没有任何包声明 ⇒ 空数组，不是 null',
    Array.isArray(reg.referencesFor(ASSET, [])) && reg.referencesFor(ASSET, []).length === 0);
}

// ── R12 去重：同一个包两种方式登记，仍然只是一个消费方 ─────────────────────
{
  const reg = new ReferenceRegistry({ file: path.join(tmp, 'r3.json') });
  reg.add({ consumer_package_id: speech.id, asset_id: ASSET });
  const merged = reg.referencesFor(ASSET, declaredReferences([speech]));
  test('R12 ⭐ 同一个包声明式+显式各一次 ⇒ 合并成一条（数错的引用计数比没有更危险）',
    merged.length === 1);
  test('R13 声明式优先，但另一种方式如实保留',
    merged[0].reference_type === DECLARED && merged[0].also_explicit === true);
  test('R14 不同的包不会被误并',
    reg.referencesFor(ASSET, declaredReferences([speech, other])).length === 2);
}

// ── R15 删除判断 ───────────────────────────────────────────────────────────
{
  const d = declaredReferences([speech]);
  const no = removalDecision(ASSET, d);
  test('R15 有人在用 ⇒ 拒绝', no.allowed === false && no.error === 'asset_in_use');
  test('R16 ⭐ 拒绝时必须说出是谁（只说「不行」会让人去找 force 开关）',
    no.referenced_by.length === 1 && no.referenced_by[0].consumer_package_id === speech.id);
  test('R17 没人用 ⇒ 允许', removalDecision(ASSET, []).allowed === true);
  test('R18 ⭐ 「此刻没在跑」不是判据——声明态就够了（下一次唤醒它就坏了）',
    removalDecision(ASSET, declaredReferences([
      { id: 'idle.pkg', manifest: { assets: { requires: [{ id: ASSET }] } } },
    ])).allowed === false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${count - failures}/${count} reference assertions passed`);
process.exit(failures ? 1 : 0);
