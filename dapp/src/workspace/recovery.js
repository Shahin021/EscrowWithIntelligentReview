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
 * milestone REFUNDED.
 */

export const REFUND_KINDS = new Set(["MILESTONE_REFUND", "PROJECT_REMAINDER_REFUND"]);
const INCIDENT_STATUSES = new Set(["EVIDENCE_UNAVAILABLE", "UNDER_REVIEW", "REVIEW_STALLED"]);

const lower = (value) => String(value || "").toLowerCase();

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
export function recoveryPlan({ milestone, project, outflows, chainTime, activeIndex }) {
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

  const settled = refund && refund.status === "CONFIRMED" && milestone.status === "REFUNDED";

  if (settled) {
    step("settle", "Refund settled", "done", `${refund.amount} wei confirmed to the client.`);
  } else if (refund && refund.status === "EMITTED") {
    step("settle", "Confirm the refund transfer", "ready", `Transfer #${refund.id} was emitted; confirming records it.`);
    next = next || "confirm_outflow";
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
    settled: Boolean(settled),
    steps,
    next,
    outflowId: refund ? refund.id : null,
  };
}
