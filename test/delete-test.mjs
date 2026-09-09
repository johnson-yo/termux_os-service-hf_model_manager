/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Fake v2 Core impact/delete responses and Manager package cards.
 * [OUTPUT]: Regression coverage for warning, explicit detach, CAS progression, and one-use tokens.
 * [POS]: hf-model-manager/test/delete-test.mjs.
 * [PROTOCOL]: Manager may warn about usage but never turns usage into a permanent Core deny.
 */

import { createDeleteCoordinator } from '../service/delete.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };

const calls = [];
const local = {
  async deleteImpactV2(payloadId) {
    return { ok: true, status: 200, data: { ok: true, impact: {
      schema: 'termux-os.asset-delete-impact.v2', payload_id: payloadId, exists: true, state: 'ready',
      ledger_generation: 8,
      selected_by: [{ key: `asset.${payloadId}\u0000generic`, asset_id: `asset.${payloadId}`, variant_id: 'generic' }],
      consumers: [], runtime: { loaded: true }, can_delete: true,
    } } };
  },
  async deletePayloadV2(payloadId, input) {
    calls.push({ payloadId, input });
    return { ok: true, status: 200, data: { ok: true, payload_id: payloadId,
      ledger_generation: Number.isSafeInteger(input.expectedGeneration) ? input.expectedGeneration + 1 : 10 } };
  },
};

const card = {
  key: 'huggingface:owner/repo',
  usage: { count: 1, consumers: [{ package_id: 'consumer.package', path: '.models/model' }] },
  assets: [
    { id: 'asset.one', payload_id: 'payload.one', target: 'generic', ledger_generation: 8, runtime_state: 'loaded' },
    { id: 'asset.two', payload_id: 'payload.two', target: 'generic', ledger_generation: 8, runtime_state: 'unloaded' },
  ],
};

let now = 1000;
const coordinator = createDeleteCoordinator({ local, now: () => now, tokenFactory: () => 'confirm-token' });
const plan = await coordinator.inspect(card);
test('delete plan is explicit and includes impact despite active consumer', plan.requires_confirmation === true
  && plan.confirmation_token === 'confirm-token' && plan.impacts.length === 2
  && plan.impacts.every((impact) => impact.consumers.length === 1 && impact.runtime));
const record = coordinator.take(card.key, plan.confirmation_token);
const removed = await coordinator.remove(card, () => {}, record);
test('confirmed deletion sends exact detach sets to Core', removed.removed.length === 2
  && calls.length === 2 && calls.every((call) => call.input.detach.length === 1));
test('multiple payload deletes advance the CAS generation', calls[0].input.expectedGeneration === 8
  && calls[1].input.expectedGeneration === 9);
let invalid = false;
try { coordinator.take(card.key, plan.confirmation_token); } catch (error) { invalid = error.code === 'confirmation_invalid'; }
test('confirmation token is one-use', invalid);

const expiredToken = 'expired-token';
const expiring = createDeleteCoordinator({ local, now: () => now, ttlMs: 100, tokenFactory: () => expiredToken });
const expiringPlan = await expiring.inspect(card);
now += 200;
let expired = false;
try { expiring.take(card.key, expiringPlan.confirmation_token); } catch (error) { expired = error.code === 'confirmation_invalid'; }
test('expired confirmation cannot authorize deletion', expired);

const orphanPlan = await coordinator.inspectPayload('payload.orphan');
test('orphan Payload gets the same explicit impact confirmation boundary', orphanPlan.requires_confirmation === true
  && orphanPlan.payload_id === 'payload.orphan' && orphanPlan.ledger_generation === 8
  && orphanPlan.impact.selected_by.length === 1);
const orphanRecord = coordinator.takePayload('payload.orphan', orphanPlan.confirmation_token);
const orphanRemoved = await coordinator.removePayload(() => {}, orphanRecord);
test('confirmed orphan deletion calls Core without a package card', orphanRemoved.payload_id === 'payload.orphan'
  && calls.at(-1).payloadId === 'payload.orphan' && calls.at(-1).input.detach.length === 1);

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
