# Raw Model Package Manager — Consumer Contract v2

This document freezes the raw-only consumer boundary. Consumers discover the
capability instead of importing this Package id or assuming a service port.

An Asset Package registers the Asset identity and may provision its payload at
installation time. This replaceable Manager owns the payload lifecycle after
registration: source selection, download/resume, verification, storage,
update, deletion, and user warning/confirmation. It may call Framework Core's
policy-free technical primitives, but Core must not actively decide whether a
Manager may download, update, verify, or delete based on `optional`, provider
load state, or consumer declarations. A payload operation never unregisters
the Asset Package. The contract below is the target correction for the current
`0.4.7` implementation; the old `Framework-only` behavior is non-conforming
and must not be extended.

## Discovery

Use the optional capability `termux-os.assets.manager` and invoke the action
with a JSON string:

```js
const answer = await context.capabilities.invoke('termux-os.assets.manager',
  JSON.stringify({ op: 'packages' }));
```

Supported operations are `summary`, `packages`, `models`, `catalog`,
`installed`, `declarations`, `payloads`, `package`, `model`, `file`, `refresh`,
`download`, `update`, `verify`, `remove`, `payload-delete-plan`,
`payload-remove`, `operation`, `operations`, and `events`.
`download`, `verify`, and `remove` return an operation-shaped response. The
`file` operation requires `package_key` and the approved source `path` and
returns a raw absolute path only when that file is present locally.

The feed capability `termux-os.assets.inventory` uses the Framework cursor
format. Its endpoint is discovered from the capability descriptor and accepts
`?after=<cursor>&limit=<1..200>`.

## Package card

`GET /packages` returns `termux-os.raw-model-packages.v1`:

```jsonc
{
  "key": "huggingface:owner/repository",
  "source": "huggingface",
  "repository": "owner/repository",
  "package_id": "provider.asset",
  "package_version": "2.0.0",
  "upstream_revision": "<revision>",
  "status": "complete|partial|none|unknown|error",
  "total_bytes": 123,
  "downloaded_bytes": 123,
  "files": [{
    "path": "model.onnx",
    "local_path": "model.onnx",
    "remote_path": "graph/model.onnx",
    "source": "huggingface",
    "repository": "owner/repository",
    "revision": "<immutable revision>",
    "role": "model",
    "size": 123,
    "sha256": "...",
    "local": { "state": "complete|partial|none|error", "path": "..." }
  }],
  "usage": { "count": 1, "consumers": [{ "package_id": "...", "path": ".models/owner/repository" }] }
}
```

Each `assets[]` entry also exposes registration/payload state. The legacy field
name `provider_state` means whether an Asset Package declaration is registered;
it is not a payload permission. `payload_state` is
`missing|partial|ready|error`, and actions are derived from the payload and
source facts: a ready package may be verified, a missing/partial/error payload
may be downloaded/continued/retried when its Asset is registered and its
coordinates are available, and any payload may be deleted after the Manager's
warning/confirmation. `blocked` is reserved for missing registration/source
coordinates or generic technical safety failures, never for `optional=false`
or merely because a provider is loaded.

`source` and `repository` are Registry fields, both at card and file level. The
manager never derives them from `package_id`. `package_version` and
`upstream_revision` are independent namespaces. Registry unavailability is
`unknown`, not `none`; a partial file
or `.part` prefix is not complete; a size/hash failure is `error`.
Operation snapshots expose `package_key`, `current_asset`,
`current_provider`, `current_file`, real `bytes_done`/`bytes_total`,
byte-precision `progress`, `speed_bps`, the Framework `route`,
`retry_count`, `resumed`, and `resume_from_bytes`. A stage-only operation does
not fabricate a byte percentage.

## Lifecycle rules

- The Manager owns download, resume, retry, progress, source routing, Registry
  fallback, hash/size verification, storage, atomic replacement, update, and
  deletion. It may reuse Core's policy-free primitives for these mechanical
  steps; the Manager chooses when and why they run.
- If the Asset Package is absent, the Manager may offer the separate Asset
  Package registration/install operation. That registration route is not a
  payload permission gate: once an Asset is registered, the Manager may manage
  its payload regardless of `optional` and regardless of whether the Package is
  currently loaded.
- `optional: true` only changes Package-install provisioning (the installer may
  skip the bytes). It does not restrict a later Manager download, update,
  verify, or delete. A registered required Asset whose payload was removed is
  simply `missing` and may be downloaded again by the Manager.
- The Registry file list is authoritative. A manifest can only associate an
  approved file with a registered Asset Package declaration and exact relative
  path; it cannot add files or grant itself a new Asset registration.
  This permits one package to merge multiple upstream repositories while
  keeping every source/repository/revision/remote_path visible.
- If an installed manifest carries a different source revision for the same
  bytes, the association is accepted only when source/repository/path, size,
  and SHA-256 all match. The Registry revision remains the displayed file
  coordinate; a basename-only or guessed association is never accepted.
- Delete shows the current `.models` declarations as an impact warning and
  requires explicit user confirmation. After confirmation the Manager may
  delete payloads installed by either the Asset Package or the Manager itself;
  the operation must not unregister the Asset Package or declaration. No
  adjacent consumer cache, ctx, or executable is touched.
- `payloads` exposes Core's committed Payload facts independently of the
  catalog. An unselected orphan can be verified and deleted through
  `payload-delete-plan` followed by `payload-remove`; the same confirmation
  warning applies, and deletion does not unregister any declaration that may
  still exist.
- Archive import is a Manager-owned raw Asset operation. The Manager validates
  the archive and lands the payload, directly or through Core's generic safe
  archive/path/integrity primitives; Core must not make import ownership or
  lifecycle decisions.
- There is no prepare, activate, consumer restart, execution path, or runtime
  resolve operation in this contract.

## Optional dependency behavior

Consumers must degrade when the manager is absent or unavailable. A consumer
that needs a raw path can use its own declared Asset dependency and a generic
Core read/resolve contract, but that does not transfer payload lifecycle
ownership to Core. The Manager remains a replaceable catalog and payload
manager; it does not own consumer runtime policy.
