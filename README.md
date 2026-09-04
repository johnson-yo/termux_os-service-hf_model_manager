# Raw Model Package Manager

`github.termux-os.service.hf-model-manager` is the local raw model package
catalog and file manager. One package is one approved Registry project and its
real source/repository identity. Every approved raw file is shown inside that
package card, including multifile packages.

This package does not prepare, execute, or decide readiness for any consumer.
It does not own a second model ledger, write the shared model store directly,
remove consumer caches, or infer a source from a Package id. Framework Core
owns the Asset Registry, shared-store path, direct-first download with
Registry fallback, `.part` resume, hash/size verification, atomic rename,
archive import, and generic raw purge. Consumers own their own runtime policy.

## Identity and local declarations

The Registry identity is `source + repository + package_id`. The package
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

This development candidate is not formally published to GitHub or the
Cloudflare Registry in the Framework release round. It may be packed and
installed through the local Framework development flow for device acceptance.
