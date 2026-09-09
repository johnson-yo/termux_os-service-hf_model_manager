/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Manager model-package card and Framework Core's v2 delete-impact/delete seams.
 * [OUTPUT]: Short-lived confirmation plans and explicit, CAS-aware payload deletion.
 * [POS]: hf-model-manager/service/delete.mjs.
 * [PROTOCOL]: Warning, consumer presentation, and confirmation are Manager policy; Core only
 *             enforces exact Selection detach sets, payload integrity, and ledger generations.
 */

import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_TTL_MS = 2 * 60_000;

const operationError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const responseFailure = (result, fallback) => {
  if (result?.ok) return null;
  const data = result?.data ?? {};
  return operationError(data.error ?? (result?.status === 409 ? 'conflict' : 'request_failed'),
    data.detail || data.error || fallback, { status: result?.status ?? null, response: result });
};

const stableJson = (value) => JSON.stringify(value, (key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]));
});

const digest = (value) => crypto.createHash('sha256').update(stableJson(value)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const unique = (values) => [...new Set(values.filter(Boolean))];

const assetPackageKey = (card) => card?.key ?? card?.package_key ?? null;

const v2PayloadEntries = (card) => {
  const assets = (card?.assets ?? []).filter((asset) => asset?.payload_id);
  const byPayload = new Map();
  for (const asset of assets) {
    const id = String(asset.payload_id);
    if (!byPayload.has(id)) byPayload.set(id, { payload_id: id, assets: [] });
    byPayload.get(id).assets.push({ id: asset.id, target: asset.target ?? 'generic', path: asset.path ?? null });
  }
  return [...byPayload.values()];
};

const legacyPayloadEntries = (card) => {
  const byPath = new Map();
  for (const asset of card?.assets ?? []) {
    if (!asset?.path) continue;
    const pathKey = path.resolve(asset.path);
    const key = [asset.package_id, asset.version, asset.target, pathKey].join('|');
    if (!byPath.has(key)) byPath.set(key, {
      payload_id: null,
      package_id: asset.package_id ?? card.package_id ?? null,
      version: asset.version ?? card.package_version ?? null,
      target: asset.target ?? 'generic',
      storage_path: pathKey,
      assets: [],
    });
    byPath.get(key).assets.push({ id: asset.id, target: asset.target ?? 'generic', path: pathKey });
  }
  return [...byPath.values()];
};

const runtimeObservation = (entry, card) => {
  const facts = entry.assets.map((item) => (card.assets ?? []).find((asset) => asset.id === item.id)).filter(Boolean);
  return {
    loaded: facts.some((asset) => asset.runtime_state === 'loaded' || asset.loaded === true),
    assets: facts.map((asset) => ({ id: asset.id, state: asset.runtime_state ?? asset.provider_state ?? null })),
  };
};

/**
 * The coordinator intentionally owns no durable state. A confirmation is a user
 * decision about one observed impact set, not a resumable Core operation.
 */
export const createDeleteCoordinator = ({ local, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, tokenFactory = token } = {}) => {
  if (!local) throw new Error('delete coordinator requires a Framework adapter');
  const confirmations = new Map();

  const prune = () => {
    const current = now();
    for (const [key, value] of confirmations) if (value.expires_at_ms <= current) confirmations.delete(key);
  };

  const inspect = async (card) => {
    prune();
    const packageKey = assetPackageKey(card);
    if (!packageKey) throw operationError('package_key_required', 'a package key is required');
    const v2 = v2PayloadEntries(card);
    const entries = v2.length ? v2 : legacyPayloadEntries(card);
    if (!entries.length) throw operationError('payload_not_found', `no installed payload belongs to ${packageKey}`);

    const generation = [...new Set((card.assets ?? []).map((asset) => Number(asset.ledger_generation)).filter(Number.isSafeInteger))][0] ?? null;
    const impacts = [];
    for (const entry of entries) {
      let impact = {
        schema: 'termux-os.asset-delete-impact.v2',
        payload_id: entry.payload_id,
        exists: true,
        state: 'ready',
        layout: 'legacy',
        storage_path: entry.storage_path,
        selected_by: [],
        declarations: [],
        consumers: [],
        runtime: runtimeObservation(entry, card),
        can_delete: true,
      };
      if (entry.payload_id && typeof local.deleteImpactV2 === 'function') {
        const result = await local.deleteImpactV2(entry.payload_id);
        const failure = responseFailure(result, `delete impact failed for ${entry.payload_id}`);
        if (failure) throw failure;
        impact = result.data?.impact ?? result.data ?? impact;
      }
      // Core reports technical references. The Manager adds its own consumer
      // declaration and runtime observations for a useful user warning, never
      // as an allow/deny input to Core.
      impact = {
        ...impact,
        consumers: unique([
          ...(Array.isArray(impact.consumers) ? impact.consumers : []),
          ...((card.usage?.consumers ?? []).map((consumer) => stableJson(consumer))),
        ]).map((item) => {
          try { return JSON.parse(item); } catch { return item; }
        }),
        manager_assets: entry.assets,
        manager_runtime: runtimeObservation(entry, card),
      };
      impacts.push(impact);
    }

    const detachSelections = unique(impacts.flatMap((impact) => (impact.selected_by ?? []).map((selection) => selection.key)));
    const material = {
      package_key: packageKey,
      generation,
      payloads: impacts.map((impact) => ({
        payload_id: impact.payload_id,
        state: impact.state,
        selected_by: impact.selected_by ?? [],
        storage_path: impact.storage_path ?? null,
      })),
      detach_selections: detachSelections,
    };
    const confirmationToken = tokenFactory();
    const createdAt = now();
    const record = {
      token: confirmationToken,
      package_key: packageKey,
      created_at_ms: createdAt,
      expires_at_ms: createdAt + ttlMs,
      generation,
      impact_digest: digest(material),
      payloads: impacts.map((impact) => ({
        payload_id: impact.payload_id,
        detach: (impact.selected_by ?? []).map((selection) => selection.key),
      })).filter((item) => item.payload_id && impacts.find((impact) => impact.payload_id === item.payload_id)?.exists !== false),
      legacy: entries.filter((entry) => !entry.payload_id),
    };
    confirmations.set(confirmationToken, record);
    return {
      schema: 'termux-os.asset-delete-plan.v2',
      package_key: packageKey,
      requires_confirmation: true,
      confirmation_token: confirmationToken,
      created_at_ms: createdAt,
      expires_at_ms: record.expires_at_ms,
      ledger_generation: generation,
      impact_digest: record.impact_digest,
      detach_selections: detachSelections,
      impacts,
      warning: {
        code: 'payload_delete_is_irreversible_for_current_bytes',
        text: 'This removes the selected Payload bytes. Asset Declarations remain registered; a later Manager transfer may restore them.',
      },
    };
  };

  /**
   * Orphans have no catalog card, but they remain first-class Core facts. Keep
   * the same warning/confirmation boundary for a direct Payload operation so
   * uninstalling an Asset Package never turns its bytes into Manager-owned
   * garbage that cannot be inspected or removed.
   */
  const inspectPayload = async (payloadId) => {
    prune();
    const id = String(payloadId ?? '').trim();
    if (!id) throw operationError('payload_id_required', 'a payload id is required');
    if (typeof local.deleteImpactV2 !== 'function') {
      throw operationError('payload_delete_unavailable', 'Framework Payload delete impact API is unavailable');
    }
    const result = await local.deleteImpactV2(id);
    const failure = responseFailure(result, `delete impact failed for ${id}`);
    if (failure) throw failure;
    const impact = result.data?.impact ?? result.data ?? {};
    if (impact.exists !== true) throw operationError('payload_not_found', `no Payload exists for ${id}`);
    const generation = Number.isSafeInteger(impact.ledger_generation) ? impact.ledger_generation : null;
    const detach = (impact.selected_by ?? []).map((selection) => selection.key).filter(Boolean);
    const material = {
      payload_id: id,
      generation,
      state: impact.state ?? null,
      selected_by: impact.selected_by ?? [],
      storage_path: impact.storage_path ?? null,
    };
    const confirmationToken = tokenFactory();
    const createdAt = now();
    const record = {
      kind: 'payload', token: confirmationToken, package_key: `payload:${id}`,
      payload_id: id, created_at_ms: createdAt, expires_at_ms: createdAt + ttlMs,
      generation, impact_digest: digest(material), detach, impact,
    };
    confirmations.set(confirmationToken, record);
    return {
      schema: 'termux-os.asset-payload-delete-plan.v2',
      payload_id: id,
      requires_confirmation: true,
      confirmation_token: confirmationToken,
      created_at_ms: createdAt,
      expires_at_ms: record.expires_at_ms,
      ledger_generation: generation,
      impact_digest: record.impact_digest,
      detach_selections: detach,
      impact,
      warning: {
        code: 'payload_delete_is_irreversible_for_current_bytes',
        text: 'This removes the Payload bytes. Asset Declarations remain registered when present; a later Manager transfer may restore them.',
      },
    };
  };

  const take = (packageKey, confirmationToken) => {
    prune();
    const record = confirmations.get(confirmationToken);
    if (!record) throw operationError('confirmation_invalid', 'confirmation token is missing, expired, or already used');
    if (record.package_key !== packageKey) throw operationError('confirmation_package_mismatch', 'confirmation token belongs to another package');
    confirmations.delete(confirmationToken);
    return record;
  };

  const takePayload = (payloadId, confirmationToken) => {
    const record = take(`payload:${String(payloadId ?? '').trim()}`, confirmationToken);
    if (record.kind !== 'payload' || record.payload_id !== String(payloadId ?? '').trim()) {
      throw operationError('confirmation_payload_mismatch', 'confirmation token belongs to another Payload');
    }
    return record;
  };

  const remove = async (card, setStage = () => {}, record) => {
    if (!record) throw operationError('confirmation_required', 'a delete confirmation is required');
    setStage('deleting');
    const removed = [];
    let expectedGeneration = record.generation;
    for (const item of record.payloads) {
      if (!item.payload_id) continue;
      const result = await local.deletePayloadV2(item.payload_id, {
        expectedGeneration,
        detach: item.detach,
      });
      const failure = responseFailure(result, `raw delete failed for ${item.payload_id}`);
      if (failure) throw failure;
      const data = result.data ?? {};
      removed.push(data);
      if (Number.isSafeInteger(data.ledger_generation)) expectedGeneration = data.ledger_generation;
    }
    for (const entry of record.legacy) {
      const asset = entry.assets[0];
      if (!asset?.id || typeof local.purgePayload !== 'function') continue;
      const result = await local.purgePayload(asset.id, {
        package_id: entry.package_id, version: entry.version, target: entry.target, path: entry.storage_path,
      });
      const failure = responseFailure(result, `legacy delete failed for ${asset.id}`);
      if (failure) throw failure;
      removed.push(result.data);
    }
    return { package_key: assetPackageKey(card), removed, ledger_generation: expectedGeneration };
  };

  const removePayload = async (setStage = () => {}, record) => {
    if (!record || record.kind !== 'payload') throw operationError('confirmation_required', 'a Payload delete confirmation is required');
    setStage('deleting');
    const result = await local.deletePayloadV2(record.payload_id, {
      expectedGeneration: record.generation,
      detach: record.detach,
    });
    const failure = responseFailure(result, `raw delete failed for ${record.payload_id}`);
    if (failure) throw failure;
    const data = result.data ?? {};
    return {
      payload_id: record.payload_id,
      removed: data,
      ledger_generation: Number.isSafeInteger(data.ledger_generation) ? data.ledger_generation : record.generation,
    };
  };

  return { inspect, inspectPayload, take, takePayload, remove, removePayload, prune, size: () => confirmations.size };
};

export const __test = { stableJson, digest, v2PayloadEntries, legacyPayloadEntries };
