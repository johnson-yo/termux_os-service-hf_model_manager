# HF Model Manager

HF Model Manager manages raw model-package payloads for Termux-OS. It supports catalog discovery,
download and resume, verification, install, update, and deletion with a usage warning.

The manager owns payload lifecycle only. The Android App owns consumer-specific preprocessing,
runtime preparation, inference, and readiness; the manager does not execute models or apply
consumer policy. Target-specific contexts remain separate assets and are not added to the raw-model
mapping.

Install through the Termux-OS Package Registry. Development checks are available in `test/`.

Licensed under Apache-2.0. See `LICENSE` and `NOTICE.md`.
