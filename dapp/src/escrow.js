/**
 * Reads and writes against ProjectEscrow.
 *
 * Every view name here exists in contracts/project_escrow.py. Only verified
 * genlayer-js calls are used: readContract, writeContract and
 * waitForTransactionReceipt.
 */

import { stateFromReceipt, TX_SUBMITTED } from "./tx.js";

const read = (client, address, functionName, args = []) =>
  client.readContract({ address, functionName, args });

export async function readProject(client, address) {
  const [summary, accounting, settlement, outflowCount] = await Promise.all([
    read(client, address, "parties"),
    read(client, address, "get_accounting"),
    read(client, address, "get_settlement"),
    read(client, address, "get_outflow_count"),
  ]);

  return {
    interfaceId: summary.interface_id,
    client: summary.client,
    worker: summary.worker,
    status: summary.project_status,
    milestoneCount: Number(summary.milestone_count),
    totalFunded: summary.total_funded,
    totalReleased: summary.total_released,
    totalRefunded: summary.total_refunded,
    locked: accounting.locked,
    depositCreditHeld: accounting.deposit_credit_held,
    totalRequired: summary.total_required,
    queuedOut: accounting.queued_out,
    inflightOut: accounting.inflight_out,
    bouncedHeld: accounting.bounced_held,
    unmatchedHeld: accounting.unmatched_held,
    appealCreditHeld: accounting.appeal_credit_held,
    appealBondHeld: accounting.appeal_bond_held,
    settlement: {
      active: Boolean(settlement.active),
      proposer: settlement.proposer,
      toWorker: settlement.to_worker,
      toClient: settlement.to_client,
      nonce: settlement.nonce,
    },
    outflowCount: Number(outflowCount),
  };
}

export async function readOutflows(client, address, count) {
  const indexes = Array.from({ length: count }, (_, i) => i);

  return Promise.all(
    indexes.map(async (id) => {
      const [kind, status, amount, recipient, milestone] = await Promise.all([
        read(client, address, "get_outflow_kind", [id]),
        read(client, address, "get_outflow_status", [id]),
        read(client, address, "get_outflow_amount", [id]),
        read(client, address, "get_outflow_recipient", [id]),
        read(client, address, "get_outflow_milestone", [id]),
      ]);

      return {
        id,
        kind,
        status,
        amount,
        recipient,
        milestone: Number(milestone),
      };
    }),
  );
}

export async function readMilestone(client, address, index) {
  const call = (functionName) => read(client, address, functionName, [index]);

  const [
    status,
    amount,
    revisions,
    attempts,
    deliveryDeadline,
    stallEligibleAt,
    graceExpiry,
    unavailableSince,
    appealExpiry,
    appealUsed,
    appealOpen,
    appealThreshold,
    requiredBond,
  ] = await Promise.all([
    call("get_milestone_status"),
    call("get_milestone_amount"),
    call("get_milestone_revision_count"),
    call("get_attempt_count"),
    call("get_milestone_delivery_deadline"),
    call("get_milestone_stall_eligible_at"),
    call("get_milestone_unavailable_grace_expiry"),
    call("get_milestone_unavailable_since"),
    call("get_milestone_appeal_expiry"),
    call("get_milestone_appeal_used"),
    call("get_milestone_appeal_open"),
    call("get_milestone_appeal_failure_threshold"),
    call("get_milestone_required_appeal_bond"),
  ]);

  return {
    index,
    status,
    amount,
    revisionCount: Number(revisions),
    attemptCount: Number(attempts),
    deliveryDeadline,
    stallEligibleAt,
    graceExpiry,
    unavailableSince,
    appealExpiry,
    appealUsed: Boolean(appealUsed),
    appealOpen: Boolean(appealOpen),
    appealFailureThreshold: appealThreshold,
    requiredAppealBond: requiredBond,
  };
}

export async function sendAction(
  client,
  { address, functionName, args = [], value = 0n },
  onProgress = () => {},
) {
  const hash = await client.writeContract({
    address,
    functionName,
    args,
    value,
  });

  onProgress(TX_SUBMITTED, { hash });

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "FINALIZED",
  });

  const state = stateFromReceipt(receipt);

  onProgress(state, { hash, receipt });

  return { hash, receipt, state };
}
