/**
 * The job state machine. Every transition is a compare-and-set in the
 * database, so a crash, a restart or a second process never repeats a step.
 *
 *   queued   ── re-plan from fresh chain state, estimate, check caps/budget
 *     │         (no transaction exists yet; may be cancelled or go obsolete)
 *     ▼
 *   signing  ── nonce, gas, gas price, data and validUntil RESERVED durably
 *     │         (signing is deterministic: re-signing gives the same bytes)
 *     ▼
 *   signed   ── raw transaction and its keccak hash stored BEFORE broadcast
 *     │         broadcast only these exact bytes; retries resend the same bytes
 *     ▼
 *   broadcast ─ waiting for the receipt of THAT hash; rebroadcast of the same
 *     │         bytes is waiting, not resending; nothing is ever re-signed
 *     ▼
 *   tracking ── GenLayer id from the consensus event of that receipt
 *     ▼
 *   done | failed                      (FINALIZED alone is not success)
 *
 * Side exits: cancelled (consent withdrawn, only before signing), obsolete
 * (the chain no longer needs the step, only before signing), blocked (cap or
 * permanent pre-sign error), conflict (our nonce was consumed without our
 * hash: stop, operator attention, never re-sign).
 */

import { immediate, nowSeconds } from "./db.js";
import { consensusCallData, signReserved } from "./txbuild.js";
import { newTransactionFromReceipt } from "../../dapp/src/workspace/sender.js";
import { classifyReceipt } from "../../dapp/src/workspace/finality.js";

export const TERMINAL = new Set(["done", "failed", "blocked", "cancelled", "obsolete", "conflict"]);

const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
const errText = (e) => String(e?.shortMessage || e?.details || e?.message || e).replace(/0x[0-9a-fA-F]{200,}/g, "0x…").slice(0, 300);

export function enqueue(db, { chainId, escrow }, plan, now = nowSeconds()) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (key, chain_id, escrow, function_name, args_json, scope, amount, reason, consent_ids, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      `${chainId}:${escrow.toLowerCase()}:${plan.key}`,
      chainId,
      escrow,
      plan.functionName,
      JSON.stringify(plan.args),
      plan.scope,
      plan.amount,
      plan.reason,
      JSON.stringify(plan.consentIds),
      now,
      now,
    );

  return result.changes === 1;
}

/** CAS update; returns true when this caller made the transition. */
function transition(db, id, from, patch) {
  const fields = Object.keys(patch);
  const sets = [...fields.map((f) => `${f} = ?`), "updated_at = ?"].join(", ");
  const res = db
    .prepare(`UPDATE jobs SET ${sets} WHERE id = ? AND state = ?`)
    .run(...fields.map((f) => patch[f]), nowSeconds(), id, from);

  return res.changes === 1;
}

const getJob = (db, id) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);

function spentToday(db, now) {
  const row = db.prepare("SELECT wei FROM spend WHERE day = ?").get(day(now));

  return row ? BigInt(row.wei) : 0n;
}

export function createExecutor({ db, chain, chainConfig, account, config, planFresh, consentsActive, onEvent = () => {}, log = () => {} }) {
  const sender = account?.address || null;
  const consensusAddress = chainConfig.consensusMainContract.address;
  // Tracking-only mode (sending off, or no key) disables signing, the first
  // broadcast and every rebroadcast, in every state. Receipts are still read,
  // and every stored field and signed byte is kept for when sending resumes.
  const canSend = () => Boolean(config.sendingEnabled && account);

  /** Another step for the same escrow is not final yet: wait for it. */
  const predecessorOpen = (job) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM jobs WHERE chain_id = ? AND lower(escrow) = lower(?) AND id != ? AND state IN ('signing','signed','broadcast','tracking') LIMIT 1")
        .get(job.chain_id, job.escrow, job.id),
    );

  const fail = (job, from, state, error, extra = {}) => {
    if (transition(db, job.id, from, { state, last_error: errText(error), ...extra })) {
      onEvent({ kind: `job_${state}`, job: getJob(db, job.id) });
    }
  };

  async function stepQueued(job, now) {
    if (job.next_attempt_at > now) return;

    // Consent can be withdrawn until the transaction exists.
    if (!consentsActive(JSON.parse(job.consent_ids), job.scope)) {
      fail(job, "queued", "cancelled", "consent revoked or expired before signing");

      return;
    }

    if (!canSend()) return; // tracking-only mode: nothing is signed

    // Dependent steps wait until every earlier step of this escrow is final.
    // (Cheap early exit; the binding check is repeated inside the reservation.)
    if (predecessorOpen(job)) return;

    // The step must still be needed, exactly, on fresh chain state.
    let plans;

    try {
      plans = await planFresh(job.escrow);
    } catch (error) {
      return backoff(job, error, false);
    }

    if (!plans.some((p) => `${job.chain_id}:${job.escrow.toLowerCase()}:${p.key}` === job.key)) {
      fail(job, "queued", "obsolete", "the contract no longer needs this step");

      return;
    }

    const validUntil = now + 3600;
    const data = consensusCallData({
      chain: chainConfig,
      sender,
      escrow: job.escrow,
      functionName: job.function_name,
      args: JSON.parse(job.args_json),
      validUntil,
    });

    let estimate;
    let gasPrice;
    let chainPending;

    try {
      [estimate, gasPrice, chainPending] = await Promise.all([
        chain.estimateGas({ from: sender, to: consensusAddress, data }),
        chain.gasPrice(),
        chain.pendingNonce(sender),
      ]);
    } catch (error) {
      return backoff(job, error, true);
    }

    estimate = BigInt(estimate);
    gasPrice = BigInt(gasPrice);

    if (estimate > config.maxGas) {
      fail(job, "queued", "blocked", `gas estimate ${estimate} exceeds the cap ${config.maxGas}`);

      return;
    }

    if (gasPrice > config.maxGasPriceWei) {
      // Wait for cheaper gas; this does not consume an attempt.
      transition(db, job.id, "queued", { next_attempt_at: now + config.feeWaitSeconds, last_error: `gas price ${gasPrice} above cap ${config.maxGasPriceWei}; waiting` });

      return;
    }

    const gas = (estimate * 12n) / 10n > config.maxGas ? config.maxGas : (estimate * 12n) / 10n;
    const fee = gas * gasPrice;

    if (fee > config.maxFeePerTxWei) {
      fail(job, "queued", "blocked", `fee ${fee} exceeds the per-transaction cap ${config.maxFeePerTxWei}`);

      return;
    }

    // Reserve: nonce, fields and budget in one durable step.
    let reserved = false;

    try {
      reserved = immediate(db, () => {
        const fresh = getJob(db, job.id);

        if (fresh.state !== "queued") return false;

        // Single flight per escrow, decided inside the write lock: another
        // process may have reserved a different step for this escrow while we
        // were re-planning and estimating. Then this one waits.
        if (predecessorOpen(fresh)) return false;

        const spent = spentToday(db, now);

        if (spent + fee > config.dailyBudgetWei) {
          db.prepare("UPDATE jobs SET next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(
            Math.floor(Date.parse(`${day(now)}T00:00:00Z`) / 1000) + 86400,
            "daily automation budget reached; manual actions are unaffected",
            now,
            job.id,
          );
          onEvent({ kind: "budget_paused", job: fresh });

          return false;
        }

        const row = db.prepare("SELECT next_nonce FROM sender_nonce WHERE sender = ?").get(sender);
        const nonce = Math.max(row ? row.next_nonce : 0, Number(chainPending));

        db.prepare("INSERT INTO sender_nonce (sender, next_nonce) VALUES (?, ?) ON CONFLICT(sender) DO UPDATE SET next_nonce = excluded.next_nonce").run(sender, nonce + 1);
        db.prepare("INSERT INTO spend (day, wei) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET wei = ?").run(day(now), (spent + fee).toString(), (spent + fee).toString());

        return transition(db, job.id, "queued", {
          state: "signing",
          sender,
          nonce,
          gas: gas.toString(),
          gas_price: gasPrice.toString(),
          data,
          last_error: null,
        });
      });
    } catch (error) {
      return backoff(job, error, false);
    }

    if (reserved) await stepSigning(getJob(db, job.id));
  }

  async function stepSigning(job) {
    if (!canSend()) return;

    if (job.sender?.toLowerCase() !== sender.toLowerCase()) {
      log("warn", "job reserved for another sender key; leaving it", { job: job.id });

      return;
    }

    const { raw, hash } = await signReserved(account, {
      chainId: chainConfig.id,
      nonce: job.nonce,
      gas: job.gas,
      gasPrice: job.gas_price,
      to: consensusAddress,
      data: job.data,
    });

    // Identity is durable before any broadcast.
    if (transition(db, job.id, "signing", { state: "signed", raw_tx: raw, evm_hash: hash })) {
      log("info", "signed", { job: job.id, hash });
      await stepSigned(getJob(db, job.id), nowSeconds());
    }
  }

  async function receiptOf(job) {
    try {
      return await chain.getReceipt(job.evm_hash);
    } catch {
      return null;
    }
  }

  async function stepSigned(job, now) {
    // Always look for the receipt of our hash first; backoff only delays resending.
    const receipt = await receiptOf(job);

    if (receipt) return onReceipt(job, "signed", receipt);
    if (!canSend()) return; // keep the bytes; do not broadcast while sending is off
    if (job.next_attempt_at > now) return;

    try {
      const returned = await chain.sendRawTransaction(job.raw_tx);

      if (returned && returned.toLowerCase() !== job.evm_hash.toLowerCase()) {
        throw new Error("node returned a different hash for our signed bytes");
      }

      transition(db, job.id, "signed", { state: "broadcast", broadcast_count: job.broadcast_count + 1, last_broadcast_at: now, last_error: null });
    } catch (error) {
      const text = errText(error);

      if (/already known|known transaction|already imported/i.test(text)) {
        transition(db, job.id, "signed", { state: "broadcast", broadcast_count: job.broadcast_count + 1, last_broadcast_at: now });

        return;
      }

      if (/nonce too low/i.test(text)) return checkConflict(job, "signed");

      // Timeout, disconnect or a node refusal: the bytes may or may not have
      // reached the network. Keep them; poll the hash; resend the same bytes.
      transition(db, job.id, "signed", {
        broadcast_count: job.broadcast_count + 1,
        last_broadcast_at: now,
        next_attempt_at: now + Math.min(600, config.backoffBaseSeconds * 2 ** Math.min(job.broadcast_count, 6)),
        last_error: text,
      });
    }
  }

  async function checkConflict(job, from) {
    const receipt = await receiptOf(job);

    if (receipt) return onReceipt(job, from, receipt);

    let latest;

    try {
      latest = await chain.latestNonce(job.sender);
    } catch {
      return;
    }

    if (Number(latest) > Number(job.nonce)) {
      // Our nonce is used and our hash has no receipt: something else used it.
      fail(job, from, "conflict", `nonce ${job.nonce} was consumed without transaction ${job.evm_hash}; not re-signed`);
    }
  }

  async function stepBroadcast(job, now) {
    const receipt = await receiptOf(job);

    if (receipt) return onReceipt(job, "broadcast", receipt);

    if (canSend() && now - (job.last_broadcast_at || 0) >= config.rebroadcastSeconds) {
      try {
        await chain.sendRawTransaction(job.raw_tx); // the same bytes: waiting, not resending
      } catch (error) {
        if (/nonce too low/i.test(errText(error))) return checkConflict(job, "broadcast");
      }

      transition(db, job.id, "broadcast", { broadcast_count: job.broadcast_count + 1, last_broadcast_at: now });
    }
  }

  function onReceipt(job, from, receipt) {
    const status = receipt.status;

    if (status === "reverted" || status === 0 || status === "0x0") {
      fail(job, from, "failed", "the EVM transaction reverted", { verdict_json: JSON.stringify({ key: "evm-reverted", label: "EVM transaction reverted", ok: false, final: true }) });

      return;
    }

    const found = newTransactionFromReceipt(receipt, chainConfig.consensusMainContract);

    if (!found.txId) {
      fail(job, from, "failed", `receipt has ${found.count} consensus NewTransaction events (expected 1)`, {
        verdict_json: JSON.stringify({ key: "no-genlayer-tx", ok: false, final: true }),
      });

      return;
    }

    if (transition(db, job.id, from, { state: "tracking", gl_tx_id: found.txId, evm_block: receipt.blockNumber?.toString?.() ?? null })) {
      onEvent({ kind: "job_tracking", job: getJob(db, job.id) });
    }
  }

  async function stepTracking(job) {
    let tx;

    try {
      tx = await chain.getGenLayerTx(job.gl_tx_id);
    } catch {
      return;
    }

    if (!tx) return;

    const verdict = classifyReceipt(tx, job.escrow);

    if (!verdict.final) {
      db.prepare("UPDATE jobs SET verdict_json = ?, updated_at = ? WHERE id = ? AND state = 'tracking'").run(JSON.stringify(verdict), nowSeconds(), job.id);

      return;
    }

    const state = verdict.ok ? "done" : "failed";

    if (transition(db, job.id, "tracking", { state, verdict_json: JSON.stringify(verdict), last_error: verdict.ok ? null : verdict.label })) {
      onEvent({ kind: `job_${state}`, job: getJob(db, job.id) });
    }
  }

  function backoff(job, error, countsAsAttempt) {
    const attempts = job.attempts + (countsAsAttempt ? 1 : 0);

    if (attempts >= config.maxAttempts) {
      fail(job, "queued", "blocked", `gave up after ${attempts} attempts: ${errText(error)}`, { attempts });

      return;
    }

    transition(db, job.id, "queued", {
      attempts,
      next_attempt_at: nowSeconds() + Math.min(3600, config.backoffBaseSeconds * 2 ** attempts),
      last_error: errText(error),
    });
  }

  async function step(job, now = nowSeconds()) {
    switch (job.state) {
      case "queued":
        return stepQueued(job, now);
      case "signing":
        return stepSigning(job);
      case "signed":
        return stepSigned(job, now);
      case "broadcast":
        return stepBroadcast(job, now);
      case "tracking":
        return stepTracking(job);
      default:
        return undefined;
    }
  }

  /** Advance every open job once, oldest first, signing in nonce order. */
  async function runOnce(now = nowSeconds()) {
    const open = db.prepare("SELECT * FROM jobs WHERE state NOT IN ('done','failed','blocked','cancelled','obsolete','conflict') ORDER BY id").all();

    for (const job of open) {
      try {
        await step(getJob(db, job.id), now);
      } catch (error) {
        log("error", "job step failed", { job: job.id, error: errText(error) });
      }
    }
  }

  return { step, runOnce };
}
