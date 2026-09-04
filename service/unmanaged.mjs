/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 共享 Model Store 的目录列表 + Framework 账本里已知的路径
 * [OUTPUT]: 「盘上有、账本不知道」的历史目录清单（只到目录级）
 * [POS]: 参考机上这类目录约 16 GB。Manager 第一版**必须看得见它们**，
 *        因为使用者看到的磁盘占用是全部，而账本只解释得了其中一小部分。
 *
 * ⛔ 但绝不接管：不猜它是什么模型、不按文件名映射 asset id、不自动导入、不自动删除。
 * ⛔ 也不算 sha256 —— 对十几 GB 做一次全量校验是几十分钟的 IO 与一大截电量，
 *   而它换不来任何此刻需要的判断。要算，等使用者显式要求。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';

/** 目录体积。⚠ 有上界：遇到超大树时提前停，返回 `truncated`，⛔ 不假装数字是全的。 */
export const dirSize = (dir, { maxEntries = 20_000 } = {}) => {
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (files >= maxEntries) { truncated = true; break; }
      const p = path.join(current, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try { bytes += fs.statSync(p).size; files += 1; } catch { /* 读不到就跳过 */ }
    }
    if (truncated) break;
  }
  return { bytes, files, truncated };
};

/**
 * 扫共享 store 的**第一层**。
 *
 * ⭐ 判据是「这个目录有没有被账本引用」——`managed` 的路径都在
 * `<store>/<providing package id>/…` 之下，所以前缀匹配就够，
 * ⛔ 不去解析目录名的含义。
 */
export const scanUnmanaged = (store, knownPaths = [], { withSize = true } = {}) => {
  let entries;
  try { entries = fs.readdirSync(store, { withFileTypes: true }); }
  catch (error) { return { available: false, error: String(error?.message ?? error), store, items: [] }; }

  const known = knownPaths.filter(Boolean).map((p) => path.resolve(p));
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.resolve(store, e.name);
    const managed = known.some((k) => k === full || k.startsWith(`${full}${path.sep}`));
    if (managed) continue;
    let stat = null;
    try { stat = fs.statSync(full); } catch { /* 目录消失了就跳过 */ }
    const size = withSize ? dirSize(full) : { bytes: null, files: null, truncated: false };
    items.push({
      name: e.name,
      path: full,
      managed: false,
      size_bytes: size.bytes,
      file_count: size.files,
      size_truncated: size.truncated,
      modified_at: stat ? new Date(stat.mtimeMs).toISOString() : null,
    });
  }
  items.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
  return {
    available: true,
    store,
    items,
    total_bytes: items.reduce((n, i) => n + (i.size_bytes ?? 0), 0),
    /** ⛔ 这里永远是 false：本包不提供自动清理（任务书 §16）。 */
    cleanup_offered: false,
  };
};
