/**
 * Transaction lifecycle reporting.
 *
 * The contract's own rule is that queueing is not finality, and the UI must
 * say the same thing: nothing is reported as done before the network reports
 * it finalized.
 */

export const TX_IDLE = "idle";
export const TX_SUBMITTED = "submitted";
export const TX_ACCEPTED = "accepted";
export const TX_FINALIZED = "finalized";
export const TX_FAILED = "failed";

const LABELS = {
  [TX_IDLE]: "Ready",
  [TX_SUBMITTED]: "Submitted, waiting for the network",
  [TX_ACCEPTED]: "Accepted, not final yet",
  [TX_FINALIZED]: "Finalized",
  [TX_FAILED]: "Failed",
};

export function labelFor(state) {
  return LABELS[state] || "Unknown";
}

export function isSettled(state) {
  return state === TX_FINALIZED || state === TX_FAILED;
}

export function isSuccess(state) {
  return state === TX_FINALIZED;
}

/**
 * Map a receipt from genlayer-js onto a lifecycle state.
 *
 * A transaction can be FINALIZED and still have failed during execution
 * (txExecutionResult FINISHED_WITH_ERROR, as probe L9 showed), so execution
 * result is checked before status.
 */
export function stateFromReceipt(receipt) {
  if (!receipt) return TX_SUBMITTED;

  const execution =
    receipt.txExecutionResultName ||
    receipt.txExecutionResult ||
    receipt.execution_result;

  if (execution === "FINISHED_WITH_ERROR" || execution === 2) {
    return TX_FAILED;
  }

  const status = receipt.status_name || receipt.status;

  if (status === "FINALIZED" || status === 7) return TX_FINALIZED;
  if (status === "ACCEPTED" || status === 5) return TX_ACCEPTED;
  if (status === "CANCELED" || status === "UNDETERMINED") return TX_FAILED;

  return TX_SUBMITTED;
}

/** Turn an error into something a user can act on. */
export function explainError(error) {
  const raw = (error && (error.shortMessage || error.message)) || String(error);

  if (/user rejected|user denied/i.test(raw)) {
    return "You rejected the request in your wallet.";
  }

  if (/MetaMask is not installed/i.test(raw)) {
    return "MetaMask was not detected. GenLayer needs MetaMask with the GenLayer Snap.";
  }

  if (/snap/i.test(raw)) {
    return "The GenLayer Snap could not be enabled in MetaMask.";
  }

  if (/insufficient/i.test(raw)) {
    return "The account does not have enough balance for this transaction.";
  }

  const userError = raw.match(/UserError\(message='([^']+)'\)/);

  if (userError) {
    // The contract's own message is the most useful thing we can show.
    return `The contract rejected this: ${userError[1]}`;
  }

  return raw;
}
