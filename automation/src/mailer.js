/**
 * Email delivery from the outbox, with retries.
 *
 *   file  (default) each message is written as an .eml file to MAIL_OUTBOX_DIR;
 *         nothing leaves the machine
 *   smtp  real delivery through nodemailer (an optional dependency the
 *         operator installs); used only when MAIL_TRANSPORT=smtp
 *   none  messages are kept in the outbox, never delivered
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nowSeconds } from "./db.js";

export async function createTransport(config) {
  if (config.mailTransport === "file") {
    mkdirSync(config.mailOutboxDir, { recursive: true });

    return {
      name: "file",
      async send({ id, from, to, subject, body }) {
        const file = join(config.mailOutboxDir, `${String(id).padStart(6, "0")}.eml`);

        writeFileSync(
          file,
          [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", body, ""].join("\r\n"),
        );
      },
    };
  }

  if (config.mailTransport === "smtp") {
    let nodemailer;

    try {
      nodemailer = (await import("nodemailer")).default;
    } catch {
      throw new Error("MAIL_TRANSPORT=smtp needs the optional package nodemailer (npm install nodemailer).");
    }

    const transport = nodemailer.createTransport(config.smtpUrl);

    return {
      name: "smtp",
      async send({ from, to, subject, body }) {
        await transport.sendMail({ from, to, subject, text: body });
      },
    };
  }

  return { name: "none", send: null };
}

export async function deliverOutbox(db, transport, config, { limit = 20 } = {}) {
  if (!transport.send) return 0;

  const now = nowSeconds();
  const rows = db.prepare("SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?").all(now, limit);
  let sent = 0;

  for (const row of rows) {
    // Claim the row first, so a second process does not send it too.
    const claim = db.prepare("UPDATE outbox SET state = 'sending' WHERE id = ? AND state = 'pending'").run(row.id);

    if (claim.changes !== 1) continue;

    try {
      await transport.send({ id: row.id, from: config.mailFrom, to: row.email, subject: row.subject, body: row.body });
      db.prepare("UPDATE outbox SET state = 'sent', sent_at = ? WHERE id = ?").run(nowSeconds(), row.id);
      sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;

      db.prepare("UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?").run(
        attempts >= 8 ? "failed" : "pending",
        attempts,
        nowSeconds() + Math.min(3600, 30 * 2 ** attempts),
        String(error?.message || error).slice(0, 200),
        row.id,
      );
    }
  }

  return sent;
}
