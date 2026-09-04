/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 已装包 manifest 的 `assets.requires`（声明式）+ consumer 显式登记（explicit）
 * [OUTPUT]: 「谁声明依赖这个 asset」，以及原始 asset 删除前的 guard 判断
 * [POS]: ⭐ 第一版 Manager 最重要的新能力。Framework 今天**没有任何**引用计数，
 *        而 `DELETE /api/assets/<id>/payload` 会真删字节且不问任何人。
 *
 * ⭐ 引用是**声明态**，不是运行态；它适合阻止裸 `/assets/<id>` 删除，避免把一个
 *   仍声明完整依赖的 Package 置于缺资产状态。
 *   logical model 删除走另一条编排：先让 App 释放 active runtime，再清理模型资产；
 *   声明本身不再冒充“当前正在使用”。
 * [PROTOCOL]: 纯逻辑 + 一个 JSON 文件。变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';

export const DECLARED = 'declared';
export const EXPLICIT = 'explicit';
export const SCHEMA = 'termux-os.asset-references.v1';

/**
 * 从已装包的 manifest 里推出声明式引用。
 *
 * ⭐ 不要求每个包每次启动都手工登记一遍：`assets.requires` 已经是它的正式声明，
 *   再要一次注册只会多一个「忘了注册就被删」的失败模式。
 */
export const declaredReferences = (packages) => {
  const out = [];
  for (const pkg of packages ?? []) {
    const id = pkg?.id ?? pkg?.packageId;
    const requires = pkg?.manifest?.assets?.requires ?? [];
    for (const req of requires) {
      if (!req?.id) continue;
      out.push({
        consumer_package_id: id,
        asset_id: req.id,
        requested_version: req.version ?? null,
        required: req.required !== false,
        reference_type: DECLARED,
      });
    }
  }
  return out;
};

export class ReferenceRegistry {
  constructor({ file = null } = {}) {
    this.file = file;
    /** key `${consumer}|${asset}` → explicit 记录 */
    this.explicit = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.schema !== SCHEMA) return;
      for (const r of raw.references ?? []) {
        if (r?.consumer_package_id && r?.asset_id) {
          this.explicit.set(`${r.consumer_package_id}|${r.asset_id}`, r);
        }
      }
    } catch { /* 第一次运行没有这个文件是正常的 */ }
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({
        schema: SCHEMA, references: [...this.explicit.values()],
      }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* 写不下去不该让服务倒掉；下次还会再试 */ }
  }

  add({ consumer_package_id: consumer, asset_id: asset, target = null, requested_version: want = null }) {
    if (!consumer || !asset) throw new Error('consumer_package_id and asset_id are required');
    const key = `${consumer}|${asset}`;
    const now = new Date().toISOString();
    const prev = this.explicit.get(key);
    const record = {
      consumer_package_id: consumer,
      asset_id: asset,
      requested_version: want,
      target,
      reference_type: EXPLICIT,
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    this.explicit.set(key, record);
    this.persist();
    return record;
  }

  remove({ consumer_package_id: consumer, asset_id: asset }) {
    const key = `${consumer}|${asset}`;
    const had = this.explicit.delete(key);
    if (had) this.persist();
    return had;
  }

  /**
   * 这个 asset 现在被谁引用。⭐ 声明式与显式**合并**，并保留 `reference_type`——
   * 「谁说的」在事后追查里比「有几个」更有用。
   *
   * ⚠ 同一个包**两种方式都登记过**是正常的（manifest 里声明了，启动时又主动登记了一次），
   *   但它只是**一个**消费方。不去重的话，界面上会写着「2 个包在用」而其实只有 1 个——
   *   一个数错了的引用计数，比没有引用计数更容易让人做出错误的删除决定。
   *   声明式优先（manifest 是它的正式声明），另一条以 `also_explicit` 如实保留。
   */
  referencesFor(assetId, declared = []) {
    const byConsumer = new Map();
    const put = (r) => {
      const key = r.consumer_package_id ?? '(unknown)';
      const prev = byConsumer.get(key);
      if (!prev) { byConsumer.set(key, { ...r }); return; }
      // 已经有一条：保留声明式那条，并记下另一种方式也存在。
      if (prev.reference_type === DECLARED) prev.also_explicit = true;
      else byConsumer.set(key, { ...r, also_explicit: true });
    };
    for (const d of declared) if (d.asset_id === assetId) put(d);
    for (const e of this.explicit.values()) if (e.asset_id === assetId) put(e);
    return [...byConsumer.values()];
  }

  all(declared = []) {
    return [...declared, ...this.explicit.values()];
  }
}

/**
 * ⭐ 原始 asset 删除前的判断。logical model 删除**不调用**它作为永久锁，
 *     而由 App deactivate + Framework restricted logical-model route 负责生命周期安全。
 *
 * `allowed:false` 时必须带上 `referenced_by` —— 一个只说「不行」的拒绝，
 * 会让使用者去找 force 开关，而不是去看谁在用它。
 */
export const removalDecision = (assetId, references) => {
  const refs = references ?? [];
  if (refs.length > 0) {
    return {
      allowed: false,
      error: 'asset_in_use',
      asset_id: assetId,
      referenced_by: refs.map((r) => ({
        consumer_package_id: r.consumer_package_id,
        reference_type: r.reference_type,
        required: r.required ?? null,
      })),
    };
  }
  return { allowed: true, asset_id: assetId, referenced_by: [] };
};
