/**
 * Classifying GenLayer receipts, and where transaction ids come from.
 *
 * FINALIZED is not success. A transaction can be finalized with an execution
 * error, or without the validators' AGREE result, so a result is "success"
 * only when status, execution result and consensus result all agree, and the
 * transaction targets the expected contract.
 */

const lower = (value) => String(value || "").toLowerCase();

export const TERMINAL_FAILURE_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "UNDETERMINED",
  "LEADER_TIMEOUT",
  "VALIDATORS_TIMEOUT",
]);

export function statusOf(tx) {
  if (!tx) return null;

  const named = tx.statusName ?? tx.status_name;

  if (named) return String(named);

  const raw = tx.status;

  if (raw === 7 || raw === "7") return "FINALIZED";
  if (raw === 5 || raw === "5") return "ACCEPTED";

  return raw === undefined || raw === null ? null : String(raw);
}

export function executionOf(tx) {
  const value =
    tx?.txExecutionResultName ??
    tx?.tx_execution_result_name ??
    tx?.txExecutionResult ??
    tx?.tx_execution_result;

  if (value === "FINISHED_WITH_RETURN" || Number(value) === 1) return "FINISHED_WITH_RETURN";
  if (value === "FINISHED_WITH_ERROR" || Number(value) === 2) return "FINISHED_WITH_ERROR";

  return value === undefined || value === null ? null : String(value);
}

export function consensusOf(tx) {
  const value = tx?.resultName ?? tx?.result_name;

  return value === undefined || value === null ? null : String(value);
}

/**
 * @returns {{key, label, ok, final}} where key is one of
 *   success | execution-failed | not-agreed | finalized-unverified |
 *   failed | accepted | pending | wrong-recipient | missing
 */
export function classifyReceipt(tx, expectedRecipient) {
  if (!tx) return { key: "missing", label: "Not found", ok: false, final: false };

  const recipient = tx.recipient ?? tx.to_address;

  if (expectedRecipient && lower(recipient) !== lower(expectedRecipient)) {
    return { key: "wrong-recipient", label: "Different contract", ok: false, final: true };
  }

  const status = statusOf(tx);
  const execution = executionOf(tx);
  const consensus = consensusOf(tx);

  if (TERMINAL_FAILURE_STATUSES.has(String(status).toUpperCase())) {
    return { key: "failed", label: `${status}`, ok: false, final: true };
  }

  if (status === "FINALIZED") {
    if (execution === "FINISHED_WITH_ERROR") {
      return { key: "execution-failed", label: "Finalized · execution failed", ok: false, final: true };
    }

    const agreed = consensus === "AGREE" || consensus === "MAJORITY_AGREE";

    if (execution === "FINISHED_WITH_RETURN" && agreed) {
      return { key: "success", label: "Finalized · success", ok: true, final: true };
    }

    if (execution === "FINISHED_WITH_RETURN" && consensus) {
      return { key: "not-agreed", label: `Finalized · consensus ${consensus}`, ok: false, final: true };
    }

    return { key: "finalized-unverified", label: "Finalized · success unverified", ok: false, final: true };
  }

  if (status === "ACCEPTED") {
    return { key: "accepted", label: "Accepted · awaiting finality", ok: false, final: false };
  }

  return { key: "pending", label: status ? `${status}` : "Pending", ok: false, final: false };
}

/* ------------------------- transaction id sources ------------------------- */

/**
 * Transactions the page can list for a project, each with where it came
 * from. A project address by itself is not a history source.
 *
 *   published  a curated list shipped with the app (the reviewed evidence)
 *   journal    sent from this browser and recorded in its journal
 *   logs       found in Bradbury consensus NewTransaction events
 *   manual     pasted by the user
 */
export function collectProjectTransactions({ project, published = null, journalEntries = [], logs = [], manual = [] }) {
  const out = new Map();
  const add = (txId, entry) => {
    const key = lower(txId);

    if (!/^0x[0-9a-f]{64}$/.test(key)) return;

    const existing = out.get(key);

    if (existing) {
      existing.sources = Array.from(new Set([...existing.sources, ...entry.sources]));
      existing.label = existing.label || entry.label;
      existing.evmHash = existing.evmHash || entry.evmHash || null;
    } else {
      out.set(key, { txId: key, label: entry.label || null, evmHash: entry.evmHash || null, sources: entry.sources });
    }
  };

  if (published && lower(published.escrow) === lower(project)) {
    for (const t of published.transactions) add(t.hash, { label: t.label, sources: ["published"] });
  }

  for (const e of journalEntries) {
    if (e.txId && lower(e.project) === lower(project)) {
      add(e.txId, { label: e.label, evmHash: e.evmHash, sources: ["journal"] });
    }
  }

  for (const l of logs) add(l.txId, { label: null, evmHash: l.evmHash, sources: ["logs"] });
  for (const m of manual) add(m, { label: null, sources: ["manual"] });

  return Array.from(out.values());
}

/**
 * Find NewTransaction(txId, recipient = project) events on the consensus
 * contract in a bounded block range. Coverage is returned with the result so
 * the page can say exactly which blocks were searched; an RPC that refuses
 * log queries yields an explicit "unavailable", never an empty history.
 */
export async function scanNewTransactionLogs(client, {
  consensus,
  project,
  fromBlock,
  toBlock,
  chunk = 5000n,
  maxChunks = 20,
}) {
  const event = consensus.abi.find((e) => e.type === "event" && e.name === "NewTransaction");

  if (!event) return { ok: false, reason: "The consensus ABI has no NewTransaction event.", logs: [] };

  let latest;

  try {
    latest = toBlock ?? (await client.getBlockNumber());
  } catch (error) {
    return { ok: false, reason: `Latest block unavailable: ${error.message || error}`, logs: [] };
  }

  const start = BigInt(fromBlock);
  const end = BigInt(latest);
  const logs = [];
  let cursor = start;
  let chunks = 0;

  while (cursor <= end && chunks < maxChunks) {
    const upper = cursor + BigInt(chunk) - 1n > end ? end : cursor + BigInt(chunk) - 1n;

    try {
      const found = await client.getLogs({
        address: consensus.address,
        event,
        args: { recipient: project },
        fromBlock: cursor,
        toBlock: upper,
      });

      for (const log of found) {
        if (log.args?.txId) logs.push({ txId: log.args.txId, evmHash: log.transactionHash, block: log.blockNumber });
      }
    } catch (error) {
      return {
        ok: false,
        reason: `Log query refused for blocks ${cursor}–${upper}: ${error.shortMessage || error.message || error}`,
        logs,
        scanned: { from: start, to: cursor - 1n },
      };
    }

    cursor = upper + 1n;
    chunks += 1;
  }

  return {
    ok: true,
    complete: cursor > end,
    logs,
    scanned: { from: start, to: cursor - 1n },
    latest: end,
  };
}
