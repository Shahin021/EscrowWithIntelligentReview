/**
 * The automation service: consents in, contract state watched, permitted
 * continuation steps queued and executed, outcomes emailed.
 */

import { randomBytes } from "node:crypto";

import { immediate, nowSeconds } from "./db.js";
import { ConsentError, SCOPE_NAMES, verifyConsent, verifyRevoke } from "./consent.js";
import { nextExpected, planActions } from "./planner.js";
import { createExecutor, enqueue, TERMINAL } from "./executor.js";
import { createEvent, diffEvents, fanOut, jobEvent, verificationEmail } from "./notifier.js";
import { deliverOutbox } from "./mailer.js";

const EXPECTED_INTERFACE = "genlayer.milestone-escrow.v2";
const lower = (v) => String(v || "").toLowerCase();
const maskEmail = (e) => String(e).replace(/^(.).*?(.)@/, "$1…$2@");
export const scopesText = (scopes) =>
  Object.entries(SCOPE_NAMES)
    .filter(([bit]) => scopes & Number(bit))
    .map(([, name]) => name)
    .join(", ");

export function createService({ db, chain, account, config, transport, log = () => {}, now = nowSeconds, processId = `${process.pid}-${randomBytes(4).toString("hex")}` }) {
  const chainConfig = chain.chainConfig;
  const chainId = chainConfig.id;
  const explorer = `${String(chainConfig.blockExplorers?.default?.url || "").replace(/\/$/, "")}/`;
  const notifyCtx = { siteUrl: config.siteUrl, explorer, chainId };

  const activeConsents = (escrow) =>
    db
      .prepare("SELECT * FROM consents WHERE chain_id = ? AND lower(escrow) = lower(?) AND revoked_at IS NULL AND expires_at > ?")
      .all(chainId, escrow, now());

  const consentsActive = (ids, scope) => {
    if (!ids.length) return false;

    const rows = db
      .prepare(`SELECT scopes FROM consents WHERE id IN (${ids.map(() => "?").join(",")}) AND revoked_at IS NULL AND expires_at > ?`)
      .all(...ids, now());

    return rows.some((r) => (r.scopes & scope) !== 0);
  };

  const planFresh = async (escrow) => {
    const snapshot = await chain.snapshot(escrow); // finalized state; planActions refuses anything else

    return planActions(snapshot, activeConsents(escrow).map((c) => ({ id: c.id, scopes: c.scopes, maxAmount: c.max_amount, role: c.role })));
  };

  /** Remember a GenLayer transaction for an escrow (from logs or from our own job). */
  const noteTx = (escrow, txId, { block = null, source, verdict = null }) => {
    db.prepare("INSERT OR IGNORE INTO escrow_txs (escrow, tx_id, evm_block, source) VALUES (?, ?, ?, ?)").run(escrow.toLowerCase(), txId.toLowerCase(), block, source);

    if (verdict) {
      db.prepare("UPDATE escrow_txs SET verdict_json = ?, final = ?, ok = ? WHERE escrow = ? AND tx_id = ?").run(
        JSON.stringify(verdict),
        verdict.final ? 1 : 0,
        verdict.ok ? 1 : 0,
        escrow.toLowerCase(),
        txId.toLowerCase(),
      );
    }
  };

  const onEvent = (e) => {
    const job = e.job;

    if (job?.gl_tx_id) {
      const verdict = job.verdict_json ? JSON.parse(job.verdict_json) : null;

      noteTx(job.escrow, job.gl_tx_id, { block: job.evm_block, source: "service", verdict: verdict?.final ? verdict : null });
    }

    const event = jobEvent(e);

    if (!event) return;

    // A job event cites its own transaction (or none, for budget/cap stops,
    // which claim no outcome).
    const verdict = job?.verdict_json ? JSON.parse(job.verdict_json) : null;
    const provenance = job?.gl_tx_id ? [{ txId: job.gl_tx_id, label: verdict?.label || null }] : [];

    createEvent(db, event, { state: "ready", provenance }, now());
  };

  /** Find GenLayer transactions sent to the escrow (bounded, resumable log scan). */
  async function scanTransactions(escrow, toBlock) {
    const cursor = db.prepare("SELECT next_block FROM scan_cursor WHERE escrow = ?").get(escrow.toLowerCase());
    let from = cursor ? BigInt(cursor.next_block) : BigInt(toBlock) - BigInt(config.scanLookbackBlocks) > 0n ? BigInt(toBlock) - BigInt(config.scanLookbackBlocks) : 0n;
    const end = BigInt(toBlock);

    for (let i = 0; i < 5 && from <= end; i += 1) {
      const upper = from + 1999n > end ? end : from + 1999n;
      const found = await chain.transactionsTo(escrow, from, upper);

      for (const t of found) noteTx(escrow, t.txId, { block: t.block, source: "logs" });

      from = upper + 1n;
      db.prepare("INSERT INTO scan_cursor (escrow, next_block) VALUES (?, ?) ON CONFLICT(escrow) DO UPDATE SET next_block = excluded.next_block").run(escrow.toLowerCase(), from.toString());
    }
  }

  async function refreshVerdicts(escrow) {
    const open = db.prepare("SELECT tx_id FROM escrow_txs WHERE escrow = ? AND final = 0 LIMIT 25").all(escrow.toLowerCase());

    for (const row of open) {
      try {
        const verdict = await chain.verdictOf(row.tx_id, escrow);

        noteTx(escrow, row.tx_id, { source: "logs", verdict });
      } catch {
        /* retried next pass */
      }
    }
  }

  /**
   * Attach verified finalized provenance to pending outcome events, batch by
   * batch: every successful FINALIZED transaction for the escrow, not yet cited,
   * included at or before the snapshot that showed the outcome. Without one,
   * the event stays pending (and visible in the status API); it is never
   * mailed on contract state alone.
   */
  function resolveProvenance(escrow, scanNote) {
    const batches = db
      .prepare("SELECT DISTINCT batch FROM events WHERE lower(escrow) = lower(?) AND state = 'pending' ORDER BY CAST(batch AS INTEGER)")
      .all(escrow)
      .map((r) => r.batch);

    for (const batch of batches) {
      immediate(db, () => {
        const txs = db
          .prepare("SELECT tx_id, verdict_json FROM escrow_txs WHERE escrow = ? AND final = 1 AND ok = 1 AND cited_by IS NULL AND (evm_block IS NULL OR CAST(evm_block AS INTEGER) <= ?)")
          .all(escrow.toLowerCase(), Number(batch));

        if (!txs.length) {
          db.prepare("UPDATE events SET note = ? WHERE lower(escrow) = lower(?) AND batch = ? AND state = 'pending'").run(
            `waiting for a verified finalized transaction behind this result${scanNote ? ` (${scanNote})` : ""}`,
            escrow,
            batch,
          );

          return;
        }

        const provenance = txs.map((t) => ({ txId: t.tx_id, label: t.verdict_json ? JSON.parse(t.verdict_json).label : null }));

        for (const t of txs) db.prepare("UPDATE escrow_txs SET cited_by = ? WHERE escrow = ? AND tx_id = ?").run(batch, escrow.toLowerCase(), t.tx_id);

        db.prepare("UPDATE events SET state = 'ready', provenance_json = ?, note = NULL WHERE lower(escrow) = lower(?) AND batch = ? AND state = 'pending'").run(
          JSON.stringify(provenance),
          escrow,
          batch,
        );
      });
    }
  }

  const executor = createExecutor({ db, chain, chainConfig, account, config, planFresh, consentsActive, onEvent, log });

  const lastNonce = (escrow, signer) =>
    db.prepare("SELECT nonce FROM signer_nonces WHERE chain_id = ? AND lower(escrow) = lower(?) AND lower(signer) = lower(?)").get(chainId, escrow, signer)?.nonce ?? null;

  const bumpNonce = (escrow, signer, nonce) =>
    db
      .prepare("INSERT INTO signer_nonces (chain_id, escrow, signer, nonce) VALUES (?, ?, ?, ?) ON CONFLICT(chain_id, escrow, signer) DO UPDATE SET nonce = excluded.nonce")
      .run(chainId, escrow, signer, nonce);

  /** Cancel queued (unsigned) jobs no longer covered by an active consent. */
  function cancelUncovered(escrow) {
    const queued = db.prepare("SELECT * FROM jobs WHERE lower(escrow) = lower(?) AND state = 'queued'").all(escrow);
    let cancelled = 0;

    for (const job of queued) {
      if (!consentsActive(JSON.parse(job.consent_ids), job.scope)) {
        cancelled += db
          .prepare("UPDATE jobs SET state = 'cancelled', last_error = 'consent revoked before signing', updated_at = ? WHERE id = ? AND state = 'queued'")
          .run(now(), job.id).changes;
      }
    }

    return cancelled;
  }

  return {
    executor,

    async addConsent(submission) {
      const escrow = submission?.escrow;
      let parties;

      try {
        parties = await chain.parties(escrow);
      } catch (error) {
        throw new ConsentError(`escrow could not be read: ${String(error?.message || error).slice(0, 120)}`);
      }

      if (parties.interface_id !== EXPECTED_INTERFACE) throw new ConsentError(`unsupported escrow interface ${parties.interface_id}`);

      const signer = submission?.message?.signer;
      const consent = await verifyConsent(submission, { chainId, parties, now: now(), lastNonce: lastNonce(escrow, signer) });
      const token = randomBytes(24).toString("hex");

      const id = immediate(db, () => {
        if (lastNonce(consent.escrow, consent.signer) !== null && BigInt(consent.nonce) <= BigInt(lastNonce(consent.escrow, consent.signer))) {
          throw new ConsentError("nonce already used");
        }

        bumpNonce(consent.escrow, consent.signer, consent.nonce);

        const res = db
          .prepare(
            `INSERT INTO consents (chain_id, escrow, signer, role, scopes, max_amount, nonce, expires_at, email, verify_token, digest, signature, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(chainId, consent.escrow, consent.signer, consent.role, consent.scopes, consent.maxAmount, consent.nonce, consent.expiresAt, consent.email, token, consent.digest, submission.signature, now());

        const mail = verificationEmail({ email: consent.email, token, escrow: consent.escrow, apiUrl: config.publicApiUrl, scopesText: scopesText(consent.scopes) });

        db.prepare("INSERT OR IGNORE INTO outbox (event_key, email, subject, body, created_at) VALUES (?, ?, ?, ?, ?)").run(`verify:${res.lastInsertRowid}`, mail.email, mail.subject, mail.body, now());

        return Number(res.lastInsertRowid);
      });

      log("info", "consent recorded", { id, escrow: consent.escrow, role: consent.role, scopes: consent.scopes });

      return { id, escrow: consent.escrow, role: consent.role, scopes: scopesText(consent.scopes), expiresAt: consent.expiresAt, email: maskEmail(consent.email), emailVerified: false };
    },

    verifyEmail(token) {
      if (!/^[0-9a-f]{48}$/.test(String(token))) return false;

      return db.prepare("UPDATE consents SET email_verified = 1, verify_token = NULL WHERE verify_token = ?").run(token).changes === 1;
    },

    async revoke(submission) {
      const signer = submission?.message?.signer;
      const revoke = await verifyRevoke(submission, { chainId, now: now(), lastNonce: lastNonce(submission?.escrow, signer) });

      return immediate(db, () => {
        bumpNonce(revoke.escrow, revoke.signer, revoke.nonce);

        const revoked = db
          .prepare("UPDATE consents SET revoked_at = ? WHERE chain_id = ? AND lower(escrow) = lower(?) AND lower(signer) = lower(?) AND revoked_at IS NULL")
          .run(now(), chainId, revoke.escrow, revoke.signer).changes;
        const cancelled = cancelUncovered(revoke.escrow);
        const continuing = db
          .prepare("SELECT count(*) AS n FROM jobs WHERE lower(escrow) = lower(?) AND state IN ('signing','signed','broadcast','tracking')")
          .get(revoke.escrow).n;

        return {
          revoked,
          cancelledQueuedJobs: cancelled,
          alreadySignedJobsStillTracked: continuing,
          note: "Queued steps that were not yet signed are cancelled. A step already signed or broadcast cannot be recalled; it is tracked to its final result.",
        };
      });
    },

    /** One pass: watch, notify, plan, execute, deliver. */
    async tick() {
      const escrows = db
        .prepare("SELECT DISTINCT escrow FROM consents WHERE chain_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT ?")
        .all(chainId, now(), config.maxEscrows)
        .map((r) => r.escrow);

      for (const escrow of escrows) {
        try {
          cancelUncovered(escrow);

          const snapshot = await chain.snapshot(escrow);

          if (snapshot.finality !== "final") throw new Error("non-final contract state; nothing is planned or reported from it");

          let scanNote = null;

          try {
            await scanTransactions(escrow, snapshot.block);
          } catch (error) {
            scanNote = `transaction log search unavailable: ${String(error?.shortMessage || error?.message || error).slice(0, 120)}`;
          }

          await refreshVerdicts(escrow);

          const stored = db.prepare("SELECT json FROM snapshots WHERE lower(escrow) = lower(?)").get(escrow);
          const before = stored ? JSON.parse(stored.json) : null;
          const changed = before && snapshot.milestones.some((m, i) => before.milestones[i]?.status !== m.status);
          const attempts = changed ? await chain.attempts(escrow, snapshot.milestones.length).catch(() => []) : [];

          // Outcomes from finalized state only; mailed after provenance is verified.
          for (const event of diffEvents(escrow, before, snapshot, attempts)) createEvent(db, event, { state: "pending", batch: snapshot.block }, now());

          db.prepare("INSERT INTO snapshots (escrow, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(escrow) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(
            escrow,
            JSON.stringify(snapshot, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
            now(),
          );

          resolveProvenance(escrow, scanNote);

          const consents = activeConsents(escrow).map((c) => ({ id: c.id, scopes: c.scopes, maxAmount: c.max_amount, role: c.role }));

          for (const plan of planActions(snapshot, consents)) {
            if (enqueue(db, { chainId, escrow }, plan, now())) log("info", "queued", { escrow, key: plan.key });
          }
        } catch (error) {
          log("warn", "escrow pass failed", { escrow, error: String(error?.message || error).slice(0, 200) });
        }
      }

      await executor.runOnce(now());

      fanOut(db, notifyCtx, now());

      if (transport) await deliverOutbox(db, transport, config, { owner: processId });
    },

    /** Public view: no email, signature, raw transaction or key material. */
    async publicStatus(escrow) {
      const jobs = db
        .prepare("SELECT * FROM jobs WHERE chain_id = ? AND lower(escrow) = lower(?) ORDER BY id DESC LIMIT 100")
        .all(chainId, escrow)
        .map((j) => publicJob(j, { sendingEnabled: config.sendingEnabled, hasKey: Boolean(account) }));
      const consents = db
        .prepare("SELECT id, role, scopes, max_amount, expires_at, email, email_verified, revoked_at, created_at FROM consents WHERE chain_id = ? AND lower(escrow) = lower(?) ORDER BY id DESC")
        .all(chainId, escrow)
        .map((c) => ({
          id: c.id,
          role: c.role,
          scopes: scopesText(c.scopes),
          maxAmount: c.max_amount,
          expiresAt: c.expires_at,
          email: maskEmail(c.email),
          emailVerified: Boolean(c.email_verified),
          active: !c.revoked_at && c.expires_at > now(),
          revokedAt: c.revoked_at,
        }));
      const stored = db.prepare("SELECT json FROM snapshots WHERE lower(escrow) = lower(?)").get(escrow);
      const snapshot = stored ? JSON.parse(stored.json) : null;

      for (const job of jobs) {
        if (job.state === "tracking" && job.glTxId && chain.finalityWindow) {
          job.finalityWindow = await chain.finalityWindow(job.glTxId).catch(() => ({ available: false }));
        }
      }

      const notifications = db
        .prepare("SELECT kind, state, note, created_at FROM events WHERE lower(escrow) = lower(?) ORDER BY id DESC LIMIT 50")
        .all(escrow)
        .map((e) => ({ kind: e.kind, state: e.state, note: e.note, createdAt: e.created_at }));

      return {
        escrow,
        chainId,
        notifications,
        sendingEnabled: config.sendingEnabled,
        operator: account?.address || null,
        consents,
        jobs,
        expected: snapshot ? nextExpected(snapshot) : [],
        observedAt: snapshot ? snapshot.chainTime : null,
      };
    },

    info() {
      return {
        chainId,
        network: config.network,
        operator: account?.address || null,
        sendingEnabled: config.sendingEnabled && Boolean(account),
        scopes: SCOPE_NAMES,
        limits: {
          maxGas: config.maxGas.toString(),
          maxGasPriceWei: config.maxGasPriceWei.toString(),
          maxFeePerTxWei: config.maxFeePerTxWei.toString(),
          dailyBudgetWei: config.dailyBudgetWei.toString(),
          maxAttempts: config.maxAttempts,
        },
      };
    },
  };
}

const STATE_TEXT = {
  queued: "Queued",
  signing: "Signing (nonce and fields reserved)",
  signed: "Signed; broadcasting the stored transaction",
  broadcast: "Broadcast; waiting for the EVM receipt",
  tracking: "In GenLayer consensus; waiting for finality",
  done: "Finalized with successful execution",
  failed: "Failed",
  blocked: "Stopped (cap or permanent error)",
  cancelled: "Cancelled before signing",
  obsolete: "No longer needed",
  conflict: "Stopped: needs operator attention",
};

export function publicJob(j, { sendingEnabled, hasKey }) {
  let eta = null;

  if (j.state === "queued") {
    eta = !sendingEnabled || !hasKey ? "Waiting: the service is in tracking-only mode" : j.next_attempt_at > nowSeconds() ? `Next attempt at ${new Date(j.next_attempt_at * 1000).toISOString()}` : "Next service pass (about 15 s)";
  } else if (j.state === "signed" || j.state === "broadcast") {
    eta = "Usually included in an EVM block within a minute";
  } else if (j.state === "tracking") {
    eta = "Consensus and the finality window; see finalityWindow";
  }

  return {
    id: j.id,
    step: j.function_name,
    args: JSON.parse(j.args_json),
    scope: SCOPE_NAMES[j.scope] || j.scope,
    reason: j.reason,
    state: j.state,
    status: STATE_TEXT[j.state] || j.state,
    terminal: TERMINAL.has(j.state),
    attempts: j.attempts,
    evmHash: j.evm_hash,
    glTxId: j.gl_tx_id,
    verdict: j.verdict_json ? JSON.parse(j.verdict_json) : null,
    lastError: j.last_error,
    eta,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

export { lower };
