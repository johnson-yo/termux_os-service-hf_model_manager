/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The Manager's isolated test aggregate.
 * [OUTPUT]: The SDK-required Package self-test entrypoint.
 * [POS]: hf-model-manager/test/self-test.mjs.
 * [PROTOCOL]: Keep the SDK entrypoint mapped to the complete local test suite.
 */

await import('./run-all.mjs');
