# HF Model Manager

Termux-OS 里所有业务 package 共用的**模型 / Asset 管理服务**。
一个目录、一份已装清单、一个知道「这台机器到底能不能跑这个模型」的地方、
一个知道「谁在依赖它、能不能删」的地方。

**第一版只支持 Hugging Face。** 没有 GitHub payload adapter——
不是取舍，而是 Framework 的资产取用器今天只会 HF（`assetFileUrl` 写死 `source: 'huggingface'`）。
做一个「看起来支持 GitHub」的分支，只会得到一个装不上的包。

## 三个角色，不要混

| | 谁 | 负责什么 |
|---|---|---|
| **Asset Package** | `*.termux-os.asset.*` | **身份**：source / version / files / target / hash / license / metadata |
| **Manager**（本包） | `github.termux-os.service.hf-model-manager` | **生命周期**：目录、库存、解析、安装、校验、更新判断、引用、删除护栏 |
| **Consumer** | termux-speech 等 | **产品语义**：CAM++ 缺了要不要关掉助手、SenseVoice 是不是当前 ASR |

⛔ Manager **不知道**哪个模型是「推荐的」，也不决定任何功能开不开。
它只回答事实：有什么、装没装、能不能跑、多大、谁在用。

## 几个词不是同义词

| 词 | 意思 |
|---|---|
| **managed** | Framework 资产账本认识它（有版本、target、checksum） |
| **unmanaged** | 共享模型目录下的历史目录，账本一无所知（参考机上约 16 GB） |
| **installed** | 账本里有一条 active 记录，且文件在盘上 |
| **referenced** | 有已装 package 声明依赖它（或显式登记过） |
| **loaded** | 此刻真的被某个 worker 加载进内存 |

⭐ **remove ≠ unload。** 「此刻没在跑」不是删除的理由——
下一次唤醒它就坏了。所以引用判据是**声明态**，不是运行态。

## 三类权威，永不压平

| 来源 | 它说了算的 |
|---|---|
| **Hugging Face** | 上游此刻的样子：latest commit、修改时间、license、tags、文件表 |
| **Cloudflare Registry** | **已批准**的版本、revision、size、**sha256**、白名单 |
| **Framework 资产账本** | 本机装了什么、提供方、target、路径、是否按需取的 |

API 响应里恒有 `registry` / `upstream` / `local` 三个子结构。
⛔ 压平之后，「本机装的是 1.0.0」与「上游有个新 commit」会变成同一个 `version` 字段，
而它们的可信度完全不同。

### 更新是三分法，不是布尔

| 状态 | 含义 |
|---|---|
| `up_to_date` | 已批准的最新版本就是本机这一版，且上游没动 |
| `approved_update_available` | **Registry 里有更高的已批准版本** —— 这才叫可更新 |
| `upstream_changed_unapproved` | 上游动了，但没有人审过、没有 sha256 ⇒ **只是提示** |

⛔ 绕过 Registry 直接把 HF HEAD 装成正式资产是被禁止的。

## 新 Asset Package 命名契约

从现在起，**新** asset package 必须是：

```
<source>.termux-os.asset.<name>
```

- Hugging Face：`huggingface.termux-os.asset.<name>`
- GitHub：`github.termux-os.asset.<name>`

**source namespace 必须与 descriptor 和 payload 的实际来源一致**，
而且第一版**不支持** descriptor 与 payload 分属不同 source。

⚠ 现存的 `github.termux-os.asset.{campplus,sensevoice,fireredvad,qwen3asr}`
是**历史命名债**：它们的 descriptor 与 payload 其实都在 Hugging Face。
**本包不迁移它们**——为了名字一致让使用者重新下载 1.36 GB 是不划算的交易。
UI 上它们的 **Source 一律显示 Hugging Face**，因为 source 取自 registry 字段，
⛔ 不从 package id 前缀猜。provider package 的历史名字只在详情里如实列出。

## API

前缀 `/api/packages/github.termux-os.service.hf-model-manager`。
⚠ Framework 的包路由是**精确路径匹配**，所以带 id 的操作在代理层用 `?id=`。

| 方法 | 路由 | 作用 |
|---|---|---|
| GET | `/live` | 页面用的一个热端点：三方可用性 + 全部资产 + 进行中的操作 |
| GET | `/catalog` | Registry 里的 HF asset 项目 |
| GET | `/assets` | 全部资产的三方合并视图 |
| GET | `/asset?id=` | 单个资产（含上游元数据与引用） |
| GET | `/installed` | 已安装清单 |
| POST | `/asset/resolve?id=` | 复用 Framework 的 target matcher |
| POST | `/asset/install?id=` | 装提供方包 → 作业 |
| POST | `/asset/fetch?id=` | 取按需 payload → 作业 |
| POST | `/asset/verify?id=` | 复用 Framework 的逐档 sha256 → 作业 |
| POST | `/asset/check-update?id=` | 强制刷新三方并给出三分法状态 |
| GET | `/asset/references?id=` | 谁在依赖它 |
| DELETE | `/asset?id=` | **带引用护栏**的按需资产删除 |
| GET | `/models` · `/model?id=` | logical model 列表 / 详情 |
| POST | `/model/download?id=` | 下载模型及缺失伴随资产 |
| POST | `/model/use?id=` | 准备并启用模型 |
| DELETE | `/model?id=` | 停用后删除 logical model 的全部本地产物 |
| GET / POST / DELETE | `/references` | 显式引用的读写 |
| GET | `/operations` · `/operation?id=` | 作业列表与单个作业 |
| GET | `/unmanaged` | 历史目录清单（只到目录级） |

### capability

`termux-os.assets.manager`（action `assets.manager.query`）。
consumer **只认 capability id**，⛔ 不写死端口、不写死本包的 id：

```js
POST /api/capabilities/termux-os.assets.manager/invoke
{ "input": "{\"op\":\"resolve\",\"asset_id\":\"model.campplus.ctx\"}" }
```

支持的 `op`：`catalog` `assets` `installed` `detail` `resolve` `check-update` `references`。

## 当前限制（明写，不隐瞒）

- **无断点续传**。Framework 的取用器失败即删 `.part`，1 GB 断在 90% 要从 0 重来。
- **无 GitHub payload adapter**（见开头）。
- **按需资产删除与 logical model 删除是两条不同路径。** 普通
  `DELETE /api/assets/<id>/payload` 仍只允许删除 `optional`、按需取得的载荷；logical
  model 删除先让 App 停用对应 runtime，再通过带 `logical_model_id` 与
  `deactivated=1` 的 Framework 受限入口清理包随附资产，最后才清 Manager state。
- **package 声明引用不是 runtime 锁。** 页面会显示已知声明引用数量，但删除由 App 返回的
  `active_after` 决定；若停用失败或仍 active，不删除任何资产。
- **旧 asset package id 保持历史原样**，不迁移。
- **共享 store 的路径仍由提供方 package id 构成**
  （`<store>/<providing-package-id>/<version>/<target>/`）——
  改成 asset-id 键的共享布局属于下一阶段。
- **下载进度是 Framework 文件流的真实字节观察**：按文件汇总 `bytes_done/bytes_total`，
  没有总量时只显示阶段，不按时间伪造百分比。模型准备进度来自 App 的真实阶段映射与
  `GET /api/inference/model/prepare/status`，也不按等待时间自增。
- **Qwen3-ASR 的 q4 decoder 是完整模型的有效必需部件。** 旧 manifest 的 `optional` 只代表
  可以延后下载，页面仍会显示「还缺：解码器（q4）」并保持「部分下载」。

## 给别的 package 用

契约冻结在 **[`docs/CONSUMER_API.md`](docs/CONSUMER_API.md)**，
能不能依赖、怎么写依赖在 **[`docs/DEPENDABILITY.md`](docs/DEPENDABILITY.md)**。

一句话：**只走 capability discovery，并且写成 `optional`。**
⛔ 不要写死这个包的 id 或端口——设备上开发闭环会造出 `<id>@<slug>` 的派生实例，
写死的常量在那上面全部失效。

## 开发

```sh
node test/run-all.mjs                   # 全部纯逻辑测试，⛔ 不碰真机、不删任何资产
node scripts/verify-device.mjs          # 设备上、服务运行时
```

四个测试文件各管一件事：

| 文件 | 管什么 |
|---|---|
| `self-test.mjs` | 合并、更新状态三分法、registry 归一化等纯逻辑 |
| `contract-test.mjs` | 对外契约：capability 注册、feed 游标、热状态、变化探针、文档同步 |
| `reference-test.mjs` | 引用的生命周期——声明式是推导量，显式是持久量 |
| `boot-test.mjs` | ⭐ **真的把服务起起来**，远端全部指向死端口 |

⚠ `boot-test.mjs` 的存在理由是一次真实事故：某次重构把一个辅助函数弄丢了，
**119 条纯逻辑断言全绿**，而真机上每一条列表路由都回 `500 … is not defined`。
**纯模块测得再密，也证明不了那些模块被正确地接在了一起。**
