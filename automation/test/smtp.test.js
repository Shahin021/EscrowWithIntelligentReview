// SMTP transport against a minimal local SMTP server (no external network, no real mail).
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import { createTransport, deliverOutbox } from "../src/mailer.js";
import { tempDb } from "./helpers.js";

function smtpServer() {
  const received = [];
  const server = createServer((socket) => {
    let data = false;
    let buffer = "";
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === ".") { data = false; socket.write("250 queued\r\n"); } else received.at(-1).body.push(line);
          continue;
        }
        if (/^(EHLO|HELO)/i.test(line)) socket.write("250 test\r\n");
        else if (/^MAIL FROM/i.test(line)) { received.push({ from: line, rcpt: [], body: [] }); socket.write("250 ok\r\n"); }
        else if (/^RCPT TO/i.test(line)) { received.at(-1).rcpt.push(line); socket.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { data = true; socket.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port })));
}

describe("SMTP transport (optional nodemailer, pinned)", () => {
  it("delivers an outbox row through SMTP and records it as sent", async () => {
    const smtp = await smtpServer();
    try {
      const config = { mailTransport: "smtp", smtpUrl: `smtp://127.0.0.1:${smtp.port}?ignoreTLS=true`, mailFrom: "Escrow <no-reply@example.com>" };
      const transport = await createTransport(config);
      assert.equal(transport.name, "smtp");
      const t = tempDb();
      t.db.prepare("INSERT INTO outbox (event_key, email, subject, body, created_at) VALUES ('e1', 'user@example.com', 'Payment completed · پرداخت تکمیل شد', 'body line', 1)").run();
      assert.equal(await deliverOutbox(t.db, transport, config), 1);
      assert.equal(t.db.prepare("SELECT state FROM outbox").get().state, "sent");
      assert.equal(smtp.received.length, 1);
      assert.match(smtp.received[0].rcpt[0], /user@example\.com/);
    } finally {
      smtp.server.close();
    }
  });

  it("an unreachable server leaves the row pending for a retry", async () => {
    const config = { mailTransport: "smtp", smtpUrl: "smtp://127.0.0.1:9?connectionTimeout=500", mailFrom: "x@example.com" };
    const transport = await createTransport(config);
    const t = tempDb();
    t.db.prepare("INSERT INTO outbox (event_key, email, subject, body, created_at) VALUES ('e1', 'user@example.com', 's', 'b', 1)").run();
    assert.equal(await deliverOutbox(t.db, transport, config), 0);
    const row = t.db.prepare("SELECT state, attempts FROM outbox").get();
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 1);
  });
});
