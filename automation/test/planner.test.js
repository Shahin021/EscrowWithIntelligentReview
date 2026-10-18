import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planActions } from "../src/planner.js";
import { SCOPES } from "../src/consent.js";
import { CLIENT, NOW, WORKER, milestone, snapshot } from "./helpers.js";

const all = (scopes, maxAmount = "1000000") => [{ id: 1, scopes, maxAmount }];
const keys = (plans) => plans.map((p) => p.key);
const grant = (max = "5000", expires = NOW + 3600) => ({ max_amount: max, expires_at: String(expires), scope: "1", version: "1" });

describe("planner: only permitted continuation steps, derived from contract state", () => {
  it("plans nothing without consent", () => {
    const s = snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 1 }), milestone(1)] });
    assert.deepEqual(planActions(s, []), []);
  });

  it("review: resolve once per attempt", () => {
    const s = snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 2 }), milestone(1)] });
    const plans = planActions(s, all(SCOPES.REVIEW));
    assert.deepEqual(keys(plans), ["resolve:0:2"]);
    assert.deepEqual(plans[0].args, [0]);
    assert.deepEqual(planActions(s, all(SCOPES.RECOVER)), []);
  });

  it("claim needs the worker's on-chain grant; an old contract (no grants) keeps it manual", () => {
    const s = snapshot({ milestones: [milestone(0, { status: "APPROVED" }), milestone(1)] });
    assert.deepEqual(planActions(s, all(SCOPES.SETTLE)), []);
    assert.deepEqual(keys(planActions({ ...s, grants: { client: null, worker: grant() } }, all(SCOPES.SETTLE))), ["claim_payment:0"]);
    assert.deepEqual(planActions({ ...s, grants: { worker: grant("999") } }, all(SCOPES.SETTLE)), [], "grant ceiling below the amount");
    assert.deepEqual(planActions({ ...s, grants: { worker: grant("5000", NOW) } }, all(SCOPES.SETTLE)), [], "grant expired at chain time");
    assert.deepEqual(planActions({ ...s, grants: { worker: grant() } }, all(SCOPES.SETTLE, "999")), [], "consent ceiling below the amount");
  });

  it("activation continues only an exact deposit the client made, with the client's grant", () => {
    const base = { project: { status: "AWAITING_DEPOSIT", totalFunded: "0", locked: "0", depositCreditHeld: "2000" }, milestones: [milestone(0), milestone(1)] };
    assert.deepEqual(keys(planActions(snapshot({ ...base, grants: { client: grant("2000") } }), all(SCOPES.ACTIVATE))), ["activate_funding:2000"]);
    assert.deepEqual(planActions(snapshot({ ...base, project: { ...base.project, depositCreditHeld: "1999" }, grants: { client: grant("2000") } }), all(SCOPES.ACTIVATE)), []);
    assert.deepEqual(planActions(snapshot({ ...base, grants: null }), all(SCOPES.ACTIVATE)), []);
    assert.deepEqual(planActions(snapshot({ ...base, grants: { client: grant("2000") } }), all(SCOPES.REVIEW | SCOPES.RECOVER)), []);
  });

  it("recovery steps appear only after their deadlines (chain time)", () => {
    const m = milestone(0, { status: "EVIDENCE_UNAVAILABLE", evidenceRecoveryDeadline: String(NOW + 10) });
    assert.deepEqual(planActions(snapshot({ milestones: [m, milestone(1)] }), all(SCOPES.RECOVER)), []);
    assert.deepEqual(keys(planActions(snapshot({ milestones: [m, milestone(1)], chainTime: NOW + 10 }), all(SCOPES.RECOVER))), [`recover_unavailable_evidence:0:${NOW + 10}`]);

    const late = milestone(0, { status: "AWAITING_DELIVERY", deliveryDeadline: String(NOW - 1) });
    assert.deepEqual(keys(planActions(snapshot({ milestones: [late, milestone(1)] }), all(SCOPES.RECOVER))), [`expire_delivery:0:${NOW - 1}`]);

    const rejected = milestone(0, { status: "REJECTED_FINAL", appealExpiry: String(NOW - 1) });
    assert.deepEqual(keys(planActions(snapshot({ milestones: [rejected, milestone(1)] }), all(SCOPES.RECOVER))), ["finalize_rejection:0"]);
    const appealWindow = milestone(0, { status: "REJECTED_FINAL", appealExpiry: String(NOW + 100) });
    assert.deepEqual(planActions(snapshot({ milestones: [appealWindow, milestone(1)] }), all(SCOPES.RECOVER)), [], "the worker may still appeal");
  });

  it("confirms a transfer only when the contract balance shows it left, and only the expected transfer", () => {
    const refund = { id: 0, kind: "MILESTONE_REFUND", status: "EMITTED", amount: "1000", recipient: CLIENT.address, milestone: 0 };
    const state = { project: { locked: "1000", inflightOut: "1000", status: "ACTIVE" }, milestones: [milestone(0, { status: "REFUND_PENDING" }), milestone(1, { status: "LOCKED" })], outflows: [refund] };

    assert.deepEqual(planActions(snapshot({ ...state, balance: { wei: 2000n } }), all(SCOPES.RECOVER)), [], "transfer has not landed");
    assert.deepEqual(planActions(snapshot({ ...state, balance: { wei: null, error: "x" } }), all(SCOPES.RECOVER)), [], "balance unknown");
    assert.deepEqual(keys(planActions(snapshot({ ...state, balance: { wei: 1000n } }), all(SCOPES.RECOVER))), ["confirm_outflow:0"]);
    assert.deepEqual(planActions(snapshot({ ...state, outflows: [{ ...refund, recipient: WORKER.address }], balance: { wei: 1000n } }), all(SCOPES.RECOVER)), [], "wrong recipient");
    assert.deepEqual(planActions(snapshot({ ...state, balance: { wei: 1000n } }), all(SCOPES.SETTLE)), [], "a refund is not a settle step");
  });

  it("emits the queue head only when nothing is in flight", () => {
    const payout = { id: 3, kind: "MILESTONE_PAYOUT", status: "QUEUED", amount: "1000", recipient: WORKER.address, milestone: 0 };
    const s = snapshot({ project: { queuedOut: "1000", locked: "1000" }, milestones: [milestone(0, { status: "PAYMENT_PENDING" }), milestone(1, { status: "AWAITING_DELIVERY" })], outflows: [payout] });
    assert.deepEqual(keys(planActions(s, all(SCOPES.SETTLE))), ["emit_next_outflow:3"]);
    assert.deepEqual(planActions({ ...s, outflows: [{ ...payout, recipient: CLIENT.address }] }, all(SCOPES.SETTLE)), []);
  });

  it("never plans a party decision", () => {
    const s = snapshot({ milestones: [milestone(0, { status: "AWAITING_DELIVERY" }), milestone(1)], project: { status: "ACTIVE" }, grants: { client: grant(), worker: grant() } });
    const fns = planActions(s, all(15)).map((p) => p.functionName);
    for (const decision of ["fund", "submit_deliverable", "replace_evidence", "appeal", "propose_settlement", "accept_settlement", "redirect_outflow", "withdraw_deposit_credit", "withdraw_appeal_credit"]) {
      assert.ok(!fns.includes(decision), decision);
    }
  });
});
