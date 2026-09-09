# hf-model-manager — raw-only Package L2

Parent: the workspace governance rules and the package documentation contract.

This Package manages approved raw model package metadata and files. It does not
implement consumer/runtime policy. Before changing code, read
`docs/105_hf_model_manager_boundary_and_framework_investigation.md` and the
current raw contract in `docs/CONSUMER_API.md`.

## Boundary

- Registry supplies real `source`, repository, package identity, approved
  version/revision, file list, sizes, sha256, and each file's own provenance
  and package-local path. The card identity is `(source, repository)`; the
  `package_id` is displayed, never parsed as a source hint.
- The Asset Package owns Asset declaration/registration and Package-install
  provisioning. This replaceable Manager owns the payload lifecycle after
  registration: source selection, download/resume/retry/progress, verification,
  storage, update, delete confirmation, and deletion.
- Framework Core may provide policy-free path, transfer, integrity, archive, and
  atomic-storage primitives. Core must not gate those operations because an
  Asset is required/optional, because its declaring Package is loaded/unloaded,
  or because a consumer declaration exists. Payload deletion must not silently
  unregister the Asset declaration.
- `.models/<owner>/<repository>` is read through Framework's current
  declaration seam. This Package does not persist a consumer ledger.
- The Manager may write its designated raw payload root, directly or through
  Core primitives, and never deletes adjacent consumer caches or runtime/ctx
  artifacts.
- Do not modify termux-speech business code in this Package task. Record its
  migration needs in the final numbered report instead.

## API/UI contract

The WebUI has exactly two top-level sections: 概览 and 模型. Model cards
contain collapsible 基本信息, 占用情况, and 文件 groups. Raw file absolute paths may
be shown; generated runtime artifacts and runtime readiness are out of scope.

Every new route must be registered in `package.mjs`, implemented in
`service/main.mjs`, documented in `README.md` and `docs/CONSUMER_API.md`, and
covered by `test/run-all.mjs`.

## Verification

```sh
node test/run-all.mjs
node scripts/verify-device.mjs
```

The Manager is published as a formal GitHub/Cloudflare package only after the
package tests, publication checks, GitHub tag, and Registry readback all pass.

[PROTOCOL]: Update this file when the Package boundary or directory contract changes.
