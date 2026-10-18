/**
 * Which technical continuation steps the service may take for one escrow now.
 *
 * Pure: a snapshot of contract state plus the active consents in, a list of
 * exact calls out. Every call's function, arguments, recipient and amount
 * come from contract state; nothing here chooses a verdict, an amount, a
 * recipient, evidence or a project term. Party decisions (funding from a
 * wallet, evidence, revisions, appeals, settlements, redirects, withdrawals)
 * are never planned.
 *
 * Each call has a key derived from the state it continues, so the same step
 * is queued at most once (the database enforces the key as unique).
 */

import { milestonePredicates, projectPredicates } from "../../dapp/src/predicates.js";
import { confirmReadiness, REFUND_KINDS, validateRefund } from "../../dapp/src/workspace/recovery.js";
import { SCOPES } from "./consent.js";

const lower = (v) => String(v || "").toLowerCase();
const big = (v) => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};

/** Normalize the raw reads into the shapes the dapp predicates use. */
export function deriveState(snapshot) {
  const { project: rawProject, milestones: rawMilestones, outflows, chainTime } = snapshot;
  const activeIndex = rawMilestones.findIndex((m) => !["LOCKED", "RELEASED", "REFUNDED", "CANCELLED"].includes(m.status));
  const project = projectPredicates(rawProject, outflows, null);
  const milestones = rawMilestones.map((m) => milestonePredicates(m, chainTime, activeIndex));

  return { project, milestones, outflows, activeIndex };
}

/** An on-chain grant (automation contract only) usable for `amount` at chain time `now`. */
export function grantUsable(grant, amount, now) {
  if (!grant) return false;

  return big(amount) > 0n && big(amount) <= big(grant.max_amount) && now < Number(grant.expires_at || 0);
}

function validatePayout(outflow, { milestone, project }) {
  const problems = [];

  if (outflow.kind !== "MILESTONE_PAYOUT") problems.push("not a payout");
  if (lower(outflow.recipient) !== lower(project.worker)) problems.push("recipient is not the worker");
  if (!milestone || big(outflow.amount) !== big(milestone.amount)) problems.push("amount is not the milestone amount");

  return problems;
}

/**
 * @param snapshot   { project, milestones, outflows, balance:{wei|null}, chainTime, grants:{client,worker}|null }
 * @param consents   active consents for this escrow: [{ id, scopes, maxAmount, role }]
 * @returns [{ key, functionName, args, scope, amount, reason, consentIds }]
 */
export function planActions(snapshot, consents) {
  // Decisions are made only on finalized contract state.
  if (snapshot.finality !== "final") throw new Error("refusing to plan from non-final contract state");

  const { project, milestones, outflows } = deriveState(snapshot);
  const now = snapshot.chainTime;
  const plans = [];

  const covering = (scope, amount) =>
    consents.filter((c) => (c.scopes & scope) !== 0 && big(amount) <= big(c.maxAmount)).map((c) => c.id);

  const add = (scope, amount, plan) => {
    const consentIds = covering(scope, amount);

    if (consentIds.length) plans.push({ ...plan, scope, amount: String(amount), consentIds });
  };

  // ACTIVATE (client, on-chain grant): continue a deposit the client already made.
  if (
    project.status === "AWAITING_DEPOSIT" &&
    big(project.depositCreditHeld) === big(project.totalRequired) &&
    big(project.totalRequired) > 0n &&
    grantUsable(snapshot.grants?.client, project.totalRequired, now)
  ) {
    add(SCOPES.ACTIVATE, project.totalRequired, {
      key: `activate_funding:${project.totalRequired}`,
      functionName: "activate_funding",
      args: [],
      reason: "The client's deposit equals the required total; activation continues it.",
    });
  }

  for (const m of milestones) {
    if (!m.isActive) continue;

    // REVIEW: run the consensus review of evidence already submitted.
    if (m.status === "UNDER_REVIEW") {
      add(SCOPES.REVIEW, 0n, {
        key: `resolve:${m.index}:${m.attemptCount}`,
        functionName: "resolve",
        args: [m.index],
        reason: "Evidence was submitted and awaits the consensus review.",
      });
    }

    // SETTLE (worker, on-chain grant): claim an approved milestone to the worker.
    if (m.status === "APPROVED" && grantUsable(snapshot.grants?.worker, m.amount, now)) {
      add(SCOPES.SETTLE, m.amount, {
        key: `claim_payment:${m.index}`,
        functionName: "claim_payment",
        args: [m.index],
        reason: "The milestone is approved; the payout goes to the worker.",
      });
    }

    // RECOVER: deadline-driven, permissionless steps; any refund goes to the client.
    if (m.stallable) {
      add(SCOPES.RECOVER, m.amount, {
        key: `mark_review_stalled:${m.index}:${m.attemptCount}`,
        functionName: "mark_review_stalled",
        args: [m.index],
        reason: "The review passed its stall deadline.",
      });
    }

    if (m.evidenceRecoverable) {
      add(SCOPES.RECOVER, m.amount, {
        key: `recover_unavailable_evidence:${m.index}:${m.evidenceRecoveryDeadline}`,
        functionName: "recover_unavailable_evidence",
        args: [m.index],
        reason: "The evidence-recovery deadline passed; principal returns to the client.",
      });
    }

    if (m.expirable) {
      add(SCOPES.RECOVER, m.amount, {
        key: `expire_delivery:${m.index}:${m.deliveryDeadline}`,
        functionName: "expire_delivery",
        args: [m.index],
        reason: "The delivery deadline passed without evidence; principal returns to the client.",
      });
    }

    if (m.finalizable && !m.appealOpen) {
      add(SCOPES.RECOVER, m.amount, {
        key: `finalize_rejection:${m.index}`,
        functionName: "finalize_rejection",
        args: [m.index],
        reason: "The rejection is final and the appeal window has closed; principal returns to the client.",
      });
    }
  }

  // Transfers: emit the queue head, confirm an emitted transfer once its native
  // transfer has landed. Scope follows the transfer's kind.
  const scopeFor = (o) => (o.kind === "MILESTONE_PAYOUT" ? SCOPES.SETTLE : REFUND_KINDS.has(o.kind) ? SCOPES.RECOVER : 0);
  const milestoneOf = (o) => milestones.find((m) => m.index === o.milestone) || null;
  const valid = (o) =>
    o.kind === "MILESTONE_PAYOUT"
      ? validatePayout(o, { milestone: milestoneOf(o), project }).length === 0
      : REFUND_KINDS.has(o.kind) && milestoneOf(o)
        ? validateRefund(o, { milestone: milestoneOf(o), project }).length === 0
        : false;

  const emitted = outflows.filter((o) => o.status === "EMITTED");
  const head = outflows.filter((o) => o.status === "QUEUED").sort((a, b) => a.id - b.id)[0];

  if (!emitted.length && head && scopeFor(head) && valid(head)) {
    add(scopeFor(head), head.amount, {
      key: `emit_next_outflow:${head.id}`,
      functionName: "emit_next_outflow",
      args: [],
      reason: `Transfer #${head.id} is queued and nothing is in flight.`,
    });
  }

  for (const o of emitted) {
    if (!scopeFor(o) || !valid(o)) continue;

    const readiness = confirmReadiness(o, { project, balance: snapshot.balance });

    if (readiness.ready) {
      add(scopeFor(o), o.amount, {
        key: `confirm_outflow:${o.id}`,
        functionName: "confirm_outflow",
        args: [o.id],
        reason: readiness.detail,
      });
    }
  }

  // Close the project once the contract's own closing conditions hold on
  // finalized state: SETTLING, nothing locked, queued, in flight, bounced or
  // held as credit or bond, every milestone terminal, no transfer open.
  const terminal = new Set(["RELEASED", "REFUNDED", "CANCELLED"]);
  const zero = (v) => big(v) === 0n;

  if (
    project.status === "SETTLING" &&
    [project.locked, project.queuedOut, project.inflightOut, project.bouncedHeld, project.appealBondHeld, project.appealCreditHeld, project.depositCreditHeld].every(zero) &&
    milestones.length > 0 &&
    milestones.every((m) => terminal.has(m.status)) &&
    outflows.every((o) => o.status === "CONFIRMED")
  ) {
    const consentIds = consents.filter((c) => (c.scopes & (SCOPES.SETTLE | SCOPES.RECOVER)) !== 0).map((c) => c.id);

    if (consentIds.length) {
      plans.push({
        key: "close_project",
        functionName: "close_project",
        args: [],
        scope: SCOPES.SETTLE | SCOPES.RECOVER,
        amount: "0",
        reason: "Every milestone is settled and nothing is left in flight; closing records the project as finished.",
        consentIds,
      });
    }
  }

  return plans;
}

/** What the planner is waiting for, with the time it expects (chain seconds). */
export function nextExpected(snapshot) {
  const { milestones } = deriveState(snapshot);
  const out = [];

  for (const m of milestones) {
    if (!m.isActive) continue;
    const at = (name, value) => Number(value) > snapshot.chainTime && out.push({ milestone: m.index, event: name, at: Number(value) });

    if (m.status === "AWAITING_DELIVERY") at("delivery deadline", m.deliveryDeadline);
    if (m.status === "UNDER_REVIEW") at("review stall deadline", m.stallEligibleAt);
    if (["EVIDENCE_UNAVAILABLE", "UNDER_REVIEW", "REVIEW_STALLED"].includes(m.status)) at("evidence recovery opens", m.evidenceRecoveryDeadline);
    if (m.status === "REJECTED_FINAL") at("appeal window closes", m.appealExpiry);
  }

  return out.sort((a, b) => a.at - b.at);
}
