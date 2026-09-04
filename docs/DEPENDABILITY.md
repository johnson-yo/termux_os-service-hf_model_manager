# 依赖成熟度评估 — HF Model Manager 0.1.1

本文回答一件事：**别的 package 现在能不能正式依赖它**，以及依赖时该怎么写。
判据是「坏了会怎样」，不是「好的时候好不好用」。

---

## 1. 结论

**可以依赖，但只能作为 `optional`。** 理由不是它不稳，而是**它不在数据通路上**：
它是协调层，模型的解析、取回、校验自始至终由 Framework 的资产系统完成。
把它写成 `required`，等于给语音链凭空加一个新的单点故障，换来的只是一个更好看的界面。

---

## 2. 给 termux-speech 的写法建议（§12）

**推荐 `capabilities.requires`，⛔ 不用 `packages.requires`。**

```jsonc
// termux-speech 的 termux-os.package.json
"capabilities": {
  "requires": [
    { "id": "termux-os.assets.manager", "required": false }
  ]
}
```

理由：

| | `packages.requires` | `capabilities.requires` |
|---|---|---|
| 绑定的是 | **这一个包**（连同它的 id 与版本） | **这件能力**，谁提供都行 |
| 换实现 | 要改 speech 的 manifest | 不用动 speech |
| 派生实例（`<id>@<slug>`） | id 带后缀 ⇒ **匹配不上** | 照常解析 |
| 版本约束 | 有 | 无 |

⭐ 决定性的一条是**派生实例**：设备上开发闭环会把包装成 `<id>@<slug>` 的并存实例。
写 `packages.requires` 的 speech 在派生实例上会认不出管理器；写 capability 的不受影响。

⚠ 唯一的代价是拿不到版本约束。可以接受，因为本文 §3 的契约面已经冻结，
且破坏性变更会换 schema 名（`termux-os.assets-live.v1` → `.v2`），消费方读得到。

⛔ **不要同时写两处**。同一件事两个声明处，迟早有一处被忘记维护
（Framework 自己的依赖阶梯就踩过这个：`integrations.requires` 与 `capabilities.requires`
两处并存，结果九个包写的那处**从来没有被阶梯读过**）。

---

## 3. 已冻结的契约面

见 `docs/CONSUMER_API.md`。schema：`termux-os.assets-live.v1` / `termux-os.assets-events.v1`。

---

## 4. 故障时会发生什么（都已在真机上试过）

| 故障 | 观察到的行为 | 消费方该怎么办 |
|---|---|---|
| 管理器**没装** | capability 解析不到 | 走 Framework 原有资产路径（夹具已验证干净降级） |
| 管理器进程**被 kill -9** | Framework 代理回 **502 `manager_unreachable`，17 ms**，不挂起 | 同上；⚠ **不会自动重启**（见下） |
| Framework 重启 | 管理器随之重启，状态自愈；显式引用挺过重启 | 无需动作 |
| Registry 不可达 | `registry.known:false`，本机信息照常 | 照常用本机资产 |
| 上游（HF）不可达 | `upstream.known:false` | 无影响（列表本来就不打外网） |
| Framework 账本读不到 | `framework_available:false` + `counts.assets:0` | ⛔ **必须两个一起读**，否则会把「问不到」当成「没有资产」 |

⚠ **服务不会自动重启，这是 Framework 的刻意设计**
（`src/stage/manager.mjs`：「進程自行退出時把事實寫回 metadata（不自動重啟，018 §6.6 刻意限制）」）。
所以「管理器不在」不是异常路径，是**必须支持的常规状态**——这也是它只能 `optional` 的第二个理由。

---

## 5. 已知限制：删除旁路（§8 的调查结论）

**Framework 的 `DELETE /api/assets/<id>/payload` 绕过本包的引用检查。** 记录为
**KNOWN_LIMITATION**，本轮不改 Framework。

调查结果（读 `src/server.mjs:1857-1881`）：

- **谁能调**：任何持 `write` 权限的调用方。`authenticateRequest` 给 **admin token** 与
  **浏览器会话**都发 `['read','write']`（`src/system/auth.mjs:204,171,193`）。
  每个已装 package 拿得到 `context.auth.systemKey()`，因此**每个包都能调**。
- **它做什么**：`deactivateAsset()` 然后 `fs.rmSync(entry.path, {recursive:true, force:true})`。
  **全程没有任何引用检查**——Framework 今天没有引用计数这个概念。
- **⭐ 现有的唯一护栏**：`entry.fetched_on_demand !== true` ⇒ 409 `not_on_demand`
  （「removing it would make "installed" untrue」）。
  即**随包安装的 payload 删不掉**，只有按需取回的能删。
- **参考机实际暴露面（SM8550 实测账本 6 条）**：`fetched_on_demand=true` 的有 **2 条**——
  `model.sensevoice.ctx` 与 `model.campplus.ctx`。
  ⚠ 这两条恰好都是 **termux-speech 依赖的**，也就是说暴露面虽小，但正对着要保护的东西。

**为什么本轮不改**：任务禁止改 Framework，除非证明是硬阻塞。它不是——
本包自己的删除路径是 fail-closed 的，语音链也不会因此不可用；这是**系统级强制力**的缺口，
不是本包可依赖性的缺口。⛔ 而且不该由本包偷偷补：一个只在「走管理器时」才生效的保护，
会让人以为资产受保护了，那比明说没有保护更危险。

**将来最小改法（留给专门一轮）**：在那个 handler 的 `not_on_demand` 检查之后、
`deactivateAsset()` 之前加一次引用询问，无人可答时 fail-closed。
判据必须来自 Framework 自己能算的东西（各包 manifest 的 `assets.requires`），
⛔ 不能让 Framework 反过来依赖某个 package 才能决定能不能删。

---

## 6. **没有**做的事（不隐藏）

- ⚠ 断点续传与直连优先**已在 Framework 侧实现**（资产投递层），⛔ 不在本包内；
  本包只声明需求，取回由 Framework 执行。
- ⚠ 上游不可达/Registry 不可达只在**进程内**用死端口验过（`test/boot-test.mjs`），
  设备上没有断网复现——不谎称做过。
- ⚠ 事件流的 `truncated` 只有单测覆盖；真机上事件数远没到 200 的上限。
