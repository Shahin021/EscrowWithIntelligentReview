/**
 * Unavailable-evidence recovery and the refund that follows, as steps.
 *
 * Mirrors recover_unavailable_evidence, _queue_refund_for_failed_milestone,
 * confirm_outflow and close_project in contracts/project_escrow.py:
 *
 *   1. eligible       chain time >= get_milestone_evidence_recovery_deadline,
 *                     milestone EVIDENCE_UNAVAILABLE / UNDER_REVIEW /
 *                     REVIEW_STALLED, no open appeal. Anyone may call.
 *   2. recovered      milestone REFUND_PENDING; a refund outflow to the
 *                     client is QUEUED or EMITTED. The refund is NOT paid yet.
 *   3. refund settled outflow CONFIRMED and milestone REFUNDED.
 *   4. closed         project CLOSED (close_project, when ledger is idle).
 *
 * A passed deadline only makes recovery possible. Nothing here reports a
 * refund as paid until the contract shows the outflow CONFIRMED and the
 * milestone REFUNDED, and the outflow itself is the expected refund
 * (recipient = client, refund kind, this milestone, expected amount).
 *
 * EMITTED is not "transferred". On Bradbury the native transfer can land
 * after the emitting transaction is final (observed in the live run), and
 * confirm_outflow requires the contract's native balance to equal the ledger
 * without the in-flight amount. Confirmation is offered only when a fresh
 * balance read shows exactly that; balance == ledger + amount means the
 * transfer has not landed yet, and an unreadable balance enables nothing.
 */

export const REFUND_KINDS = new Set(["MILESTONE_REFUND", "PROJECT_REMAINDER_REFUND"]);
const INCIDENT_STATUSES = new Set(["EVIDENCE_UNAVAILABLE", "UNDER_REVIEW", "REVIEW_STALLED"]);

const lower = (value) => String(value || "").toLowerCase();

const big = (value) => {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return null;
  }
};

/**
 * What confirm_outflow expects the native balance to be once the in-flight
 * transfer has left: every ledger bucket except inflight_out.
 */
export function ledgerExpectedAfter(project) {
  const parts = [
    project.locked,
    project.depositCreditHeld,
    project.appealCreditHeld,
    project.appealBondHeld,
    project.queuedOut,
    project.bouncedHeld,
    project.unmatchedHeld,
  ].map(big);

  return parts.some((p) => p === null) ? null : parts.reduce((a, b) => a + b, 0n);
}

/** Read the contract's native balance. Returns { wei } or { error }. */
export async function readContractBalance(readClient, address, { now = () => Date.now() } = {}) {
  try {
    const wei = await readClient.getBalance({ address });

    return { wei: BigInt(wei), readAt: now() };
  } catch (error) {
    return { wei: null, error: String(error?.shortMessage || error?.message || error).slice(0, 160), readAt: now() };
  }
}

/**
 * Is this refund outflow the one recovery should have produced?
 * Returns a list of problems (empty = as expected).
 */
export function validateRefund(outflow, { milestone, project }) {
  const problems = [];

  if (!REFUND_KINDS.has(outflow.kind)) problems.push(`kind ${outflow.kind} is not a refund`);
  if (lower(outflow.recipient) !== lower(project.client)) problems.push(`recipient ${outflow.recipient} is not the client`);
  if (Number(outflow.milestone) !== Number(milestone.index)) problems.push(`it belongs to milestone ${Number(outflow.milestone) + 1}`);

  const amount = big(outflow.amount);
  const principal = big(milestone.amount);

  if (amount === null || amount <= 0n) problems.push("amount is not a positive number");
  else if (outflow.kind === "MILESTONE_REFUND" && amount !== principal) {
    problems.push(`amount ${amount} is not this milestone's principal ${principal}`);
  } else if (outflow.kind === "PROJECT_REMAINDER_REFUND") {
    if (amount < principal) problems.push(`amount ${amount} is below this milestone's principal ${principal}`);

    const funded = big(project.totalFunded);
    const released = big(project.totalReleased);
    const refunded = big(project.totalRefunded);

    if (funded !== null && released !== null && refunded !== null) {
      // Before confirmation the refund is not yet counted in total_refunded.
      const ceiling = outflow.status === "CONFIRMED" ? refunded : funded - released - refunded;

      if (amount > ceiling) problems.push(`amount ${amount} exceeds what the ledger allows (${ceiling})`);
    }
  }

  return problems;
}

/**
 * May confirm_outflow be offered for this EMITTED outflow right now?
 * { ready, state: "ready" | "waiting" | "blocked", detail }
 */
export function confirmReadiness(outflow, { project, balance }) {
  if (!outflow || outflow.status !== "EMITTED") {
    return { ready: false, state: "blocked", detail: "Only an EMITTED transfer can be confirmed." };
  }

  const amount = big(outflow.amount);
  const inflight = big(project.inflightOut);

  if (inflight !== amount) {
    return { ready: false, state: "blocked", detail: `The ledger's in-flight amount (${project.inflightOut}) does not match this transfer (${outflow.amount}).` };
  }

  const expected = ledgerExpectedAfter(project);

  if (expected === null) return { ready: false, state: "blocked", detail: "The project's ledger could not be read completely." };

  if (!balance || balance.wei === null || balance.wei === undefined) {
    return {
      ready: false,
      state: "waiting",
      detail: `The contract's native balance could not be read${balance?.error ? ` (${balance.error})` : ""}, so it is unknown whether the transfer has landed. Confirmation stays disabled.`,
    };
  }

  if (balance.wei === expected + amount) {
    return {
      ready: false,
      state: "waiting",
      detail: `The transfer has not landed yet: the contract still holds ${balance.wei} wei (ledger ${expected} + in flight ${amount}). Check again shortly.`,
    };
  }

  if (balance.wei === expected) {
    return { ready: true, state: "ready", detail: `The contract balance (${balance.wei} wei) shows the ${amount} wei transfer has left; confirming records it.` };
  }

  return {
    ready: false,
    state: "blocked",
    detail: `The contract balance ${balance.wei} wei matches neither the ledger after the transfer (${expected}) nor before it (${expected + amount}); the contract would reject confirmation.`,
  };
}

/** Chain time: the timestamp of the latest Bradbury block. */
export async function readChainTime(readClient) {
  const block = await readClient.getBlock({ blockTag: "latest" });

  return { seconds: Number(block.timestamp), block: block.number?.toString?.() ?? null };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];

  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);

  return parts.join(" ");
}

/**
 * @param milestone  one controller milestone (status, appealOpen, evidenceRecoveryDeadline, index)
 * @param project    controller project (status, client, locked, …)
 * @param outflows   raw outflow rows (id, kind, status, amount, recipient, milestone)
 * @param chainTime  seconds from readChainTime, or null if unknown
 */
export function recoveryPlan({ milestone, project, outflows, chainTime, activeIndex, balance = null }) {
  if (!milestone || !project) return null;

  const deadline = Number(milestone.evidenceRecoveryDeadline || 0);
  const refunds = outflows.filter((o) => o.milestone === milestone.index && REFUND_KINDS.has(o.kind));
  const refund = refunds[refunds.length - 1] || null;
  const toClient = refund ? lower(refund.recipient) === lower(project.client) : false;

  const steps = [];
  const step = (key, label, state, detail = "") => steps.push({ key, label, state, detail });

  // 4 states per step: done | ready | waiting | blocked
  const incident = INCIDENT_STATUSES.has(milestone.status) && milestone.index === activeIndex;
  const recovered = Boolean(refund) || milestone.status === "REFUND_PENDING" || milestone.status === "REFUNDED";

  if (!incident && !recovered) return null; // no unavailable-evidence incident on this milestone

  let next = null;

  if (recovered) {
    step("recover", "Recovery recorded", "done", refund ? `Refund transfer #${refund.id} created for the client.` : "");
  } else if (milestone.appealOpen) {
    step("recover", "Recover principal", "blocked", "An appeal is open; it must be finalized through finalize_rejection.");
  } else if (deadline === 0) {
    step("recover", "Recover principal", "blocked", "No recovery deadline is set: no unavailable-evidence result has been recorded.");
  } else if (chainTime === null || chainTime === undefined) {
    step("recover", "Recover principal", "waiting", "Chain time unavailable; eligibility cannot be shown yet.");
  } else if (chainTime < deadline) {
    step("recover", "Recover principal", "waiting", `Opens in ${formatDuration(deadline - chainTime)} (chain time).`);
  } else {
    step("recover", "Recover principal", "ready", "The recovery window has passed. Anyone may submit it.");
    next = "recover_unavailable_evidence";
  }

  const refundProblems = refund ? validateRefund(refund, { milestone, project }) : [];
  const settled = Boolean(refund) && refundProblems.length === 0 && refund.status === "CONFIRMED" && milestone.status === "REFUNDED";
  let readiness = null;

  if (refund && refundProblems.length) {
    step("settle", "Refund does not match", "blocked", `Transfer #${refund.id}: ${refundProblems.join("; ")}. It is not shown as a settled refund.`);
  } else if (settled) {
    step("settle", "Refund settled", "done", `${refund.amount} wei to the client, CONFIRMED by the contract; milestone REFUNDED.`);
  } else if (refund && refund.status === "CONFIRMED") {
    step("settle", "Refund settlement", "blocked", `Transfer #${refund.id} is CONFIRMED but the milestone is ${milestone.status}, not REFUNDED.`);
  } else if (refund && refund.status === "EMITTED") {
    readiness = confirmReadiness(refund, { project, balance });
    step("settle", "Confirm the refund transfer", readiness.state, readiness.detail);
    if (readiness.ready) next = next || "confirm_outflow";
  } else if (refund && refund.status === "QUEUED") {
    step("settle", "Emit the queued refund", "ready", `Transfer #${refund.id} is queued behind another transfer.`);
    next = next || "emit_next_outflow";
  } else if (refund && refund.status === "BOUNCED") {
    step("settle", "Refund bounced", "blocked", "Only the client can redirect a bounced refund.");
  } else {
    step("settle", "Refund settlement", "waiting", "After recovery, the refund transfer must be confirmed.");
  }

  if (project.status === "CLOSED") step("close", "Project closed", "done");
  else if (settled && project.canClose) {
    step("close", "Close the project", "ready", "The ledger is idle.");
    next = next || "close_project";
  } else step("close", "Close the project", "waiting", "Possible once nothing is locked, queued or in flight.");

  return {
    deadline,
    chainTime,
    eligible: steps[0].state === "ready",
    refund,
    refundToClient: toClient,
    refundProblems,
    readiness,
    balance,
    settled,
    steps,
    next,
    outflowId: refund ? refund.id : null,
  };
}
