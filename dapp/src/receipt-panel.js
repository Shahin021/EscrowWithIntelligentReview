import lifecycle from "./lifecycle-transactions.json";

export function receiptVerdict(receipt, escrow) {
  if (!receipt || String(receipt.recipient || receipt.to_address || "").toLowerCase() !== escrow.toLowerCase()) {
    return { label: "Unverified", ok: false };
  }
  const status = receipt.statusName ?? receipt.status_name ?? receipt.status;
  const execution = receipt.txExecutionResultName ?? receipt.tx_execution_result_name ?? receipt.txExecutionResult ?? receipt.tx_execution_result;
  const result = receipt.resultName ?? receipt.result_name;
  if (execution === "FINISHED_WITH_ERROR" || Number(execution) === 2) {
    return { label: "Execution failed", ok: false };
  }
  const successful = execution === "FINISHED_WITH_RETURN" || Number(execution) === 1;
  const agreed = result === "AGREE" || result === "MAJORITY_AGREE";
  if ((status === "FINALIZED" || Number(status) === 7) && successful && agreed) {
    return { label: "FINALIZED", ok: true };
  }
  if (status === "FINALIZED" || Number(status) === 7) return { label: "Finalized · success unverified", ok: false };
  if (status === "ACCEPTED" || Number(status) === 5) return { label: "ACCEPTED · awaiting finality", ok: false };
  return { label: "Pending / unverified", ok: false };
}

export async function withReadTimeout(operation, milliseconds = 25000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Read timeout")), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function mountReceiptPanel(node, config, createClient) {
  if (!node || !config.ok || config.network !== lifecycle.network ||
      config.escrowAddress.toLowerCase() !== lifecycle.escrow.toLowerCase()) return;
  node.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = "Transaction finality";
  const summary = document.createElement("p");
  summary.setAttribute("role", "status");
  const note = document.createElement("p");
  note.className = "receipt-note";
  note.textContent = "Receipts for this escrow's funded recovery lifecycle. Read directly from Bradbury; wallet connection is not required.";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "btn btn-ghost";
  refresh.textContent = "Refresh receipts";
  const list = document.createElement("ul");
  list.className = "receipt-list";
  const rows = lifecycle.transactions.map(({ label, hash }) => {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = `https://explorer-bradbury.genlayer.com/tx/${hash}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `${label} ↗`;
    const verdict = document.createElement("span");
    verdict.textContent = "Not checked";
    row.append(link, verdict);
    list.append(row);
    return { hash, verdict };
  });
  node.append(heading, note, summary, refresh, list);
  let busy = false;
  async function update() {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    summary.textContent = "Reading transaction receipts…";
    rows.forEach(({ verdict }) => { verdict.textContent = "Checking…"; verdict.dataset.ok = "false"; });
    let successes = 0;
    try {
      const client = createClient();
      await withReadTimeout(() => client.initializeConsensusSmartContract());
      await Promise.all(rows.map(async ({ hash, verdict }) => {
        try {
          const receipt = await withReadTimeout(() => client.getTransaction({ hash }));
          const result = receiptVerdict(receipt, lifecycle.escrow);
          verdict.textContent = result.label;
          verdict.dataset.ok = String(result.ok);
          if (result.ok) successes += 1;
        } catch { verdict.textContent = "Unable to verify · retry"; }
      }));
      summary.textContent = `${successes} / ${rows.length} FINALIZED with successful execution · checked ${new Date().toLocaleString()}`;
    } catch {
      rows.forEach(({ verdict }) => { verdict.textContent = "Unable to verify · retry"; });
      summary.textContent = "Bradbury receipts could not be read. Refresh to retry.";
    } finally { busy = false; refresh.disabled = false; }
  }
  refresh.addEventListener("click", update);
  void update();
}
