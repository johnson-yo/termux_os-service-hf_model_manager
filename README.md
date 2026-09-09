# 模型管理

`github.termux-os.service.hf-model-manager` is the local raw model package
catalog and file manager. One package card is one approved Registry project and
its real source/repository identity. Every approved raw file is shown inside
that package card, including multifile and multi-source packages.

An Asset Package is the installable Package that declares/registers an Asset and
may provision its payload during Package installation. This Manager is
independently replaceable and owns the payload lifecycle after registration:
source selection, download, resume, verification, storage, update, deletion,
and the user warning/confirmation for destructive actions. It may use
Framework Core's policy-free path, transfer, integrity, archive, and atomic
storage primitives, but Core must not decide whether this Manager may perform a
payload operation based on `optional`, provider/package load state, consumer
declarations, or source-specific policy. Deleting an Asset payload does not
unregister its Asset Package or declaration.

This package does not prepare, execute, or decide readiness for any consumer. It
does not remove consumer caches, infer a source from a Package id, or merge raw
payload state with runtime/ctx state. The current implementation uses the v2
Core path when available and keeps the old Core route only as an explicitly
scoped compatibility bridge; the bridge is not the lifecycle authority.

## Identity and local declarations

The Registry identity is `(source, repository)`; `package_id` is displayed as
the stable package identifier and is never parsed to infer source. The package
version and upstream revision are separate fields: a semver package version is
not compared with a Git revision. A Registry project without an explicit
`package_id` is an upstream allow-list entry, not an installable model package.

An installed consumer may declare a raw model user with an empty file:

```text
<installed-package-root>/.models/<hf-owner>/<hf-repository>
```

The Framework read-only seam scans these declarations on refresh. They survive
a Package update, disappear with Package uninstall, and are never persisted by
this manager as a consumer ledger.

## API

The Framework package prefix is:
`/api/packages/github.termux-os.service.hf-model-manager`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/overview` | device basics, model root, free space, raw usage, counts, refresh state |
| GET | `/packages` or `/models` | grouped raw model package cards |
| GET | `/package?id=<source:repository>` | one package card |
| GET | `/file?id=<source:repository>&path=<path>` | one approved raw file and its absolute local path |
| GET | `/catalog` | Registry availability and package cards |
| GET | `/installed` | Framework Asset inventory |
| GET | `/declarations` | current `.models` users and explicit errors |
| GET | `/payloads` | Core Payload inventory, including unselected orphan Payloads |
| POST | `/refresh` | refresh Registry, Framework inventory, declarations, and manifests |
| POST | `/package/download?id=...` | Manager-owned download/continue/retry; may use Core primitives; returns an operation |
| POST | `/package/verify?id=...` | Manager-owned explicit payload verification; returns an operation |
| DELETE | `/package/delete?id=...` | show usage warning, require confirmation, then delete raw payloads; returns an operation |
| POST | `/payload/delete-plan?id=...` | show impact for a Payload without requiring a catalog card |
| DELETE/POST | `/payload/delete?id=...` | require the plan token, then delete one Payload; returns an operation |
| POST | `/package/import` | Manager-owned raw Asset archive import; may use Core safety primitives |
| GET | `/operations` and `/operation?id=...` | operation state and real byte progress |
| GET | `/events?after=...` | bounded cursor feed |

Each Registry file carries `source`, `repository`, immutable `revision`,
`remote_path`, `local_path`, size, SHA-256, and optional `role`. The Manager
does not scan an upstream tree, guess a basename, or add a file from a local
manifest. An installed Asset Package manifest registers the Asset identity;
the Manager associates an approved Registry file with that registered Asset
without turning registration into a payload permission gate. If an installed
manifest has a different source revision for the same bytes, the map is
accepted only with the same source/repository/path, size, and SHA-256; the
Manager never falls back to a basename guess.
`total_bytes` and `downloaded_bytes` are package-card fields;
operation snapshots additionally expose the package/provider/asset/file,
real `bytes_done`/`bytes_total`, byte-precision `progress`, `speed_bps`, the
Framework `route`, `retry_count`, `resumed`, and `resume_from_bytes`. A
stage-only operation never fabricates a byte percentage.

The WebUI has exactly two top-level sections: `概览` and `模型`. Cards expose
`基本信息`, `占用情况`, and `文件`, with `下载`, `继续下载`, `重试`, and `删除`
actions. “占用情况” means the current `.models` declaration scan; an empty
scan is shown as `没有当前声明的使用者`.

The capability `termux-os.assets.manager` exposes the same read and lifecycle
operations without hard-coding this Package id. It additionally supports
`payloads`, `payload-delete-plan`, and `payload-remove` for orphan Payloads.
Consumers should make the capability dependency optional.

## Archive format

The Manager accepts a `tar.gz` containing:

```text
termux-os.asset-archive.json
payload/<asset>/<declared-file>
```

The manifest is `termux-os.asset-archive.v1` and declares package id, version,
target, each registered Asset id, and every file's relative path, size, and
sha256. The Manager owns the import decision and payload landing. It may call
Core's generic archive/path/integrity primitives; those primitives reject
traversal, symlinks, special files, missing files, hash/size mismatch, and
unsafe destinations, but they do not unregister an Asset or decide whether the
Manager may import it.

## Development and verification

```sh
node test/run-all.mjs
node scripts/verify-device.mjs
```

The package is published through the GitHub tag and Cloudflare Package
Registry. A local SDK archive is a separate deterministic artifact used for
installation and verification; the Registry source archive is always resolved
from the public GitHub tag.
