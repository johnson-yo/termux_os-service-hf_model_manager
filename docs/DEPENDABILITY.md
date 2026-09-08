# Dependency maturity — Raw Model Package Manager 0.4.4

The manager is optional by design. It improves discovery and lifecycle UX but
is not required for a consumer to access its own declared raw Asset.

## Failure behavior

| Failure | Manager response | Consumer action |
|---|---|---|
| manager not installed | capability absent | use the consumer's own Framework Asset contract |
| manager service unavailable | Framework proxy returns 502 | keep the consumer path independent |
| Registry unavailable | package cards are `unknown` | do not call them `none`; retry later |
| Framework inventory unavailable | local status is `unknown` | do not delete or claim completeness |
| Framework is still booting | a failed snapshot is retried after a short backoff | do not keep the startup failure cached |
| malformed `.models` path | declaration error is visible | fix the owning Package; do not infer usage |
| current declaration exists | delete returns `package_in_use` | remove the declaration through the consumer lifecycle |
| raw archive conflict | Framework import returns a conflict | preserve existing bytes and choose the correct archive |

## Boundary

Framework Core owns raw byte storage and integrity. This package owns grouping
Registry projects into model cards, presenting current declarations, and
starting/querying operations. A future consumer may request an absolute raw
file path and then apply its own business/runtime policy. This package must not
become that policy.

The 0.4.4 release is packaged and device-tested, and its public source is
published through the GitHub tag and Cloudflare Package Registry.
