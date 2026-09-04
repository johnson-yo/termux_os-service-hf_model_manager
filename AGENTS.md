# github.termux-os.service.hf-model-manager

> L2 | Parent: Termux-OS Framework Extension Packages

共享的模型 / Asset 管理服务。⛔ 它不持有任何业务语义——
「CAM++ 缺了要不要关掉助手」永远是消费方的判断。

## Members

- `package.mjs`: 薄注册层。注册服务、逐条代理路由、提供 `termux-os.assets.manager` capability。
  ⚠ Framework 的包路由是**精确路径匹配**（`x.path === subpath`，query 已剥掉），没有通配符——
  所以带 asset id 的操作在代理层用 `?id=`、在 service 层用路径段。漏注册一条 =
  `unknown_package_route`，而丢弃响应的调用方完全看不出来。
- `service/cf.mjs`: Registry adapter。⭐ 归一化，**不把 CF 的 `projects/versions/files` 原样透出去**。
  `latestInstallable` 只认带归档且 verified 的版本——asset 项目里还躺着以 commit sha 当版本名的
  payload 行，算进来 `latest` 会变成一串 40 位十六进制。
- `service/hf.mjs`: 上游元数据。⛔ 它说的**不是**「可以更新」。HF 不提供 sha256。
- `service/framework.mjs`: 本机账本与三个生命周期动作。⛔ 不实现 sha256 / `.part` /
  原子 rename / target 比较 / 磁盘预检——那五样 Framework 都做对了。
- `service/merge.mjs`: ⭐ **纯函数**。三类权威的边界与更新三分法都在这里，可毫秒级证伪。
- `service/references.mjs`: 声明式引用（从已装包 manifest 推出）+ 显式引用 + 删除判断。
  ⭐ 引用是**声明态**：「此刻没在跑」不是删除理由。
- `service/operations.mjs`: 把 Framework 的**同步阻塞** fetch 包成可查询作业。⛔ 不伪造字节进度。
- `service/unmanaged.mjs`: 看见历史目录，⛔ 不接管、不猜、不导入、不删、不算 sha256。
- `service/main.mjs`: HTTP 路由与编排。
- `web/`: 一页可用的界面。⛔ 不问凭证、不展示 raw JSON / CF 内部字段 / 账本结构。

## Rules

- **三类事实永不压平**：响应里恒有 `registry` / `upstream` / `local`。
  压平之后「本机装的版本」与「上游有个新 commit」会变成同一个字段，而可信度完全不同。
- **source 取自 registry 字段，⛔ 绝不从 package id 前缀猜。** 历史包 id 写着 `github.*`
  而实际在 Hugging Face；按前缀显示就是当着使用者的面说错话。
- **只有 Registry 里更高的已批准版本才叫「可更新」。** 上游动了只是提示——
  把它显示成可更新，等于邀请人去装一个没有校验值的 HEAD。
- **读不到 ≠ 没有。** 任一远端不可用时如实 `available:false`，
  ⛔ 不返回空列表冒充「什么都没有」，⛔ 不返回 `up_to_date` 冒充「已是最新」。
- **删除前问引用；问不到就不删。** 声明式引用列不出来时返回 `references_unknown`，
  ⛔ 不按「没查到 = 没人用」放行——那两者之间差着一个不可逆操作。

[PROTOCOL]: 變更時更新此頭部，然後檢查 CLAUDE.md


## docs/092 · logical model 与「下载 / 使用」两个生命周期

⭐ **使用者看到的是 logical model（SenseVoice），⛔ 不是一堆内部 asset 行。**

- `service/logical.mjs` —— logical model 层。⭐ **它是一个派生，不是一张新表**：
  现有 asset id 已经把关系写在名字与 target 里（绑了 `htp` 的是 prebuilt、无 target 的图是 source），
  派生一遍 ⇒ **零 schema 变更、零迁移、不动任何已发布的 HF 仓库与 URL**。
  ⚠ 角色判据是 **target 有没有绑硬件**，⛔ 不是名字里有没有 `ctx` —— 名字是人写的，改个名就漂。
- `service/modelstate.mjs` —— 每个 logical model 一个小 JSON，原子写。
  ⭐ 它回答的是三类权威都答不了的那个问题：**这台机器上这个模型现在能不能跑**。
  ⚠ `enabled` = 「最近一次被 App verify 成功」，⛔ 不是永久保证。
  ⭐ 启动必须对赈被打断的 `preparing` —— 永久卡在「准备中」是一个使用者点不动也看不懂的死状态。
- `service/app.mjs` —— **唯一**一条通往 App 的边（经 `termux-os.app.api`）。

### docs/093 · 0.2.0：消费方只认 logical model

- `logical.mjs` 现在还透出 `roles`（role → 文件名映射）、`legacy`、`note`。
  ⭐ **消费方按 role 取文件，⛔ 不拼文件名** —— 拼出来的名字会在换一份产物时安静地失效。
- `downloadChoices` 过滤 `legacy !== true`。
  ⭐ **「不推荐」与「删掉」是两件事**：legacy 只改新用户看到什么，
  ⛔ 旧文件与旧 URL 一个不删，已经装了的机器照常能用。
- `package.mjs` 新增 `/model`、`/model/resolve`、`/model/download`、`/model/use`。
  ⚠ Framework 的包路由是**精确路径匹配、没有通配符** ⇒ 带 id 的路由只能写成 `?id=`。
  ⚠ 改 `package.mjs` 必须 `framework.sh restart`（ESM 缓存，docs/079）；
  ⭐ 而且要先确认**对端拿到的是哪一份**——「改了没生效」与「改了没送到」报错一模一样。
- prepare 保持**同步**（⛔ 不做 job 引擎），所以本地编译那个选项**必须在 UI 上写明耗时**：
  使用者要能在点下去之前就知道自己要等。

### ⛔ 这个包不实现 QNN

`boundary-test.mjs` 机械保证：Manager 里**不出现** `ep.context_enable` / `OrtEngine` /
`recycleOrt` / `enable_htp_fp16` / `ctx_cache` / `OrtSession`。
它**可以**知道 `htp`/`qnn` —— 那两个值用于**推荐与诊断**，⛔ 不用于执行、也不用于判定兼容。

### ⭐ 删除 source 的顺序是硬的

App 生成 → load 成功 → inference verify 成功 → **`noteEnabled` 落盘并回读确认** → 才删 source。
删除走 Framework 的 `dropPayload`，⛔ 不是 `rm`：直接删文件会留下一个「账本以为还装着」的资产。
**谁保证了前提，谁才有资格执行后果。**

### ⭐ 推荐不是 gate

`recommended:false` 的候选照样列出、照样可点、「使用」时照样会被尝试（只排在推荐的后面）。
最终兼容性永远以 App 的真实 load + minimal inference 为准。

### ⚠ 版本比较

HF asset 的 registry `latest_version` 是 **commit SHA** 而本机装的是**包版本**。
规则：**同为 semver 才谈大小、同为 revision 只谈相等、混着就是 `unknown`**。
⛔ 不可比时不许返回 `up_to_date` —— 那是一个断言，而我们没有做出它的依据。
