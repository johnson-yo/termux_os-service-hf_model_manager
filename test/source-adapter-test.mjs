/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Manager source coordinates and a replaceable custom adapter.
 * [OUTPUT]: Regression proof that all sources hand Core the same transfer shape.
 * [POS]: hf-model-manager/test/source-adapter-test.mjs.
 * [PROTOCOL]: This test never contacts a source and never requires Framework changes.
 */

import { createSourceRegistry, resolveTransferFile, resolveTransferFiles } from '../service/transfer-sources.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => { count++; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
const base = { path: 'model.bin', repository: 'owner/repo', revision: 'a'.repeat(40), remote_path: 'weights/model.bin',
  size: 7, sha256: 'b'.repeat(64) };

const hf = resolveTransferFile({ ...base, source: 'huggingface' });
const github = resolveTransferFile({ ...base, source: 'github' });
test('HF and GitHub adapters return the same Core transfer fields', hf?.path === github?.path
  && hf?.size === github?.size && hf?.sha256 === github?.sha256 && hf?.url !== github?.url);
test('omitted host preserves the published Hugging Face compatibility default', resolveTransferFile(base)?.url.startsWith('https://huggingface.co/') === true);

const registry = createSourceRegistry().register('modelscope', (file) =>
  `https://modelscope.example/${file.repository}/${file.revision}/${file.remote_path}`);
const modelscope = resolveTransferFiles([{ ...base, source: 'modelscope' }], { registry });
test('a fake ModelScope Manager needs no Core branch', modelscope.length === 1
  && modelscope[0].url.startsWith('https://modelscope.example/'));

test('an explicit signed URL works for an otherwise unknown source', resolveTransferFile({ ...base,
  source: 'custom', url: 'https://signed.example/object' })?.url === 'https://signed.example/object');
test('malformed source metadata is rejected before Core sees it', resolveTransferFile({ ...base, source: 'huggingface', size: 0, sha256: 'bad' }) === null);

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
