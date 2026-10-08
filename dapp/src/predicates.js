/**
 * Timing and ledger predicates, derived only from contract-provided values.
 *
 * The contract exposes each deadline as an absolute epoch second, with "0"
 * meaning not applicable, so the UI never recomputes a deadline itself; it
 * only compares those values with the current chain time.
 *
 * Boundary rules follow the contract: a deadline action is allowed when
 * now >= deadline, and a window action is allowed while now < expiry.
 */

const num = (value) => Number(value || 0);

export function isReached(deadline, now) {
  const at = num(deadline);

  return at !== 0 && now >= at;
}

export function withinWindow(expiry, now) {
  const at = num(expiry);

  return at !== 0 && now < at;
}

export function milestonePredicates(milestone, now, activeIndex) {
  const isActive = milestone.index === activeIndex;
  const status = milestone.status;

  return {
    ...milestone,
    isActive,
    expirable:
      isActive &&
      status === "AWAITING_DELIVERY" &&
      isReached(milestone.deliveryDeadline, now),
    stallable:
      isActive &&
      (status === "UNDER_REVIEW" || status === "UNDER_APPEAL") &&
      isReached(milestone.stallEligibleAt, now),
    appealable:
      isActive &&
      status === "REJECTED_FINAL" &&
      !milestone.appealUsed &&
      withinWindow(milestone.appealExpiry, now),
    appealAbortable:
      isActive &&
      milestone.appealOpen &&
      isReached(milestone.appealFailureThreshold, now),
    finalizable:
      isActive &&
      status === "REJECTED_FINAL" &&
      (milestone.appealUsed || isReached(milestone.appealExpiry, now)),
  };
}

/** Outflows the connected account may act on. */
export function outflowActions(outflows, account) {
  const lower = (value) => String(value || "").toLowerCase();
  const me = lower(account);

  return outflows
    .map((outflow) => ({
      ...outflow,
      confirmable: outflow.status === "EMITTED",
      // Only the recipient owns a bounced transfer, matching the contract's
      // redirect authorization.
      redirectable: outflow.status === "BOUNCED" && lower(outflow.recipient) === me,
      redirectBlockedReason:
        outflow.status === "BOUNCED" && lower(outflow.recipient) !== me
          ? "Only the recipient of this transfer can redirect it."
          : null,
    }))
    .filter((outflow) => outflow.confirmable || outflow.status === "BOUNCED" || outflow.status === "QUEUED");
}

/** Project-level flags that availableActions() depends on. */
export function projectPredicates(project, outflows, account) {
  const zero = (value) => !value || value === "0";

  const ledgerIdle =
    zero(project.queuedOut) &&
    zero(project.inflightOut) &&
    zero(project.bouncedHeld) &&
    zero(project.appealBondHeld);

  return {
    ...project,
    account,
    hasConfirmableOutflow: outflows.some((o) => o.status === "EMITTED"),
    hasQueuedOutflow: outflows.some((o) => o.status === "QUEUED"),
    canPropose:
      project.status === "ACTIVE" && ledgerIdle && !zero(project.locked),
    canClose:
      project.status === "SETTLING" &&
      zero(project.locked) &&
      ledgerIdle &&
      zero(project.appealCreditHeld),
  };
}
