/**
 * Which finalized transaction caused an outcome — or an honest "unknown".
 *
 * An outcome event (from two FINALIZED snapshots: baseline B0 without the
 * outcome, B1 with it) may cite a transaction only if ALL of these hold:
 *
 *   method/args  the transaction's decoded call is the one that produces
 *                this transition (resolve(m) for a review verdict,
 *                confirm_outflow(id) for a completed payment or refund,
 *                activate_funding() / close_project() for the project);
 *   success      FINALIZED with FINISHED_WITH_RETURN and AGREE/MAJORITY_AGREE;
 *   ordering     included in an EVM block at or before B1, and NOT already
 *                observed final at or before B0 (its effect would then be in
 *                the baseline state);
 *   attempt      for review verdicts: included after the latest finalized
 *                submission/replacement/appeal for that milestone (the anchor
 *                of the attempt being judged). Without a known anchor no
 *                review transaction can be tied to this attempt;
 *   exclusivity  not already cited by an event of a different snapshot.
 *
 * confirm_outflow(id), activate_funding() and close_project() succeed at
 * most once per id/project, so method + args alone identify them. If no
 * transaction qualifies, the event waits; after the configured wait it is
 * reported as finalized contract state WITHOUT naming any transaction.
 */

import { abi } from "genlayer-js";
import { fromRlp, hexToBytes } from "viem";

const lower = (v) => String(v ?? "").toLowerCase();

/** Decode a GenLayer call's txData (RLP [calldata, leaderOnly]) into { method, args }. */
export function decodeTxData(txData) {
  if (typeof txData !== "string" || !txData.startsWith("0x")) return null;

  try {
    const items = fromRlp(txData, "hex");

    if (!Array.isArray(items) || items.length !== 2 || Array.isArray(items[0])) return null;

    const decoded = abi.calldata.decode(hexToBytes(items[0]));
    const get = (k) => (decoded instanceof Map ? decoded.get(k) : decoded?.[k]);
    const method = get("method");

    if (typeof method !== "string") return null;

    const args = (get("args") || []).map((a) => (typeof a === "bigint" ? Number(a) : a));

    return { method, args };
  } catch {
    return null;
  }
}

const REVIEW_ANCHORS = ["submit_deliverable", "replace_evidence", "appeal"];

/** The call(s) that produce an event's transition, or null if none is attributable. */
export function expectationFor(event) {
  const p = event.payload || {};

  switch (event.kind) {
    case "review_approved":
    case "revision_required":
    case "evidence_unavailable":
      return { methods: ["resolve"], args: [p.milestone], anchor: { methods: REVIEW_ANCHORS, milestone: p.milestone } };
    case "review_rejected":
      return { methods: ["resolve", "abort_failed_appeal"], args: [p.milestone], anchor: { methods: REVIEW_ANCHORS, milestone: p.milestone } };
    case "payment_completed":
    case "refund_completed":
      return p.outflow ? { methods: ["confirm_outflow"], args: [p.outflow.id], anchor: null } : null;
    case "project_active":
      return { methods: ["activate_funding"], args: [], anchor: null };
    case "project_closed":
      return { methods: ["close_project"], args: [], anchor: null };
    default:
      return null;
  }
}

const argsMatch = (expected, actual) =>
  expected.length === (actual || []).length && expected.every((v, i) => lower(v) === lower(actual[i]));

/**
 * @param event   { kind, payload, batch (B1), baseline (B0) }
 * @param txs     known escrow transactions: { tx_id, evm_block, method, args_json, final, ok, first_final_batch, cited_batch }
 * @returns { txId } | { waiting: reason }
 */
export function findCause(event, txs) {
  const spec = expectationFor(event);

  if (!spec) return { waiting: "no transaction type is known to produce this transition" };

  const b1 = BigInt(event.batch);
  const b0 = event.baseline === null || event.baseline === undefined ? null : BigInt(event.baseline);
  const call = (t) => ({ method: t.method, args: t.args_json ? JSON.parse(t.args_json) : null });
  const finalOk = txs.filter((t) => t.final && t.ok && t.method && t.evm_block !== null && t.evm_block !== undefined && BigInt(t.evm_block) <= b1);

  let floor = null;

  if (spec.anchor) {
    const anchors = finalOk.filter((t) => spec.anchor.methods.includes(t.method) && lower(call(t).args?.[0]) === lower(spec.anchor.milestone));

    if (!anchors.length) return { waiting: "the submission that started this review attempt has not been observed" };

    floor = anchors.reduce((max, t) => (BigInt(t.evm_block) > max ? BigInt(t.evm_block) : max), 0n);
  }

  const candidates = finalOk
    .filter((t) => spec.methods.includes(t.method) && argsMatch(spec.args, call(t).args))
    .filter((t) => floor === null || BigInt(t.evm_block) > floor)
    .filter((t) => b0 === null || t.first_final_batch === null || t.first_final_batch === undefined || BigInt(t.first_final_batch) > b0)
    .filter((t) => !t.cited_batch || t.cited_batch === String(event.batch))
    .sort((a, b) => (BigInt(b.evm_block) > BigInt(a.evm_block) ? 1 : -1));

  if (!candidates.length) return { waiting: "no finalized transaction matching this transition has been observed yet" };

  return { txId: candidates[0].tx_id, method: candidates[0].method };
}
