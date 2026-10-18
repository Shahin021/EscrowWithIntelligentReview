import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createTransport, deliverOutbox } from "../src/mailer.js";
import { SCOPES } from "../src/consent.js";
import { diffEvents } from "../src/notifier.js";
import { CLIENT, ESCROW, NOW, OPERATOR, STRANGER, WORKER, baseConfig, fakeChain, milestone, signConsent, signRevoke, snapshot, tempDb } from "./helpers.js";

describe("notifications come from contract outcomes, once, to confirmed addresses", () => {
  it("first sight invents no history; a status change produces one event", () => {
    const before = snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 1 }), milestone(1)] });
    const after = snapshot({ milestones: [milestone(0, { status: "REVISION_REQUIRED", attemptCount: 1, revisionCount: 1 }), milestone(1)] });
    assert.deepEqual(diffEvents(ESCROW, null, after), []);
    const [e] = diffEvents(ESCROW, before, after, [{ milestone: 0, verdict: "REJECTED", reason: "Missing load test.", criteriaBits: "10" }]);
    assert.equal(e.kind, "revision_required");
    assert.equal(e.payload.reason, "Missing load test.");
  });

  it("payment completed is reported only from RELEASED with a CONFIRMED payout", () => {
    const before = snapshot({ milestones: [milestone(0, { status: "PAYMENT_PENDING" }), milestone(1)] });
    const after = snapshot({
      milestones: [milestone(0, { status: "RELEASED" }), milestone(1)],
      outflows: [{ id: 0, kind: "MILESTONE_PAYOUT", status: "CONFIRMED", amount: "1000", recipient: WORKER.address, milestone: 0 }],
    });
    const [e] = diffEvents(ESCROW, before, after);
    assert.equal(e.kind, "payment_completed");
    assert.equal(e.payload.outflow.amount, "1000");
  });

  it("end to end: verification mail first; outcome mail only after confirming; duplicates suppressed; written to the file outbox", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 1 }), milestone(1)] }) });
    const config = baseConfig({ sendingEnabled: false, mailTransport: "file", mailOutboxDir: join(t.dir, "outbox"), mailFrom: "test@localhost" });
    const transport = await createTransport(config);
    const service = createService({ db: t.db, chain, account: null, config, transport, now: () => NOW });

    await service.addConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.REVIEW, email: "client@example.com" }));
    await service.addConsent(await signConsent(STRANGER, { role: "observer", scopes: SCOPES.REVIEW, email: "watcher@example.com" }));
    await service.tick();

    let files = readdirSync(config.mailOutboxDir);
    assert.equal(files.length, 2, "only the two verification emails");
    const token = readFileSync(join(config.mailOutboxDir, files[0]), "utf8").match(/token=([0-9a-f]{48})/)[1];
    assert.equal(service.verifyEmail(token), true);
    assert.equal(service.verifyEmail(token), false, "single use");

    // The worker's submission and someone's review, both final and successful.
    chain.external({ call: ["submit_deliverable", 0, "https://x.org/e", ""] });
    chain.external({ call: ["resolve", 0] });
    chain.snap = snapshot({ milestones: [milestone(0, { status: "APPROVED", attemptCount: 1 }), milestone(1)] });
    await service.tick();
    await service.tick();
    files = readdirSync(config.mailOutboxDir);
    assert.equal(files.length, 3, "one approval email, to the confirmed address only");
    const mail = readFileSync(join(config.mailOutboxDir, files.sort().at(-1)), "utf8");
    assert.match(mail, /To: client@example\.com/);
    assert.match(mail, /Milestone 1 · status APPROVED/);
    assert.match(mail, /finalized state\. No transaction is named as its cause/);
    assert.doesNotMatch(mail, /tx\/0x/);
    assert.equal(await deliverOutbox(t.db, transport, config), 0, "nothing left to send");
  });
});

describe("HTTP API", () => {
  async function serve() {
    const t = tempDb();
    const chain = fakeChain({ snap: snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 1 }), milestone(1)] }) });
    const config = baseConfig({ allowedOrigins: ["http://site"] });
    const service = createService({ db: t.db, chain, account: OPERATOR, config, transport: null, now: () => NOW });
    const { server } = createApi(service, config);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { t, chain, service, server, base };
  }

  it("records a signed consent, reports status without secrets, accepts a revocation, refuses junk", async () => {
    const s = await serve();
    try {
      const signed = await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW, email: "worker.private@example.com" });
      let res = await fetch(`${s.base}/v1/consents`, { method: "POST", headers: { "content-type": "application/json", origin: "http://site" }, body: JSON.stringify(signed) });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("access-control-allow-origin"), "http://site");
      const created = await res.json();
      assert.equal(created.email.includes("worker.private"), false);

      res = await fetch(`${s.base}/v1/consents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
      assert.equal(res.status, 400, "replay refused");

      await s.service.tick();
      const statusText = await (await fetch(`${s.base}/v1/projects/${ESCROW}`)).text();
      const raw = s.t.db.prepare("SELECT raw_tx FROM jobs").get().raw_tx;
      assert.ok(!statusText.includes(raw.slice(2, 80)));
      assert.ok(!statusText.includes(signed.signature.slice(2, 60)));
      assert.ok(!statusText.includes("worker.private"));
      const status = JSON.parse(statusText);
      assert.equal(status.jobs[0].step, "resolve");
      assert.equal(status.jobs[0].state, "broadcast");

      res = await fetch(`${s.base}/v1/revocations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await signRevoke(WORKER, { nonce: 2 })) });
      assert.equal(res.status, 200);
      assert.match((await res.json()).note, /cannot be recalled/);

      assert.equal((await fetch(`${s.base}/v1/consents`, { method: "POST", body: "{nope" })).status, 400);
      assert.equal((await fetch(`${s.base}/v1/consents`, { method: "POST", body: "x".repeat(20000) })).status, 413);
      assert.equal((await fetch(`${s.base}/v1/nothing`)).status, 404);
      const info = await (await fetch(`${s.base}/v1/info`)).json();
      assert.equal(info.operator, OPERATOR.address);
    } finally {
      s.server.close();
    }
  });
});
