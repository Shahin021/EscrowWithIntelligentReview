/**
 * Which escrow actions a given account may take right now.
 *
 * This mirrors the contract's own guards: the UI must never offer a button
 * that the contract would reject, and must never hide one it would accept.
 * Pure data in, pure data out, so it is testable without a wallet or a chain.
 */

export const ROLE_CLIENT = "client";
export const ROLE_WORKER = "worker";
export const ROLE_OBSERVER = "observer";

export function roleOf(account, project) {
  if (!account || !project) return ROLE_OBSERVER;

  const normalized = account.toLowerCase();

  if (project.client && project.client.toLowerCase() === normalized) {
    return ROLE_CLIENT;
  }

  if (project.worker && project.worker.toLowerCase() === normalized) {
    return ROLE_WORKER;
  }

  return ROLE_OBSERVER;
}

/**
 * Actions that belong to the project rather than to one milestone. They are
 * rendered once, not repeated under every milestone.
 */
export const PROJECT_ACTIONS = new Set([
  "fund",
  "activate_funding",
  "withdraw_deposit_credit",
  "fund_appeal_credit",
  "withdraw_appeal_credit",
  "propose_settlement",
  "accept_settlement",
  "withdraw_settlement",
  "emit_next_outflow",
  "confirm_outflow",
  "redirect_outflow",
  "sweep_unmatched",
  "close_project",
]);

export function isProjectScoped(action) {
  return PROJECT_ACTIONS.has(action);
}

// Actions the contract allows any caller to make, because they are
// deterministic and cannot redirect value.
const PERMISSIONLESS = new Set([
  "resolve",
  "mark_review_stalled",
  "expire_delivery",
  "finalize_rejection",
  "emit_next_outflow",
  "confirm_outflow",
  "sweep_unmatched",
  "close_project",
]);

export function isPermissionless(action) {
  return PERMISSIONLESS.has(action);
}

/**
 * @returns array of { action, label, role, reason } the account may take.
 */
export function availableActions({ role, project, milestone }) {
  const out = [];
  const add = (action, label) => out.push({ action, label, role });

  if (!project) return out;

  const projectStatus = project.status;
  const status = milestone ? milestone.status : null;

  if (projectStatus === "AWAITING_DEPOSIT") {
    if (role === ROLE_CLIENT) {
      // Depositing is payable and check-free; activation is a separate,
      // non-payable call that only succeeds on the exact amount.
      add("fund", "Deposit funds");

      if (project.depositCreditHeld && project.depositCreditHeld !== "0") {
        add("withdraw_deposit_credit", "Withdraw deposit credit");

        if (project.depositCreditHeld === project.totalRequired) {
          add("activate_funding", "Activate funding");
        }
      }
    }

    return out;
  }

  if (projectStatus === "CLOSED") {
    // Only unattributable value can still move, and sweeping is
    // permissionless.
    if (project.unmatchedHeld && project.unmatchedHeld !== "0") {
      add("sweep_unmatched", "Return unmatched value to the client");
    }

    return out;
  }

  if (projectStatus === "SETTLING") {
    if (project.hasConfirmableOutflow) {
      add("confirm_outflow", "Confirm the pending transfer");
    }

    if (project.canClose) add("close_project", "Close the project");

    if (project.unmatchedHeld && project.unmatchedHeld !== "0") {
      add("sweep_unmatched", "Return unmatched value to the client");
    }

    return out;
  }

  // ACTIVE from here on.
  if (role === ROLE_WORKER) {
    if (status === "AWAITING_DELIVERY" || status === "REVISION_REQUIRED") {
      add("submit_deliverable", "Submit evidence");
    }

    if (
      status === "UNDER_REVIEW" ||
      status === "EVIDENCE_UNAVAILABLE" ||
      status === "REVIEW_STALLED"
    ) {
      add("replace_evidence", "Replace evidence");
    }

    if (status === "APPROVED") add("claim_payment", "Claim payment");

    if (milestone && milestone.appealable) {
      add("appeal", "Appeal the rejection");
    }

    if (milestone && milestone.appealOpen && milestone.appealAbortable) {
      add("abort_failed_appeal", "Abort the stalled appeal");
    }

    add("fund_appeal_credit", "Add appeal credit");

    if (project.appealCreditHeld && project.appealCreditHeld !== "0") {
      add("withdraw_appeal_credit", "Withdraw appeal credit");
    }
  }

  if (role === ROLE_CLIENT || role === ROLE_WORKER) {
    if (project.settlement && project.settlement.active) {
      const proposer = (project.settlement.proposer || "").toLowerCase();
      const isProposer = proposer === (project.account || "").toLowerCase();

      if (isProposer) {
        add("withdraw_settlement", "Withdraw the settlement proposal");
      } else {
        add("accept_settlement", "Accept the settlement");
      }
    } else if (project.canPropose) {
      add("propose_settlement", "Propose a settlement");
    }
  }

  if (
    status === "UNDER_REVIEW" ||
    status === "EVIDENCE_UNAVAILABLE" ||
    status === "REVIEW_STALLED" ||
    status === "UNDER_APPEAL"
  ) {
    add("resolve", "Run review");
  }

  if (milestone && milestone.stallable) {
    add("mark_review_stalled", "Mark the review stalled");
  }

  if (milestone && milestone.expirable) {
    add("expire_delivery", "Expire the delivery deadline");
  }

  if (milestone && milestone.finalizable) {
    add("finalize_rejection", "Finalize the rejection");
  }

  if (project.hasConfirmableOutflow) {
    add("confirm_outflow", "Confirm the pending transfer");
  }

  if (project.hasQueuedOutflow && !project.hasConfirmableOutflow) {
    add("emit_next_outflow", "Emit the next queued transfer");
  }

  if (project.unmatchedHeld && project.unmatchedHeld !== "0") {
    add("sweep_unmatched", "Return unmatched value to the client");
  }

  return out;
}

/** Writes are only offered when configuration and wallet are both ready. */
export function writesEnabled({ configOk, connected, correctNetwork }) {
  return Boolean(configOk && connected && correctNetwork);
}
