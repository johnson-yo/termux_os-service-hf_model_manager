# Dependency maturity — Raw Model Package Manager 0.4.7

The manager is optional by design. It improves discovery and lifecycle UX but
is not required for a consumer to access its own declared raw Asset.

## Failure behavior

| Failure | Manager response | Consumer action |
|---|---|---|
| manager not installed | capability absent | use the consumer's own Framework Asset contract |
| manager service unavailable | the Manager capability is unavailable | keep the consumer path independent |
| Registry unavailable | package cards are `unknown` | do not call them `none`; retry later |
| Framework inventory unavailable | local status is `unknown` | retry the read-only seam; do not claim completeness or turn the outage into a lifecycle prohibition |
| Framework is still booting | a failed snapshot is retried after a short backoff | do not keep the startup failure cached |
| malformed `.models` path | declaration error is visible | fix the owning Package; do not infer usage |
| current declaration exists | Manager shows a warning and requires explicit confirmation | the user decides whether to remove the payload; the declaration is usage information, not a Core delete lock |
| Payload has no current catalog card | Manager exposes it through the Core Payload inventory and the same confirmation flow | inspect/verify/delete the orphan explicitly; do not silently discard it |
| raw archive conflict | the generic primitive reports an integrity/path conflict | preserve existing bytes and choose the correct archive |

## Boundary

This package owns grouping Registry projects into model cards, presenting
current declarations, and the complete raw Asset payload lifecycle: source
selection, download/resume, verification, storage, update, delete warning and
deletion. An Asset Package owns declaration/registration and install-time
provisioning. Framework Core is an optional substrate for policy-free path,
transfer, archive, integrity, and atomic-storage primitives; it must not turn
`optional`, provider load state, or `.models` declarations into a Manager
permission check. A future consumer may request an absolute raw file path and
then apply its own business/runtime policy. This package must not become that
runtime policy.

The 0.4.7 release is packaged and device-tested, and its public source is
published through the GitHub tag and Cloudflare Package Registry.
