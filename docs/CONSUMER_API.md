# HF Model Manager — Consumer Contract v1

给**其它 package**（termux-speech、termux-interpreter、未来的任何模型使用方）看的接口冻结面。

冻结的是本文列出的字段与语义。未在本文出现的字段一律视为**内部实现**，可能随时改名或消失；
消费方读了它们，下一次升级就会坏。

- Package: `github.termux-os.service.hf-model-manager`
- Version: **0.2.0**
- Schemas: `termux-os.assets-live.v1` · `termux-os.assets-events.v1`

---

## 0. 先说三条最容易踩的

1. **⛔ 不要写死本包的 package id 或端口。** 走 capability discovery（§1）。
   开发实例的 id 会带后缀（`<id>@<slug>`，见 L1 「设备上开发闭环」），写死的常量在派生实例上全部失效。
2. **⭐ 「被声明」不等于「已安装」。** `local.declared` 与 `local.installed` 是两个字段，
   判据是盘上有没有 `path`。只读其中一个会得到一个看起来对、实际相反的答案。
3. **⚠ 读到的可能是旧的，旧到什么程度写在 `sources` 里。** 读接口**永不等远端**（§4）。
   要「此刻」就显式 `POST /refresh`。

---

## 1. 发现（唯一受支持的接入方式）

本包提供两个 capability：

| capability id | kind | 用途 |
|---|---|---|
| `termux-os.assets.manager` | `action` | 问一个问题，拿一个答案 |
| `termux-os.assets.inventory` | `feed` | 订阅「资产世界变了」 |

```js
// 依赖写 capability id，⛔ 不写 package id
// termux-os.package.json:
//   "capabilities": { "requires": [{ "id": "termux-os.assets.manager", "optional": true }] }

const cap = await context.capabilities.resolve('termux-os.assets.manager');
if (!cap) { /* 管理器没装 —— 见 §7，必须能降级 */ }
```

### 1.1 action：`termux-os.assets.manager`

⚠ Framework 的 action `run(input)` 收到的是**一个字符串**，所以约定：input 是一段 JSON。

| `op` | 需要 `asset_id` | 返回 |
|---|---|---|
| `summary`（**缺省**，含空输入） | — | `{ ok, counts, sources, event_cursor, change_seq }`，走快照不打远端 |
| `catalog` | — | Registry 侧目录 |
| `assets` | — | 全部资产的合并视图 |
| `installed` | — | 只有 `local.installed` 为真的那些 |
| `detail` | 是 | 单个资产的完整合并视图（§3），**含上游** |
| `resolve` | 是 | 本机解析结果（能不能用、在哪） |
| `check-update` | 是 | 主动查一次上游 + Registry |
| `references` | 可选 | 谁在用（省略 = 全部） |
| `install` | 是 | 装上提供它的资产包 ⇒ **202 + operation** |
| `fetch` | 是 | 取回按需 payload ⇒ **202 + operation** |
| `verify` | 是 | 逐档 sha256 ⇒ **202 + operation** |
| `remove` | 是 | 删除本地 payload（带引用护栏，见 §6） |
| `operation` | — | 查一个作业（`operation_id`） |
| `operations` | — | 作业列表 |
| `events` | — | 事件流（`after` / `limit`），与 §2 的 feed 同一份数据 |

⭐ **写操作也在能力面上**（0.1.2 起）。此前它们只存在于 HTTP 路由，于是一个遵守规矩的
消费方——只用 discovery、不写死本包 URL——**看得见状态却一件事都做不了**，
只能去拼 `/api/packages/<manager-id>/...`，而那正是 capability 要消灭的东西。

⚠ `remove` 额外带 `http_status`：action 的返回值里没有 HTTP 状态码这一维，
而 **409 `asset_in_use` 与「删掉了」是完全不同的答案**，不能靠 `ok:false` 一概而论。

```js
const answer = await context.capabilities.invoke('termux-os.assets.manager',
  JSON.stringify({ op: 'detail', asset_id: 'github.termux-os.asset.campplus' }));
```

未知 `op` 返回 `{ ok:false, error:'unknown_op', supported:[…] }` —— ⭐ 错误里带着可用集合，
调用方不必回来读源码。

### 1.2 feed：`termux-os.assets.inventory`

`describeCapability` 返回 `{ endpoint, format: 'jsonl-cursor' }`。
**Framework 的 feed 是游标端点，不是推送** —— 消费方自己按游标拉。

```js
const feed = await context.capabilities.describe('termux-os.assets.inventory');
let cursor = 0;
const page = await get(`${feed.endpoint}?after=${cursor}&limit=100`);
cursor = page.cursor;
```

---

## 2. 事件（`termux-os.assets-events.v1`）

`GET <feed.endpoint>?after=<seq>&limit=<1..200>`

```jsonc
{
  "ok": true,
  "schema": "termux-os.assets-events.v1",
  "events": [ { "seq": 41, "type": "operation_completed", "at_ms": 1755..., "asset_id": "..." } ],
  "cursor": 41,          // 下次传给 after
  "latest_seq": 41,
  "oldest_seq": 12,
  "truncated": false,    // ⚠ true = 你错过的那一段已经被裁掉了
  "more": false
}
```

事件类型（冻结）：

`inventory_changed` · `operation_created` · `operation_stage` · `operation_completed` ·
`operation_failed` · `reference_changed` · `update_status_changed` · `source_availability_changed`

**⚠ `truncated: true` 时不要「补拉缺口」** —— 缺口已经不存在了。正确反应是重新读一次
`/live` 全量状态，然后从返回的 `event_cursor` 继续。

事件流是**有界**的（默认保留 200 条）。一个常驻服务里只增不减的数组就是慢性泄漏。

---

## 3. 资产视图（`termux-os.assets-live.v1`）

⭐ **一个资产视图只有一种形状**：`/live`、`assets`、`detail` 三条路给出的字段集合相同
（0.1.3 起）。此前 `assets` 少了 `references`/`update_label`/`payload_bytes`，
于是按 `/live` 写的消费方换个口去问，字段就静静地少几个——termux-speech 的模型页
每一行大小都是空的，就是这么来的。

返回的每个 asset 恒有三个子结构，**永不压平**：

```jsonc
{
  "asset_id": "github.termux-os.asset.campplus",
  "source": "huggingface",        // ⭐ 来自 registry 字段，⛔ 绝不从 id 前缀猜
  "repository": "…", "display_name": "…",
  "update_state": "up_to_date",
  "update_label": "已是最新",      // UI 用；语义判据请读 update_state
  "payload_bytes": 27262976,      // ⭐ 模型真身大小（来自描述包 manifest）
                                  // ⛔ 不是 registry.total_bytes（那是描述归档，约 15 KB）
  "references": [ { "package_id": "…", "kind": "declared" | "explicit" } ],

  "registry": { "known": true, "package_id": "…", "approved_version": "1.0.0",
                "approved_revision": "…", "published_at": "…", "total_bytes": 15234, "files": [] },
  "upstream": { "known": false, "reason": "upstream_unavailable" },
  "local":    { "known": true, "declared": true, "installed": true,
                "provider_package": "…", "version": "1.0.0", "target": "…",
                "path": "…", "files": [], "ready": true, "reason": null }
}
```

**为什么不压平**：「本机装的是 1.0.0」与「上游有个新 commit」的可信度完全不同，
压成同一个 `version` 之后就分不出来了。任何一个字段都要能指回是谁说的。

### 3.1 `update_state` 三分法（冻结）

| 值 | 含义 | 消费方该做什么 |
|---|---|---|
| `not_installed` | 声明了但盘上没有 | 可以请求安装 |
| `up_to_date` | 没有更高的已批准版本 | 无 |
| `approved_update_available` | **Registry 里有更高的、已审核、带 sha256 的版本** | 可以更新 |
| `upstream_changed_unapproved` | 上游动了，但 Registry 没出新版本 | **只提示，不提供更新按钮** |
| `unknown` | 信息不足 | ⚠ **不要当成 up_to_date** |

⭐ 只有 ① 才叫「可更新」。把 ② 显示成可更新，等于邀请使用者去装一个没人审过、没有校验值的 HEAD。

### 3.2 `known` 的意思

每个子结构都有 `known`。`known:false` 是「**我此刻不知道**」，
⛔ **不是** 「没有」。分不清这两者的 UI 会在 Registry 掉线时把全部资产显示成未登记。

---

## 4. 新鲜度（`sources`）

```jsonc
"sources": {
  "inventory": { "known": true, "age_ms": 4210, "stale": false, "last_error": null, "refreshing": false },
  "catalog":   { … }, "declared": { … }, "upstream": { … },
  "registry_available": true, "framework_available": true
}
```

- **读接口永不等远端。** Framework 的 `GET /api/assets` 在参考机上要 12.5 秒、
  `/api/packages` 要 28.3 秒（它不缓存，冷热一样）。若 `/live` 在缓存未命中时同步去打它们，
  这个端点就会周期性变成数秒级，而轮询会首尾相接地叠起来。
- 刷新在后台按 TTL 走：inventory 30 s · catalog 10 min · declared 60 s。
- `stale`（默认 3×TTL）= 值还在，但旧得该提醒使用者了。
  **`stale` 与 `known:false` 是两回事**：前者有值，后者没有。
- 刷新失败**不清空旧值**（一次网络抖动不该让整页变空），错误记在 `last_error`。

⭐ **`known` 与 `*_available` 是两个维度，不要混：**

| | 含义 |
|---|---|
| `inventory.known` | 这一层**手上有没有一个当前的答案** |
| `framework_available` | 那个答案的**内容**是不是「远端可用」 |

「我有一个新鲜的答案，答案是问不到」是完全自洽的状态。
⛔ 因此**只看 `counts.assets === 0` 会把「问不到」读成「没有资产」** ——
判断有没有资产，必须连着 `framework_available` 一起读。

想要「此刻」：`POST /refresh`（同步等三层刷完，可能数十秒）。

---

## 5. 作业（长操作）

安装 / 取回 / 校验 / 检查更新都是 **202 + operation_id**，不是同步等待。
Framework 的按需取是同步阻塞 HTTP（真机实测 14.7 MB 阻塞 35.4 秒，1 GB 会阻塞十几分钟）。

```jsonc
{ "operation_id": "op_…", "asset_id": "…", "action": "install",
  "state": "queued|running|verifying|complete|failed",
  "stage": "resolving|downloading|verifying|done",
  "stages": ["resolving","downloading","verifying","done"],
  "progress_precision": "stage",   // ⭐ 见下
  "bytes_total": null, "bytes_done": null, "progress": null,
  "error": null, "result": null }
```

⭐ **`progress_precision: "stage"` 是一条给 UI 的禁令**：Framework 不回传字节数，本包也不猜。
⛔ 不要把 4 个阶段折算成百分比——一个编出来的进度条会让**卡住的下载看起来还在动**。
画阶段（第 2/4 步：下载中）是对的，画 50% 是错的。

- 同一个 `(action, asset)` 已在飞 ⇒ 返回**同一条**作业（`deduplicated: true`），不新建。
- 作业历史有界（保留 50 条）。

---

## 6. 引用与删除

`references[]` 有两种来源：

| kind | 从哪来 | 生命周期 |
|---|---|---|
| `declared` | 各 package manifest 的 `assets.requires` | **推导出来的**，随 manifest 变化，卸载即消失 |
| `explicit` | 消费方调 `POST /references` 登记 | 持久化，重启后仍在，需显式撤销 |

删除受保护：还有人引用 ⇒ `409 { error: 'asset_in_use', referenced_by: [...] }`。

⭐ **fail-closed**：连「谁在用」都问不到（Framework 不可达）时，删除同样被拒
（`references_unknown`）。**「问不到」不等于「没人用」。**

⚠ **已知限制**：本包的保护只覆盖走本包的删除。Framework 自己的
`DELETE /api/assets/<id>/payload` 是一条平行路径，绕过本包就绕过了这层检查（见 §8）。

---

## 7. 管理器不在时（必须能降级）

消费方**必须**把本包当成 `optional` 依赖：

- capability 解析不到 ⇒ 走各自原有的资产路径（Framework `resolveAsset` 一直都在）。
- 本包只是一个**协调层**，它不持有模型、不代管资产账本，不是数据通路上的一环。
- ⛔ 不要把「管理器不可达」变成「语音功能不可用」。

---

## 8. 已知限制（不隐藏）

1. **删除旁路**：Framework 的 `DELETE /api/assets/<id>/payload` 可被任何持有 admin token
   的调用方直接调用，不经过本包的引用检查。修它需要改 Framework（本轮禁止），
   故此限制**如实记录**而非假装不存在。
2. **无断点续传**：`fetchAssetFiles` 是 `.part` → 流式 sha256 → 原子改名，中断即重来。
3. **上游信息不进列表**：`/live` 不打外网，`upstream.known` 在列表里恒为 false；
   要上游元数据请查单个资产或 `check-update`。
4. **GitHub payload 未实现**：`source: 'github'` 的项目只做展示。
5. 事件流与作业历史都有界（200 / 50），断线过久会 `truncated`。
