/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 五个纯模块 + 三个注入了假 fetch 的 adapter
 * [OUTPUT]: 三类权威边界、更新三分法、引用与删除护栏、作业状态机、未受管理清单的回归
 * [POS]: ⭐ 这个包最重要的规则全是**判断**而不是效果：source 从哪来、什么才算「可更新」、
 *        什么时候不许删。它们必须在毫秒级被证伪，而不是等到某台设备上出现一个说不清的字段。
 * ⛔ 不碰真实 registry、不碰真机、不删任何正式资产。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RegistryAdapter, compareSemver, latestInstallable } from '../service/cf.mjs';
import { HuggingFaceAdapter } from '../service/hf.mjs';
import { FrameworkAssets } from '../service/framework.mjs';
import {
  mergeAsset, updateState, localView,
  UP_TO_DATE, APPROVED_UPDATE, UPSTREAM_UNAPPROVED, NOT_INSTALLED, UNKNOWN,
} from '../service/merge.mjs';
import { ReferenceRegistry, declaredReferences, removalDecision, DECLARED, EXPLICIT } from '../service/references.mjs';
import { Operations, COMPLETE, FAILED, RUNNING } from '../service/operations.mjs';
import { scanUnmanaged } from '../service/unmanaged.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};
const tick = () => new Promise((r) => { setTimeout(r, 0); });

/** 一份形状与真实 `/list` 相同的目录响应。⭐ 关键点：package id 写 github，source 写 huggingface。 */
const LIST = {
  ok: true,
  registry_version: 91,
  packages: [
    {
      source: 'huggingface',
      repository: 'johnson-yo/termux_os-asset-campplus-htp-onnx',
      package_id: 'github.termux-os.asset.campplus',
      display_name: 'CAM++ Speaker Embedding HTP ONNX',
      types: ['asset'],
      versions: [
        {
          version: '9b51004d94dfc4da1322256bcc55c7ec8be8a8d5',
          upstream_ref: '9b51004d94dfc4da1322256bcc55c7ec8be8a8d5',
          status: 'verified',
          files: [{ kind: 'model_file', name: 'graph/generic/campplus.onnx', size: 28149372, sha256: 'a'.repeat(64) }],
          packages: [],
        },
        {
          version: '1.0.0',
          upstream_ref: '0ae6bcd978e427f792816fb5e0dc8a0ab93d5db5',
          status: 'verified',
          published_at: '2026-08-12T10:00:00Z',
          files: [{ kind: 'source_tar', name: 'package/x-1.0.0.tar.gz', size: 15612, sha256: 'b'.repeat(64) }],
          packages: [{
            package_id: 'github.termux-os.asset.campplus',
            provides: [{ id: 'model.campplus.graph', kind: 'asset' }, { id: 'model.campplus.ctx', kind: 'asset' }],
          }],
        },
      ],
    },
    { source: 'github', repository: 'johnson-yo/termux-os-framework', types: ['framework'], versions: [] },
  ],
};

// ────────────────────────────── 1. CF 归一化

{
  const adapter = new RegistryAdapter({ fetchImpl: async () => ({ ok: true, json: async () => LIST }) });
  const cat = await adapter.catalog();
  test('C1 只留 asset 类型的项目（framework 项目不进目录）',
    cat.available && cat.projects.length === 1);
  const p = cat.projects[0];
  test('C2 ⭐ source 取自 registry 字段，与 package id 前缀无关',
    p.source === 'huggingface' && p.package_id.startsWith('github.'));
  test('C3 ⭐ latest 只认带归档的版本（⛔ 不会挑到那个 40 位 sha 的 payload 行）',
    p.latest.version === '1.0.0' && p.latest.revision === '0ae6bcd978e427f792816fb5e0dc8a0ab93d5db5');
  test('C4 asset id 由版本索引给出，不靠名字相似度',
    p.provides.join(',') === 'model.campplus.graph,model.campplus.ctx');
  test('C5 sha256 与 size 被保留（它们只有 registry 有）',
    p.latest.files[0].sha256.length === 64 && p.latest.files[0].size === 15612);
  test('C6 semver 比较不是字符串序（0.2.10 > 0.2.7）', compareSemver('0.2.10', '0.2.7') > 0);
  test('C7 没有可安装版本时 latest 为 null', latestInstallable([]) === null);
}

{
  const dead = new RegistryAdapter({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  const cat = await dead.catalog();
  test('C8 ⭐ registry 挂掉不抛异常，如实 available:false（否则已安装的东西也列不出来）',
    cat.available === false && cat.error === 'registry_unavailable' && Array.isArray(cat.projects));
}

{
  /**
   * ⭐ 真机上真实存在的一类条目：CF 里有几条**纯白名单**项目（上游引用），
   * 没有 package_id、不供应 asset id。它们必须能与可安装的资产包区分开。
   */
  const withRef = JSON.parse(JSON.stringify(LIST));
  withRef.packages.push({ source: 'huggingface', repository: 'FunAudioLLM/SenseVoiceSmall',
    types: ['asset'], versions: [] });
  const adapter = new RegistryAdapter({ fetchImpl: async () => ({ ok: true, json: async () => withRef }) });
  const cat = await adapter.catalog();
  const ref = cat.projects.find((x) => x.repository === 'FunAudioLLM/SenseVoiceSmall');
  test('C9 ⭐ 纯白名单项目仍然列出（否则「为什么下得动」查不出来），但没有 package_id 与 asset id',
    ref && ref.package_id === null && (ref.provides ?? []).length === 0 && ref.latest === null);
}

// ────────────────────────────── 2. HF adapter

{
  const hf = new HuggingFaceAdapter({
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ sha: 'f'.repeat(40), lastModified: '2026-08-12T10:21:00Z',
        cardData: { license: 'apache-2.0' }, tags: ['onnx'], siblings: [{ rfilename: 'README.md' }] }),
    }),
  });
  const d = await hf.describe('owner/repo');
  test('H1 上游 commit / 修改时间 / license / tags 都取到',
    d.available && d.latest_commit === 'f'.repeat(40) && d.license === 'apache-2.0' && d.tags[0] === 'onnx');
  test('H2 没有 blobs 时文件 size 如实为 null（⛔ 不填 0）', d.files[0].size === null);
  const again = await hf.describe('owner/repo');
  test('H3 缓存命中，不重复打外网', again.cached === true);
}
{
  const hf = new HuggingFaceAdapter({ fetchImpl: async () => { throw new Error('offline'); } });
  const d = await hf.describe('owner/repo');
  test('H4 ⭐ 上游读不到只是少一类信息，不是错误状态',
    d.available === false && d.error === 'upstream_unavailable');
}
{
  const hf = new HuggingFaceAdapter({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  const d = await hf.describe('owner/gone');
  test('H5 repo 不存在与读不到分开表达', d.available === true && d.exists === false);
}

// ────────────────────────────── 3. 三类权威合并 + 更新三分法

{
  test('U1 未安装就是 not_installed', updateState({ localVersion: null }) === NOT_INSTALLED);
  test('U2 ⭐ registry 有更高的已批准版本 ⇒ approved_update_available',
    updateState({ localVersion: '1.0.0', registryLatest: '1.1.0' }) === APPROVED_UPDATE);
  test('U3 ⭐ 上游动了但 registry 没有新版本 ⇒ upstream_changed_unapproved（**不是**可更新）',
    updateState({ localVersion: '1.0.0', registryLatest: '1.0.0', registryRevision: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40) })
      === UPSTREAM_UNAPPROVED);
  test('U4 两者都没动 ⇒ up_to_date',
    updateState({ localVersion: '1.0.0', registryLatest: '1.0.0', registryRevision: 'a'.repeat(40), upstreamCommit: 'a'.repeat(40) })
      === UP_TO_DATE);
  test('U5 ⭐ 缺少 registry 信息时是 unknown，⛔ 不是 up_to_date（那是一个没有依据的断言）',
    updateState({ localVersion: '1.0.0', registryLatest: null }) === UNKNOWN);
  test('U6 上游读不到时不影响「已批准更新」的判断',
    updateState({ localVersion: '1.0.0', registryLatest: '2.0.0', upstreamCommit: null }) === APPROVED_UPDATE);
}

{
  const adapter = new RegistryAdapter({ fetchImpl: async () => ({ ok: true, json: async () => LIST }) });
  const cat = await adapter.catalog();
  const project = cat.projects[0];
  const view = mergeAsset('model.campplus.ctx', {
    project,
    upstream: { available: true, latest_commit: '0ae6bcd978e427f792816fb5e0dc8a0ab93d5db5', license: 'apache-2.0', tags: [], files: [] },
    localEntry: {
      package_id: 'github.termux-os.asset.campplus', version: '1.0.0',
      target: 'android-arm64-v73-qnn247', path: '/sdcard/…/campplus-ctx',
      fetched_on_demand: true, ready: true,
    },
  });
  test('M1 ⭐ 三个子结构恒在，每个字段都指得回它是谁说的',
    view.registry.known && view.upstream.known && view.local.known);
  test('M2 ⭐ CAM++ 的 source 显示为 huggingface，而 provider package 仍是历史的 github.* 名字',
    view.source === 'huggingface' && view.local.provider_package === 'github.termux-os.asset.campplus');
  test('M3 registry 的已批准版本与本机版本分开放，不压成一个 version 字段',
    view.registry.approved_version === '1.0.0' && view.local.version === '1.0.0');
  test('M4 已装且上游未动 ⇒ up_to_date', view.update_state === UP_TO_DATE);
  test('M5 target 与 fetched_on_demand 如实带出', view.local.target === 'android-arm64-v73-qnn247'
    && view.local.fetched_on_demand === true);

  const noFw = mergeAsset('model.x', { project, frameworkAvailable: false });
  test('M6 ⭐ Framework 读不到时 local 标 unknown，且更新状态是 unknown（⛔ 不谎称未安装）',
    noFw.local.known === false && noFw.update_state === UNKNOWN);
  const noReg = mergeAsset('model.x', { project: null, registryAvailable: false,
    // ⚠ 已安装的判据是「盘上有已知位置」，所以夹具必须给 path —— 只给 version 的条目
    //   正是真机上那些「声明了但没取下来」的资产。
    localEntry: { version: '1.0.0', path: '/sdcard/…/model-x' } });
  test('M7 registry 读不到时仍能说出本机装了什么',
    noReg.local.installed === true && noReg.registry.known === false);
  test('M8 localView 对「没装」与「问不到」给出不同答案',
    localView(null).installed === false && localView(null, { frameworkAvailable: false }).known === false);
  /**
   * ⭐ 真机上抓到的：`/api/assets` 列的是**全部已声明**资产，含可选的、还没取的那些。
   * 把「列表里有」当成已安装，会让同一行同时出现 installed:true 与 not_installed。
   */
  const declaredOnly = localView({ id: 'model.sensevoice.graph', ready: false, version: null, path: null });
  test('M9 ⭐ 声明了但没取下来 ⇒ declared:true 而 installed:false（两者不是一回事）',
    declaredOnly.declared === true && declaredOnly.installed === false);
  const notInstalledView = mergeAsset('model.sensevoice.graph', {
    project: null, localEntry: { id: 'model.sensevoice.graph', ready: false, version: null, path: null },
  });
  test('M10 ⛔ 同一行里不许出现 installed:true 与 not_installed 互相打脸',
    notInstalledView.local.installed === false && notInstalledView.update_state === NOT_INSTALLED);
}

// ────────────────────────────── 4. 引用与删除护栏

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-'));
  const refs = new ReferenceRegistry({ file: path.join(dir, 'refs.json') });
  const packages = [
    { id: 'github.termux-os.service.termux-speech',
      manifest: { assets: { requires: [
        { id: 'model.campplus.graph', required: true },
        { id: 'model.campplus.ctx', required: false },
      ] } } },
    { id: 'github.termux-os.app.npu-top', manifest: {} },
  ];
  const declared = declaredReferences(packages);
  test('R1 ⭐ 声明式引用从已装包的 manifest 自动推出（⛔ 不要求每个包启动时手工登记）',
    declared.length === 2 && declared.every((d) => d.reference_type === DECLARED));
  test('R2 required 标志被保留（可选依赖与必需依赖不是一回事）',
    declared.find((d) => d.asset_id === 'model.campplus.ctx').required === false);

  const guard = removalDecision('model.campplus.graph', refs.referencesFor('model.campplus.graph', declared));
  test('R3 ⭐ 被引用时拒绝删除，且说出被谁引用',
    guard.allowed === false && guard.error === 'asset_in_use'
      && guard.referenced_by[0].consumer_package_id === 'github.termux-os.service.termux-speech');
  test('R4 没有任何引用时允许删除',
    removalDecision('model.unused', refs.referencesFor('model.unused', declared)).allowed === true);

  refs.add({ consumer_package_id: 'org.example.translate', asset_id: 'model.unused' });
  test('R5 显式引用同样能挡住删除',
    removalDecision('model.unused', refs.referencesFor('model.unused', declared)).allowed === false);
  test('R6 两种引用类型都被标出来（事后追查要知道是谁说的）',
    refs.referencesFor('model.unused', declared)[0].reference_type === EXPLICIT);

  const reopened = new ReferenceRegistry({ file: path.join(dir, 'refs.json') });
  test('R7 显式引用跨重启存活', reopened.referencesFor('model.unused', []).length === 1);
  reopened.remove({ consumer_package_id: 'org.example.translate', asset_id: 'model.unused' });
  test('R8 撤销后不再挡',
    removalDecision('model.unused', reopened.referencesFor('model.unused', [])).allowed === true);
  test('R9 ⛔ 「此刻没在跑」不是删除理由——判据里根本没有 runtime 这一维',
    JSON.stringify(declared).includes('runtime') === false);
}

// ────────────────────────────── 5. 作业状态机

{
  const ops = new Operations();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { operation } = ops.start('fetch', 'model.a', async ({ setStage }) => {
    setStage('downloading');
    await gate;
    setStage('verifying');
    return { done: true };
  });
  test('O1 立刻拿到 operation_id，⛔ 不等下载做完',
    typeof operation.operation_id === 'string' && operation.operation_id.startsWith('op_'));
  await tick();
  test('O2 进入 running 并报出阶段', operation.state === RUNNING && operation.stage === 'downloading');
  test('O3 ⛔ 不伪造字节进度（Framework 不给，就如实为 null）',
    operation.bytes_done === null && operation.progress === null);

  const dup = ops.start('fetch', 'model.a', async () => ({}));
  test('O4 ⭐ 同一件事重复请求返回同一条作业，不并排两条互相覆盖的下载',
    dup.deduplicated === true && dup.operation.operation_id === operation.operation_id);

  release();
  await tick(); await tick();
  test('O5 完成后状态与结果都在', operation.state === COMPLETE && operation.result.done === true);

  const after = ops.start('fetch', 'model.a', async () => ({ second: true }));
  test('O6 终态之后可以再起一条新的', after.deduplicated === false);
  await tick(); await tick();

  const bad = ops.start('verify', 'model.b', async () => { throw new Error('boom'); });
  await tick(); await tick();
  test('O7 失败被记下来且不抛给调用方',
    bad.operation.state === FAILED && bad.operation.error.includes('boom'));
  test('O8 作业列表有界', ops.snapshot().operations.length <= 50);
}

// ────────────────────────────── 6. 未受管理清单

{
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-store-'));
  const managed = path.join(store, 'github.termux-os.asset.campplus', '1.0.0', 'generic', 'campplus-graph');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'model.onnx'), Buffer.alloc(2048));
  const legacy = path.join(store, 'qwen3.5-2b-htp');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'weights.bin'), Buffer.alloc(4096));

  const scan = scanUnmanaged(store, [managed]);
  test('N1 ⭐ 账本知道的目录不算 unmanaged', !scan.items.some((i) => i.name.includes('asset.campplus')));
  test('N2 历史目录被看见，带体积与修改时间',
    scan.items.length === 1 && scan.items[0].name === 'qwen3.5-2b-htp'
      && scan.items[0].size_bytes === 4096 && scan.items[0].modified_at !== null);
  test('N3 ⛔ 不猜它是什么模型（只有 path/size/modified，没有 asset_id）',
    scan.items[0].asset_id === undefined && scan.items[0].managed === false);
  test('N4 ⛔ 不提供自动清理', scan.cleanup_offered === false);
  const missing = scanUnmanaged(path.join(store, 'nope'), []);
  test('N5 store 不存在时如实说读不到', missing.available === false);
}

// ────────────────────────────── 7. Framework adapter 失效模式

{
  const fw = new FrameworkAssets({ base: '', key: '' });
  test('F1 没有凭证时不假装能用', fw.configured === false);
  const inv = await fw.inventory();
  test('F2 ⭐ Framework 读不到 ⇒ available:false（「没装任何资产」与「问不到」不是一回事）',
    inv.available === false && inv.assets.length === 0);
}
{
  let restartUrl = '';
  const fw = new FrameworkAssets({
    base: 'http://x', key: 'k',
    fetchImpl: async (url) => {
      restartUrl = url;
      return { ok: true, status: 200, json: async () => ({ ok: true, assets: [{ id: 'model.a', version: '1.0.0' }] }) };
    },
  });
  const inv = await fw.inventory();
  test('F3 正常时列出资产', inv.available === true && inv.assets[0].id === 'model.a');
  const restart = await fw.restartService('termux-speech');
  test('F4 logical model change uses the generic Framework consumer refresh seam',
    restart.ok === true && restartUrl.endsWith('/api/stage/services/termux-speech/restart'));
}

console.log(`\n${count - failures}/${count} manager assertions passed`);
process.exit(failures ? 1 : 0);
