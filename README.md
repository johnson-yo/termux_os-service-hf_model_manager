# HF Model Manager

HF Model Manager manages raw model-package payloads for Termux-OS. It supports catalog discovery,
download and resume, verification, install, update, and deletion with a usage warning.

The manager owns payload lifecycle only. The Android App owns consumer-specific preprocessing,
runtime preparation, inference, and readiness; the manager does not execute models or apply
consumer policy.

An Asset declared with `target: "device"` has one variant per device target, and its target list
lives in the catalog: each catalog file names the Asset id and target it serves. The manager shows
and downloads only this device's target, so adding a target is an upload plus catalog rows, with no
Package release.

Install through the Termux-OS Package Registry. Development checks are available in `test/`.

Licensed under Apache-2.0. See `LICENSE` and `NOTICE.md`.
