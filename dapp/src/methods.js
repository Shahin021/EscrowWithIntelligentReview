/**
 * The contract's write surface, transcribed from contracts/project_escrow.py.
 *
 * Every entry here was read from the contract source. Nothing is invented: an
 * earlier draft of this app offered `expire_unavailable`, which the contract
 * does not have, and that is exactly the class of bug this table prevents.
 *
 * `fields` are the inputs the UI must collect, in argument order. `payable`
 * marks the two methods that carry value; everything else is sent with 0n.
 * `milestoneArg` marks methods whose first argument is the milestone index.
 */

export const METHODS = {
  fund: {
    label: "Deposit funds",
    payable: true,
    valueFrom: "amount",
    fields: [
      {
        name: "amount",
        label: "Amount to deposit, in wei",
        kind: "amount",
      },
    ],
    args: () => [],
  },
  activate_funding: {
    label: "Activate funding",
    fields: [],
    args: () => [],
  },
  withdraw_deposit_credit: {
    label: "Withdraw deposit credit",
    fields: [{ name: "amount", label: "Amount in wei", kind: "amount" }],
    args: (index, input) => [String(input.amount)],
  },
  submit_deliverable: {
    label: "Submit evidence",
    milestoneArg: true,
    fields: [
      { name: "artifact_url", label: "Pinned artifact URL", kind: "text" },
      { name: "notes", label: "Notes (optional)", kind: "text", optional: true },
    ],
    args: (index, input) => [index, input.artifact_url, input.notes || ""],
  },
  replace_evidence: {
    label: "Replace evidence",
    milestoneArg: true,
    fields: [
      { name: "artifact_url", label: "New pinned artifact URL", kind: "text" },
      { name: "notes", label: "Notes (optional)", kind: "text", optional: true },
    ],
    args: (index, input) => [index, input.artifact_url, input.notes || ""],
  },
  resolve: {
    label: "Run review",
    milestoneArg: true,
    fields: [],
    args: (index) => [index],
  },
  mark_review_stalled: {
    label: "Mark the review stalled",
    milestoneArg: true,
    fields: [],
    args: (index) => [index],
  },
  expire_delivery: {
    label: "Expire the delivery deadline",
    milestoneArg: true,
    fields: [],
    args: (index) => [index],
  },
  claim_payment: {
    label: "Claim payment",
    milestoneArg: true,
    fields: [],
    args: (index) => [index],
  },
  appeal: {
    label: "Appeal the rejection",
    milestoneArg: true,
    fields: [
      { name: "note", label: "Appeal note (optional, max 500 chars)", kind: "text", optional: true },
    ],
    args: (index, input) => [index, input.note || ""],
  },
  abort_failed_appeal: {
    label: "Abort the failed appeal",
    milestoneArg: true,
    fields: [],
    args: (index) => [index],
  },
  finalize_rejection: {
    label: "Finalize the rejection",
    milestoneArg: true,
    fields: [],
    args: (index) => [index],
  },
  fund_appeal_credit: {
    label: "Add appeal credit",
    payable: true,
    valueFrom: "amount",
    fields: [
      { name: "amount", label: "Credit to add, in wei", kind: "amount" },
    ],
    args: () => [],
  },
  withdraw_appeal_credit: {
    label: "Withdraw appeal credit",
    fields: [
      { name: "amount", label: "Amount in wei", kind: "amount" },
    ],
    args: (index, input) => [String(input.amount)],
  },
  propose_settlement: {
    label: "Propose a settlement",
    fields: [
      { name: "to_worker", label: "To worker, in wei", kind: "amount" },
      { name: "to_client", label: "To client, in wei", kind: "amount" },
    ],
    args: (index, input) => [String(input.to_worker), String(input.to_client)],
  },
  accept_settlement: {
    label: "Accept the settlement",
    fields: [],
    // The nonce is read from the contract, never typed by the user.
    args: (index, input) => [Number(input.nonce)],
  },
  withdraw_settlement: {
    label: "Withdraw the settlement proposal",
    fields: [],
    args: () => [],
  },
  emit_next_outflow: {
    label: "Emit the next queued transfer",
    fields: [],
    args: () => [],
  },
  confirm_outflow: {
    label: "Confirm the transfer",
    fields: [],
    args: (index, input) => [Number(input.outflow_id)],
  },
  redirect_outflow: {
    label: "Redirect the bounced transfer",
    fields: [
      { name: "to", label: "New recipient address", kind: "address" },
    ],
    args: (index, input) => [Number(input.outflow_id), input.to],
  },
  sweep_unmatched: {
    label: "Return unmatched value to the client",
    fields: [],
    args: () => [],
  },
  close_project: {
    label: "Close the project",
    fields: [],
    args: () => [],
  },
};

export function methodFor(action) {
  const method = METHODS[action];

  if (!method) throw new Error(`Unknown action "${action}".`);

  return method;
}

export function missingFields(action, input = {}) {
  return methodFor(action)
    .fields.filter((field) => !field.optional)
    .filter((field) => {
      const value = input[field.name];

      return value === undefined || value === null || String(value).trim() === "";
    })
    .map((field) => field.name);
}

/**
 * Build the exact call: { functionName, args, value }.
 * Throws rather than sending a call with missing or malformed inputs.
 */
export function buildCall(action, { milestoneIndex = 0, input = {} } = {}) {
  const method = methodFor(action);
  const missing = missingFields(action, input);

  if (missing.length) {
    throw new Error(`Missing input for ${action}: ${missing.join(", ")}.`);
  }

  for (const field of method.fields) {
    const raw = input[field.name];

    if (field.kind === "amount" && raw !== undefined && raw !== "") {
      if (!/^\d+$/.test(String(raw))) {
        throw new Error(`${field.name} must be a whole number of wei.`);
      }
    }

    if (field.kind === "address" && !/^0x[0-9a-fA-F]{40}$/.test(String(raw))) {
      throw new Error(`${field.name} must be a 20-byte hex address.`);
    }
  }

  return {
    functionName: action,
    args: method.args(milestoneIndex, input),
    value: method.payable ? BigInt(input[method.valueFrom]) : 0n,
  };
}
