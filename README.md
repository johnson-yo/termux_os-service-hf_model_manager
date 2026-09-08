# 模型管理

`github.termux-os.service.hf-model-manager` is the local raw model package
catalog and file manager. One package card is one approved Registry project and
its real source/repository identity. Every approved raw file is shown inside
that package card, including multifile and multi-source packages.

This package does not prepare, execute, or decide readiness for any consumer.
It does not own a second model ledger, write the shared model store directly,
remove consumer caches, or infer a source from a Package id. Framework Core
owns the Asset Registry, shared-store path, direct-first download with
Registry fallback, `.part` resume, hash/size verification, atomic rename,
archive import, and generic raw purge. Consumers own their own runtime policy.

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
| POST | `/refresh` | refresh Registry, Framework inventory, declarations, and manifests |
| POST | `/package/download?id=...` | download/continue/retry via Framework; returns an operation |
| POST | `/package/verify?id=...` | explicit Framework hash verification; returns an operation |
| DELETE | `/package/delete?id=...` | delete raw payloads after usage guard; returns an operation |
| POST | `/package/import` | stream a `tar.gz` raw Asset archive to Framework |
| GET | `/operations` and `/operation?id=...` | operation state and real byte progress |
| GET | `/events?after=...` | bounded cursor feed |

Each Registry file carries `source`, `repository`, immutable `revision`,
`remote_path`, `local_path`, size, SHA-256, and optional `role`. The Manager
does not scan an upstream tree, guess a basename, or add a file from a local
manifest. A manifest only maps an approved file to its Framework Asset
provider. If an installed manifest has a different source revision for the
same bytes, the map is accepted only with the same source/repository/path,
size, and SHA-256; the Manager never falls back to a basename guess.
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
operations without hard-coding this Package id. Consumers should make the
capability dependency optional.

## Archive format

Framework accepts a `tar.gz` containing:

```text
termux-os.asset-archive.json
payload/<asset>/<declared-file>
```

The manifest is `termux-os.asset-archive.v1` and declares package id, version,
target, each Asset id, and every file's relative path, size, and sha256. Core
rejects traversal, symlinks, special files, missing files, hash/size mismatch,
and conflicting existing bytes. The manager only streams the archive; it never
extracts into the shared model store.

## Development and verification

```sh
node test/run-all.mjs
node scripts/verify-device.mjs
```

The package is published through the GitHub tag and Cloudflare Package
Registry. A local SDK archive is a separate deterministic artifact used for
installation and verification; the Registry source archive is always resolved
from the public GitHub tag.
