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
 *
 * "No hash came back" is not "nothing was sent". Once the guard has handed
 * the transaction to the wallet, only an explicit rejection (EIP-1193 4001)
 * proves it was not sent. Any other failure (a disconnect, a timeout, a
 * crashed extension, a reload) leaves the intent open as possibly sent. It
 * is resolved only by finding the transaction on chain (consensus
 * NewTransaction logs by this account, decoded and matched against the exact
 * expected call) or by chain evidence that nothing was sent: the account's
 * nonce has not advanced since the prompt.
 */

import { decodeEventLog } from "viem";

import { classifyReceipt } from "./finality.js";
import {
  PHASE_ABANDONED,
  PHASE_DONE,
  PHASE_NOT_SENT,
  PHASE_PROMPTING,
  PHASE_SENT,
  PHASE_TRACKING,
} from "./journal.js";
import { checkAddTransaction, expectedCallData, expectedConstructorData, GuardRefusal, isUserRejection } from "./guard.js";

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

const HASH = /^0x[0-9a-fA-F]{64}$/;

function errorText(error) {
  return String(error?.shortMessage || error?.message || error || "unknown error").slice(0, 240);
}

/**
 * Send one write through the guard and follow it.
 *
 * request = {
 *   kind: "call" | "deploy", network, chainId, account, label,
 *   project (call), functionName, args, value,
 *   code (deploy, Uint8Array), constructorArgs (deploy), minGas, maxGas
 * }
 *
 * Nothing reaches the wallet unless the intent, its exact expectation and
 * the account's nonce baseline are first stored durably.
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

  // Strict: throws StorageUnavailable when the journal is not durable.
  const open = journal.findUnresolved(binding);

  if (open) throw new DuplicatePending(open);

  // Baseline for proving later that nothing was sent.
  let nonceBefore;
  let promptBlock;

  try {
    [nonceBefore, promptBlock] = await Promise.all([
      readClient.getTransactionCount({ address: request.account, blockTag: "pending" }),
      readClient.getBlockNumber(),
    ]);
  } catch (error) {
    const refused = new Error(
      `Could not read this account's nonce and the current block from the network (${errorText(error)}). ` +
        "Nothing was sent: without them a lost wallet answer could not be resolved later.",
    );

    refused.name = "NotSent";
    throw refused;
  }

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

  // Strict: throws (and nothing is sent) unless the record is durable.
  let entry = journal.create({
    ...binding,
    kind: request.kind,
    chainId: request.chainId,
    label: request.label || binding.functionName,
    project: binding.project,
    functionName: binding.functionName,
    value: String(request.value ?? 0n),
    expect,
    nonceBefore: String(nonceBefore),
    promptBlock: String(promptBlock),
  });

  onUpdate(entry);

  // After the wallet has the transaction, a storage failure must not hide
  // what happened: keep it in memory and say so.
  const persist = (patch) => {
    try {
      entry = journal.update(entry.id, patch) || { ...entry, ...patch };
    } catch (error) {
      entry = { ...entry, ...patch, persistError: errorText(error) };
    }

    onUpdate(entry);

    return entry;
  };

  const slot = guard.arm({
    account: request.account,
    value: request.value ?? 0n,
    minGas: request.minGas,
    maxGas: request.maxGas,
    expect,
    onSent: (hash) => persist({ phase: PHASE_SENT, evmHash: hash, possiblySent: false }),
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
      if (typeof sdkResult === "string" && HASH.test(sdkResult) && sdkResult !== slot.evmHash) {
        try {
          const latest = journal.get(entry.id);

          if (latest && !latest.txId) journal.update(entry.id, { txId: sdkResult, phase: latest.phase === PHASE_DONE ? latest.phase : PHASE_TRACKING });
        } catch {
          /* read-only tracking recovers the id from the EVM receipt anyway */
        }
      }
    });
    // Give an SDK that already has the receipt a moment to report the id.
    await Promise.race([sdkCall, sleep(sdkGraceMs)]);
  }

  if (!slot.evmHash) {
    if (slot.forwarded && !slot.rejected) {
      // The wallet had the transaction and no explicit rejection came back.
      const cause = slot.ambiguous || slot.afterForward || sdkError;

      persist({
        phase: PHASE_PROMPTING,
        possiblySent: true,
        error:
          `The wallet received this transaction but its answer was lost (${errorText(cause)}). ` +
          "It may have been sent, so this action stays open until it is found on chain or shown not to have been sent.",
      });

      const error = new Error(entry.error);

      error.name = "PossiblySent";
      error.entry = entry;
      throw error;
    }

    const rejected = Boolean(slot.rejected);
    const reason =
      slot.refusal?.message ||
      (rejected ? "You rejected the request in your wallet." : null) ||
      errorText(sdkError) ||
      "No transaction was sent.";

    // Not forwarded at all, or explicitly rejected: provably not sent.
    persist({ phase: PHASE_NOT_SENT, error: reason, rejectedByUser: rejected });

    const error = new Error(reason);

    error.name = slot.refusal ? "GuardRefusal" : rejected ? "UserRejected" : "NotSent";
    error.entry = entry;
    throw error;
  }

  // The SDK returns the GenLayer id once it has read the EVM receipt. If it
  // timed out or failed after the wallet returned a hash, the hash is kept
  // and the read-only path below takes over.
  if (typeof sdkResult === "string" && HASH.test(sdkResult) && sdkResult !== slot.evmHash) {
    persist({ phase: PHASE_TRACKING, txId: sdkResult });
  }

  if (sdkError || slot.lateRefusal) {
    persist({ sdkNote: errorText(slot.lateRefusal || sdkError) });
  }

  if (entry.persistError) return entry; // tracked in memory only; the UI says so

  entry = await advance(entry, { readClient, consensus, journal, sleep, polls, intervalMs });
  onUpdate(entry);

  return entry;
}

/* ------------------ resolving a possibly-sent intent ------------------ */

/** Does this EVM transaction carry exactly the recorded call from this account? */
async function matchesEntry(readClient, consensus, entry, evmHash) {
  const tx = await readClient.request({ method: "eth_getTransactionByHash", params: [evmHash] });

  if (!tx) return ["transaction not found on Bradbury"];

  const problems = [];

  if (lower(tx.from) !== lower(entry.account)) problems.push(`sent from ${tx.from}, not ${entry.account}`);
  if (lower(tx.to) !== lower(consensus.address)) problems.push("not a consensus transaction");
  if (BigInt(tx.value ?? 0) !== BigInt(entry.value ?? 0)) problems.push(`value ${BigInt(tx.value ?? 0)} differs`);
  if (entry.expect) {
    problems.push(...checkAddTransaction(tx.input, { consensusAbi: consensus.abi, sender: entry.account, expect: entry.expect }));
  } else {
    problems.push("this record has no stored expectation to match against");
  }

  return problems;
}

/**
 * Read-only check of a possibly-sent intent:
 *   1. search consensus NewTransaction logs by this account since the prompt
 *      block, and match each candidate's EVM input against the exact call;
 *   2. compare the account's nonce with the baseline taken before the prompt.
 *
 * A single match is attached and tracked. The intent becomes releasable only
 * when nothing matched AND both the pending and latest nonce still equal the
 * baseline, i.e. the account has sent nothing since the prompt.
 */
export const RELEASE_MIN_AGE_MS = 10 * 60 * 1000;

export async function checkPossiblySent(entry, { readClient, consensus, journal, chunk = 5000n, maxChunks = 40, now = () => Date.now(), minAgeMs = RELEASE_MIN_AGE_MS }) {
  const result = { at: now(), found: [], search: null, nonce: null, releasable: false, reason: "" };
  const event = consensus.abi.find((e) => e.type === "event" && e.name === "NewTransaction");

  try {
    const latest = BigInt(await readClient.getBlockNumber());
    const start = BigInt(entry.promptBlock ?? latest);
    let cursor = start;
    let chunks = 0;

    while (cursor <= latest && chunks < maxChunks) {
      const upper = cursor + chunk - 1n > latest ? latest : cursor + chunk - 1n;
      const logs = await readClient.getLogs({
        address: consensus.address,
        event,
        args: entry.kind === "deploy" ? { activator: entry.account } : { recipient: entry.project, activator: entry.account },
        fromBlock: cursor,
        toBlock: upper,
      });

      for (const log of logs) {
        if (!log.transactionHash || result.found.includes(log.transactionHash)) continue;
        if ((await matchesEntry(readClient, consensus, entry, log.transactionHash)).length === 0) result.found.push(log.transactionHash);
      }

      cursor = upper + 1n;
      chunks += 1;
    }

    result.search = { ok: true, from: String(start), to: String(cursor - 1n), complete: cursor > latest };
  } catch (error) {
    result.search = { ok: false, reason: errorText(error) };
  }

  try {
    const [pending, mined] = await Promise.all([
      readClient.getTransactionCount({ address: entry.account, blockTag: "pending" }),
      readClient.getTransactionCount({ address: entry.account, blockTag: "latest" }),
    ]);
    const before = BigInt(entry.nonceBefore);

    result.nonce = { before: String(before), pending: String(pending), latest: String(mined), advanced: BigInt(pending) > before || BigInt(mined) > before };
  } catch (error) {
    result.nonce = { error: errorText(error) };
  }

  if (result.found.length) {
    result.reason = `Found on chain: ${result.found[0]}${result.found.length > 1 ? ` (and ${result.found.length - 1} more identical)` : ""}.`;
  } else if (result.nonce?.advanced === false && now() - Number(entry.createdAt || 0) < minAgeMs) {
    // A wallet can still broadcast shortly after its answer was lost.
    result.reason = `No matching transaction yet and the nonce has not advanced. A wallet can still broadcast after a lost answer, so this can be confirmed as not sent from ${new Date(Number(entry.createdAt || 0) + minAgeMs).toISOString().slice(11, 16)} UTC.`;
  } else if (result.nonce?.advanced === false) {
    result.releasable = true;
    result.reason = "No matching transaction was found and this account's nonce has not advanced since the prompt, at least ten minutes ago: no transaction was sent from it.";
  } else if (result.nonce?.advanced) {
    result.reason = `This account has sent a transaction since the prompt (nonce ${result.nonce.before} → ${result.nonce.pending}) but it was not matched${result.search?.ok ? (result.search.complete ? "" : " in the blocks searched so far") : " (log search unavailable)"}. Add its EVM hash from your wallet's activity to check it.`;
  } else {
    result.reason = `The account's nonce could not be read (${result.nonce?.error}); the action stays open.`;
  }

  let current = entry;

  try {
    current = journal.update(entry.id, { lastCheck: result }) || entry;
  } catch {
    /* the check result is still returned */
  }

  if (result.found.length) {
    current = journal.update(entry.id, {
      phase: PHASE_SENT,
      evmHash: result.found[0],
      possiblySent: false,
      foundOnChain: true,
      duplicatesFound: result.found.slice(1),
    });
    current = await advance(current, { readClient, consensus, journal, polls: 1 });
  }

  return { entry: current, check: result };
}

/** Attach an EVM hash the user copied from the wallet, after verifying it. */
export async function attachEvmHash(entry, evmHash, { readClient, consensus, journal }) {
  if (!HASH.test(String(evmHash))) throw new Error("An EVM transaction hash is 0x followed by 64 hex characters.");

  const problems = await matchesEntry(readClient, consensus, entry, evmHash);

  if (problems.length) throw new Error(`That transaction is not this action: ${problems.join("; ")}.`);

  const current = journal.update(entry.id, { phase: PHASE_SENT, evmHash, possiblySent: false, attachedByUser: true });

  return advance(current, { readClient, consensus, journal, polls: 1 });
}

/** Release a possibly-sent intent only when a fresh chain check shows nothing was sent. */
export async function releaseIfNotSent(entry, deps) {
  const { entry: checked, check } = await checkPossiblySent(entry, deps);

  if (!check.releasable || checked.phase !== PHASE_PROMPTING) return { released: false, entry: checked, check };

  return {
    released: true,
    entry: deps.journal.update(entry.id, { phase: PHASE_ABANDONED, releasedAfter: check }),
    check,
  };
}

export function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export { checkAddTransaction, GuardRefusal, isUserRejection };
