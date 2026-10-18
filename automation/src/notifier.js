/**
 * Notifications: contract outcomes and job results become events (deduplicated
 * by key), and each event becomes one email per verified subscriber.
 *
 * Outcomes are read from the contract, never inferred from a job: "approved"
 * means the milestone status is APPROVED, "paid" means RELEASED with a
 * CONFIRMED payout, "refunded" means REFUNDED with a CONFIRMED refund.
 */

import { nowSeconds } from "./db.js";

/* Outcome emails are built only from FINALIZED contract state (the service
 * reads "latest-final") and carry the finalized transactions behind them. */

const short = (a) => `${String(a).slice(0, 8)}…${String(a).slice(-6)}`;

const STATUS_EVENTS = {
  APPROVED: "review_approved",
  REVISION_REQUIRED: "revision_required",
  REJECTED_FINAL: "review_rejected",
  EVIDENCE_UNAVAILABLE: "evidence_unavailable",
  RELEASED: "payment_completed",
  REFUNDED: "refund_completed",
};

/** Events from the difference between two snapshots of one escrow. */
export function diffEvents(escrow, before, after, attempts = []) {
  if (!before) return []; // first sight: no history is invented from current state

  const events = [];
  const latest = (m) => [...attempts].reverse().find((a) => a.milestone === m && a.verdict !== "PENDING") || null;

  after.milestones.forEach((m, i) => {
    const prev = before.milestones[i];

    if (!prev || prev.status === m.status) return;

    const kind = STATUS_EVENTS[m.status];

    if (!kind) return;

    const attempt = latest(i);
    const outflow =
      kind === "payment_completed" || kind === "refund_completed"
        ? after.outflows.find((o) => o.milestone === i && o.status === "CONFIRMED" && (kind === "payment_completed" ? o.kind === "MILESTONE_PAYOUT" : o.kind !== "MILESTONE_PAYOUT"))
        : null;

    events.push({
      key: `${escrow.toLowerCase()}:m${i}:${m.status}:${m.attemptCount}:${m.revisionCount}`,
      escrow,
      kind,
      payload: {
        milestone: i,
        status: m.status,
        amount: m.amount,
        reason: attempt?.reason || null,
        criteriaBits: attempt?.criteriaBits || null,
        recoveryDeadline: m.evidenceRecoveryDeadline,
        appealExpiry: m.appealExpiry,
        outflow: outflow ? { id: outflow.id, amount: outflow.amount, recipient: outflow.recipient } : null,
      },
    });
  });

  if (before.project.status !== after.project.status && ["ACTIVE", "CLOSED"].includes(after.project.status)) {
    events.push({ key: `${escrow.toLowerCase()}:project:${after.project.status}`, escrow, kind: `project_${after.project.status.toLowerCase()}`, payload: {} });
  }

  return events;
}

/** Events for job transitions the user should hear about. */
export function jobEvent({ kind, job }) {
  const notable = {
    job_done: "step_completed",
    job_failed: "step_failed",
    job_blocked: "step_blocked",
    job_conflict: "step_needs_operator",
    budget_paused: "automation_paused",
  }[kind];

  if (!notable || !job) return null;

  const dayKey = kind === "budget_paused" ? `:${new Date().toISOString().slice(0, 10)}` : "";

  return {
    key: `${job.escrow.toLowerCase()}:job${job.id}:${notable}${dayKey}`,
    escrow: job.escrow,
    kind: notable,
    payload: {
      job: job.id,
      functionName: job.function_name,
      args: JSON.parse(job.args_json),
      error: job.last_error || null,
      verdict: job.verdict_json ? JSON.parse(job.verdict_json) : null,
      glTxId: job.gl_tx_id,
      evmHash: job.evm_hash,
    },
  };
}

const TITLES = {
  review_approved: ["Milestone approved", "مرحله تأیید شد"],
  revision_required: ["Revision required", "نیاز به اصلاح"],
  review_rejected: ["Milestone rejected", "مرحله رد شد"],
  evidence_unavailable: ["Evidence could not be read", "مدرک قابل خواندن نبود"],
  payment_completed: ["Payment completed", "پرداخت تکمیل شد"],
  refund_completed: ["Refund completed", "بازپرداخت تکمیل شد"],
  project_active: ["Project funded and active", "پروژه تأمین و فعال شد"],
  project_closed: ["Project closed", "پروژه بسته شد"],
  step_completed: ["Automatic step finalized", "مرحلهٔ خودکار نهایی شد"],
  step_failed: ["Automatic step failed", "مرحلهٔ خودکار ناموفق بود"],
  step_blocked: ["Automatic step stopped", "مرحلهٔ خودکار متوقف شد"],
  step_needs_operator: ["Automatic step needs attention", "مرحلهٔ خودکار نیاز به بررسی دارد"],
  automation_paused: ["Automation paused (budget)", "اتوماسیون متوقف شد (بودجه)"],
};

export function renderEmail(event, { siteUrl, explorer }) {
  const [en, fa] = TITLES[event.kind] || [event.kind, event.kind];
  const p = event.payload;
  const link = `${siteUrl}?project=${event.escrow}`;
  const lines = [];

  if (p.milestone !== undefined) lines.push(`Milestone ${p.milestone + 1} · status ${p.status}`);
  if (p.reason) lines.push(`Reason (from the consensus review): ${p.reason}`);
  if (p.criteriaBits) lines.push(`Per-criterion results: ${p.criteriaBits.split("").map((b, i) => `#${i + 1} ${b === "1" ? "met" : "not met"}`).join(", ")}`);
  if (p.outflow) lines.push(`Transfer #${p.outflow.id}: ${p.outflow.amount} wei to ${p.outflow.recipient} (CONFIRMED by the contract)`);
  if (event.kind === "evidence_unavailable" && Number(p.recoveryDeadline) > 0) {
    lines.push(`Evidence recovery opens at ${new Date(Number(p.recoveryDeadline) * 1000).toISOString()} (chain time).`);
  }
  if (event.kind === "review_rejected" && Number(p.appealExpiry) > 0) {
    lines.push(`Appeal window closes at ${new Date(Number(p.appealExpiry) * 1000).toISOString()}. Appealing is the worker's own decision; the service never appeals.`);
  }
  if (p.functionName) lines.push(`Step: ${p.functionName}(${(p.args || []).join(", ")})`);
  if (p.verdict?.label) lines.push(`Result: ${p.verdict.label}`);
  if (p.error) lines.push(`Detail: ${p.error}`);
  if (p.glTxId) lines.push(`GenLayer transaction: ${explorer}tx/${p.glTxId}`);
  if (event.kind === "automation_paused") lines.push("The daily budget is used up. Every action remains available manually on the site.");
  if (event.kind === "step_needs_operator") lines.push("The service stopped this step and will not send another transaction for it. The operator has been alerted.");

  if (event.provenance?.length) {
    lines.push("", "Finalized transactions for this project behind this result (each FINALIZED with successful execution and consensus agreement):");
    for (const p of event.provenance) lines.push(`  ${explorer}tx/${p.txId}${p.label ? ` — ${p.label}` : ""}`);
  }

  return {
    subject: `[Escrow ${short(event.escrow)}] ${en} · ${fa}`,
    body: [
      `${en} — ${fa}`,
      "",
      `Project: ${event.escrow}`,
      ...lines,
      "",
      `Open the project: ${link}`,
      "",
      "You receive this because you enabled notifications for this project. Manage or revoke automation on the project page.",
    ].join("\n"),
  };
}

export const FAN_OUT_DAYS = 14;

/**
 * Store an event once. Outcome events start "pending": they are only mailed
 * after verified finalized provenance is attached (resolveProvenance in the
 * service). Job events carry their own transaction and start "ready".
 */
export function createEvent(db, event, { state = "pending", batch = null, provenance = null, note = null } = {}, now = nowSeconds()) {
  return (
    db
      .prepare("INSERT OR IGNORE INTO events (key, escrow, kind, payload_json, state, batch, provenance_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(event.key, event.escrow, event.kind, JSON.stringify(event.payload), state, batch, provenance ? JSON.stringify(provenance) : null, note, now).changes === 1
  );
}

/**
 * Mail every ready event (younger than FAN_OUT_DAYS) to every confirmed,
 * active subscriber of its escrow that has not received it yet. Running this
 * every pass means a subscriber who confirms later still gets recent results,
 * and nothing is lost to a restart.
 */
export function fanOut(db, { siteUrl, explorer, chainId }, now = nowSeconds()) {
  const events = db.prepare("SELECT * FROM events WHERE state = 'ready' AND created_at >= ?").all(now - FAN_OUT_DAYS * 86400);
  const insert = db.prepare("INSERT OR IGNORE INTO outbox (event_key, email, subject, body, created_at) VALUES (?, ?, ?, ?, ?)");
  let queued = 0;

  for (const row of events) {
    const recipients = db
      .prepare(
        `SELECT DISTINCT email FROM consents
         WHERE chain_id = ? AND lower(escrow) = lower(?) AND email_verified = 1 AND revoked_at IS NULL AND expires_at > ?`,
      )
      .all(chainId, row.escrow, now);

    if (!recipients.length) continue;

    const event = { key: row.key, escrow: row.escrow, kind: row.kind, payload: JSON.parse(row.payload_json), provenance: row.provenance_json ? JSON.parse(row.provenance_json) : [] };
    const { subject, body } = renderEmail(event, { siteUrl, explorer });

    for (const r of recipients) queued += insert.run(row.key, r.email, subject, body, now).changes;
  }

  return queued;
}

export function verificationEmail({ email, token, escrow, apiUrl, scopesText }) {
  return {
    email,
    subject: `[Escrow ${short(escrow)}] Confirm your email · تأیید ایمیل`,
    body: [
      "Confirm that you want notifications and the automation you selected for this project:",
      `Project: ${escrow}`,
      `Selected steps: ${scopesText}`,
      "",
      `${apiUrl}/v1/verify?token=${token}`,
      "",
      "If you did not request this, ignore this email; nothing will be sent or automated.",
    ].join("\n"),
  };
}
