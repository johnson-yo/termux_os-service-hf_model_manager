# Raw Model Package Manager — Consumer Contract v2

This document freezes the raw-only consumer boundary. Consumers discover the
capability instead of importing this Package id or assuming a service port.

## Discovery

Use the optional capability `termux-os.assets.manager` and invoke the action
with a JSON string:

```js
const answer = await context.capabilities.invoke('termux-os.assets.manager',
  JSON.stringify({ op: 'packages' }));
```

Supported operations are `summary`, `packages`, `models`, `catalog`,
`installed`, `declarations`, `package`, `model`, `file`, `refresh`,
`download`, `verify`, `remove`, `operation`, `operations`, and `events`.
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

Each `assets[]` entry also exposes the provider/payload state used to choose an
action: `provider_state` is `absent|loaded`, `declared` distinguishes a
Framework provider from catalog metadata, `payload_state` is
`missing|partial|ready|error`, and `action` is
`install_provider|fetch|verify|blocked`. The card's `actions` are derived from
those states: a ready package has no download action, a declared optional
provider with a missing payload uses Framework `/fetch`, and a blocked action
is disabled with `download_reason`.

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

- Download, resume, retry, progress, direct-first routing, Registry fallback,
  hash, size, fsync, atomic rename, and free-space preflight are Framework
  responsibilities.
- The manager asks Framework to install a provider only when the provider is
  absent and installable. A `202` provider response is a Package job, not a
  ready provider: the manager waits for the generic job status, rereads
  inventory, and only then decides whether an optional payload can use
  Framework `/fetch`. A `409 already_declared` is re-read as a race, not
  treated as permission to fetch blindly.
- A loaded optional provider with a missing/partial payload goes directly to
  Framework `/fetch`; required payloads are verified/reused or reported as
  requiring Package installation. The manager never constructs a download URL
  or writes `/sdcard/termux-os/models` itself.
- The Registry file list is authoritative. A manifest can only associate an
  approved file with a provider and exact relative path; it cannot add files.
  This permits one package to merge multiple upstream repositories while
  keeping every source/repository/revision/remote_path visible.
- Delete is blocked while a current `.models` declaration names the package.
  Once allowed, the manager passes package/version/target/path expectations to
  Framework's generic purge boundary. No adjacent cache is touched.
- Archive import is a streamed raw Asset operation. The manager does not
  unpack arbitrary archives or invent a second file manifest.
- There is no prepare, activate, consumer restart, execution path, or runtime
  resolve operation in this contract.

## Optional dependency behavior

Consumers must degrade when the manager is absent or unavailable. A consumer
that needs a raw path can use its own declared Asset dependency and Framework's
generic Asset contract. The manager is a catalog and convenience boundary, not
the data path for any consumer.
