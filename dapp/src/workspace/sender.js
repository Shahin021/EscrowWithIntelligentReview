/**
 * Sending one write, and following it to a classified result.
 *
 * Order of events for every write:
 *   1. refuse if the same call is already unresolved in the journal;
 *   2. record the intent in the journal (phase "prompting");
 *   3. arm the wallet guard for exactly this call and let genlayer-js build
 *      and send it; the guard records the EVM hash as soon as the wallet
 *      returns it (phase "sent");
 *   4. read the EVM receipt, decode the consensus NewTransaction event to get
 *      the GenLayer transaction id (phase "tracking");
 *   5. poll the GenLayer transaction until it is final, then classify it:
 *      FINALIZED alone is not success.
 *
 * Steps 4 and 5 are read-only and can be repeated at any time, from any page
 * load, from the identifiers in the journal. Nothing is ever re-sent.
 */

import { decodeEventLog } from "viem";

import { classifyReceipt } from "./finality.js";
import {
  PHASE_DONE,
  PHASE_NOT_SENT,
  PHASE_SENT,
  PHASE_TRACKING,
} from "./journal.js";
import { checkAddTransaction, expectedCallData, expectedConstructorData, GuardRefusal } from "./guard.js";

const lower = (value) => String(value || "").toLowerCase();

export class DuplicatePending extends Error {
  constructor(entry) {
    super(
      "This exact action is already recorded as sent or possibly sent and has not " +
        "been resolved. Its tracking is resumed instead of sending it again.",
    );
    this.name = "DuplicatePending";
    this.entry = entry;
  }
}

export function isUserRejection(error) {
  let e = error;

  for (let depth = 0; e && depth < 6; depth += 1) {
    if (e.code === 4001 || /user rejected|user denied|rejected the request/i.test(e.message || "")) return true;
    e = e.cause;
  }

  return false;
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decode the GenLayer transaction id (and recipient) from an EVM receipt of
 * a consensus addTransaction call.
 */
export function newTransactionFromReceipt(receipt, consensus) {
  const event = consensus.abi.find((e) => e.type === "event" && e.name === "NewTransaction");
  const found = [];

  for (const log of receipt?.logs || []) {
    if (lower(log.address) !== lower(consensus.address)) continue;

    try {
      const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });

      if (decoded.eventName === "NewTransaction") found.push(decoded.args);
    } catch {
      /* not this event */
    }
  }

  if (found.length !== 1) return { txId: null, recipient: null, count: found.length };

  return { txId: found[0].txId, recipient: found[0].recipient, count: 1 };
}

/**
 * Read-only: advance an entry as far as the chain allows right now.
 * Returns the updated entry. Never sends anything.
 */
export async function advance(entry, { readClient, consensus, journal, sleep = defaultSleep, polls = 1, intervalMs = 5000 }) {
  let current = entry;

  if (!current.txId && current.evmHash) {
    let receipt = null;

    try {
      receipt = await readClient.getTransactionReceipt({ hash: current.evmHash });
    } catch {
      receipt = null; // not mined yet, or the RPC is unavailable: keep "sent"
    }

    if (receipt) {
      if (receipt.status === "reverted" || receipt.status === 0 || receipt.status === "0x0") {
        return journal.update(current.id, {
          phase: PHASE_DONE,
          verdict: { key: "evm-reverted", label: "EVM transaction reverted", ok: false, final: true },
        });
      }

      const found = newTransactionFromReceipt(receipt, consensus);

      if (!found.txId) {
        return journal.update(current.id, {
          phase: PHASE_DONE,
          verdict: {
            key: "no-genlayer-tx",
            label: `EVM receipt has ${found.count} consensus NewTransaction events (expected 1)`,
            ok: false,
            final: true,
          },
        });
      }

      const patch = { phase: PHASE_TRACKING, txId: found.txId, evmBlock: receipt.blockNumber?.toString?.() ?? null };

      if (current.kind === "deploy") patch.createdAddress = found.recipient;

      current = journal.update(current.id, patch);
    }
  }

  if (!current.txId) return current;

  const expectedRecipient = current.kind === "deploy" ? current.createdAddress : current.project;

  for (let i = 0; i < Math.max(1, polls); i += 1) {
    let tx = null;

    try {
      tx = await readClient.getTransaction({ hash: current.txId });
    } catch {
      tx = null;
    }

    if (tx) {
      const verdict = classifyReceipt(tx, expectedRecipient);

      current = journal.update(current.id, {
        phase: verdict.final ? PHASE_DONE : PHASE_TRACKING,
        verdict,
        lastStatus: verdict.label,
      });

      if (verdict.final) return current;
    }

    if (i < polls - 1) await sleep(intervalMs);
  }

  return current;
}

/**
 * Send one write through the guard and follow it.
 *
 * request = {
 *   kind: "call" | "deploy", network, chainId, account, label,
 *   project (call), functionName, args, value,
 *   code (deploy, Uint8Array), constructorArgs (deploy), minGas, maxGas
 * }
 */
export async function sendTracked(request, {
  client,
  guard,
  journal,
  readClient,
  consensus,
  onUpdate = () => {},
  sleep = defaultSleep,
  polls = 120,
  intervalMs = 5000,
  sdkGraceMs = 1500,
}) {
  const binding = {
    network: request.network,
    project: request.kind === "deploy" ? "deploy" : request.project,
    account: request.account,
    functionName: request.kind === "deploy" ? "__deploy__" : request.functionName,
    args: request.kind === "deploy" ? request.constructorArgs : request.args,
    value: request.value ?? 0n,
  };

  const open = journal.findUnresolved(binding);

  if (open) throw new DuplicatePending(open);

  const expect =
    request.kind === "deploy"
      ? {
          kind: "deploy",
          codeHex: bytesToHex(request.code),
          calldataHex: expectedConstructorData(request.constructorArgs),
        }
      : {
          kind: "call",
          project: request.project,
          functionName: request.functionName,
          calldataHex: expectedCallData(request.functionName, request.args),
        };

  let entry = journal.create({
    ...binding,
    kind: request.kind,
    chainId: request.chainId,
    label: request.label || binding.functionName,
    project: binding.project,
    functionName: binding.functionName,
    value: String(request.value ?? 0n),
  });

  onUpdate(entry);

  const slot = guard.arm({
    account: request.account,
    value: request.value ?? 0n,
    minGas: request.minGas,
    maxGas: request.maxGas,
    expect,
    onSent: (hash) => {
      entry = journal.update(entry.id, { phase: PHASE_SENT, evmHash: hash });
      onUpdate(entry);
    },
  });

  let sdkResult = null;
  let sdkError = null;
  let markSent;
  const sentSignal = new Promise((resolve) => {
    markSent = resolve;
  });
  const originalOnSent = slot.onSent;

  slot.onSent = (hash) => {
    originalOnSent(hash);
    // Once the wallet has returned a hash this write is spent: disarm now, so
    // nothing else can be forwarded for it, and stop depending on the SDK's
    // own receipt wait, which can retry for minutes.
    guard.disarm(slot);
    markSent(hash);
  };

  const sdkCall = (async () => {
    try {
      sdkResult =
        request.kind === "deploy"
          ? await client.deployContract({ code: request.code, args: request.constructorArgs, leaderOnly: false })
          : await client.writeContract({
              address: request.project,
              functionName: request.functionName,
              args: request.args,
              value: request.value ?? 0n,
              leaderOnly: false,
            });
    } catch (error) {
      sdkError = error;
    } finally {
      guard.disarm(slot);
    }
  })();

  // Either the SDK finishes (success, refusal, rejection) or the wallet has
  // returned a hash; in the second case the SDK keeps running in background
  // and its result, if any, is folded in when it arrives.
  await Promise.race([sdkCall, sentSignal]);

  if (slot.evmHash) {
    sdkCall.then(() => {
      if (typeof sdkResult === "string" && /^0x[0-9a-fA-F]{64}$/.test(sdkResult) && sdkResult !== slot.evmHash) {
        const latest = journal.get(entry.id);

        if (latest && !latest.txId) journal.update(entry.id, { txId: sdkResult, phase: latest.phase === PHASE_DONE ? latest.phase : PHASE_TRACKING });
      }
    });
    // Give an SDK that already has the receipt a moment to report the id.
    await Promise.race([sdkCall, sleep(sdkGraceMs)]);
  }

  if (!slot.evmHash) {
    const reason =
      slot.refusal?.message ||
      (isUserRejection(sdkError) ? "You rejected the request in your wallet." : null) ||
      sdkError?.shortMessage ||
      sdkError?.message ||
      "No transaction was sent.";

    entry = journal.update(entry.id, {
      phase: PHASE_NOT_SENT,
      error: reason,
      rejectedByUser: isUserRejection(sdkError),
    });
    onUpdate(entry);

    const error = new Error(reason);

    error.name = slot.refusal ? "GuardRefusal" : isUserRejection(sdkError) ? "UserRejected" : "NotSent";
    error.entry = entry;
    throw error;
  }

  // The SDK returns the GenLayer id once it has read the EVM receipt. If it
  // timed out or failed after the wallet returned a hash, the hash is kept
  // and the read-only path below takes over.
  if (typeof sdkResult === "string" && /^0x[0-9a-fA-F]{64}$/.test(sdkResult) && sdkResult !== slot.evmHash) {
    entry = journal.update(entry.id, { phase: PHASE_TRACKING, txId: sdkResult });
  }

  if (sdkError || slot.lateRefusal) {
    entry = journal.update(entry.id, {
      sdkNote: (slot.lateRefusal || sdkError).message?.slice(0, 300) || String(sdkError),
    });
  }

  onUpdate(entry);

  entry = await advance(entry, { readClient, consensus, journal, sleep, polls, intervalMs });
  onUpdate(entry);

  return entry;
}

export function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export { checkAddTransaction, GuardRefusal };
