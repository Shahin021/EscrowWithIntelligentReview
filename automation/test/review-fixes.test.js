// Regressions for docs/AUTOMATION_V3_REVIEW findings 1-4.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDb } from "../src/db.js";
import { createService } from "../src/service.js";
import { createChain } from "../src/chain.js";
import { createTransport } from "../src/mailer.js";
import { planActions } from "../src/planner.js";
import { SCOPES } from "../src/consent.js";
import { CHAIN, CLIENT, ESCROW, NOW, OPERATOR, WORKER, baseConfig, fakeChain, milestone, signConsent, snapshot, tempDb } from "./helpers.js";

const grantW = { client: null, worker: { max_amount: "1000", expires_at: String(NOW + 86400) } };
const jobs = (db) => db.prepare("SELECT * FROM jobs ORDER BY id").all();

async function make({ chain, dbFile, config = {}, account = OPERATOR, mail = false, dir }) {
  const db = dbFile ? openDb(dbFile) : tempDb().db;
  const cfg = baseConfig({ ...config, ...(mail ? { mailTransport: "file", mailOutboxDir: join(dir, "outbox"), mailFrom: "t@localhost" } : {}) });
  const transport = mail ? await createTransport(cfg) : null;
  const service = createService({ db, chain, account, config: cfg, transport, now: () => NOW });

  return { db, service, cfg };
}

const review = (attempt = 1) => snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: attempt }), milestone(1)], grants: grantW });
const approved = () => snapshot({ milestones: [milestone(0, { status: "APPROVED", attemptCount: 1 }), milestone(1)], grants: grantW });

describe("1. dependent steps wait for a finalized, successful predecessor", () => {
  it("the service reads finalized contract state (latest-final), never the SDK default", async () => {
    const calls = [];
    const gl = {
      readContract: async (args) => {
        calls.push(args.transactionHashVariant);
        const values = { parties: { interface_id: "genlayer.milestone-escrow.v2", client: CLIENT.address, worker: WORKER.address, project_status: "ACTIVE", milestone_count: "1", total_required: "1", total_funded: "1", total_released: "0", total_refunded: "0" },
          get_accounting: {}, get_settlement: {}, get_outflow_count: "0" };
        return values[args.functionName] ?? "0";
      },
    };
    const evm = { getBlock: async () => ({ number: 5n, timestamp: 100n }), getBalance: async () => 0n };
    const s = await createChain({ network: "testnetBradbury" }, { gl, evm }).snapshot(ESCROW);
    assert.equal(s.finality, "final");
    assert.ok(calls.length > 5);
    assert.ok(calls.every((v) => v === "latest-final"), JSON.stringify([...new Set(calls)]));
  });

  it("the planner refuses non-final state", () => {
    assert.throws(() => planActions({ ...approved(), finality: "nonfinal" }, [{ id: 1, scopes: 15, maxAmount: "9999" }]), /non-final/);
  });

  it("our resolve is ACCEPTED (not final): no claim is planned or sent while finalized state still says UNDER_REVIEW", async () => {
    const chain = fakeChain({ snap: review() });
    const h = await make({ chain });
    await h.service.addConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW | SCOPES.SETTLE }));
    await h.service.tick();
    chain.genlayerResult = () => ({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE" });
    chain.mine();
    // The non-final view would already say APPROVED; the finalized view (all the service reads) does not.
    for (let i = 0; i < 3; i += 1) await h.service.tick();
    assert.deepEqual(jobs(h.db).map((j) => [j.function_name, j.state]), [["resolve", "tracking"]]);
    assert.equal(new Set(chain.sent).size, 1);
  });

  it("even when finalized state already shows APPROVED, the claim waits until our resolve job is itself finalized", async () => {
    const chain = fakeChain({ snap: review() });
    const h = await make({ chain });
    await h.service.addConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW | SCOPES.SETTLE }));
    await h.service.tick();
    chain.genlayerResult = () => ({ statusName: "ACCEPTED", resultName: "AGREE" });
    chain.mine();
    chain.snap = approved();
    await h.service.tick();
    await h.service.tick();
    const claim = jobs(h.db).find((j) => j.function_name === "claim_payment");
    assert.equal(claim.state, "queued", "planned but not signed");
    assert.equal(new Set(chain.sent).size, 1);

    const resolve = jobs(h.db).find((j) => j.function_name === "resolve");
    chain.glTxs.set(resolve.gl_tx_id, { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE" });
    await h.service.tick(); // resolve -> done
    await h.service.tick(); // claim may now proceed
    assert.equal(jobs(h.db).find((j) => j.function_name === "claim_payment").state, "broadcast");
    assert.equal(new Set(chain.sent).size, 2);
  });

  it("a predecessor that finally fails leaves finalized state unchanged: no dependent send ever", async () => {
    const chain = fakeChain({ snap: review() });
    const h = await make({ chain });
    await h.service.addConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW | SCOPES.SETTLE }));
    await h.service.tick();
    chain.mine({ glResult: () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", resultName: "AGREE" }) });
    for (let i = 0; i < 3; i += 1) await h.service.tick();
    assert.deepEqual(jobs(h.db).map((j) => [j.function_name, j.state]), [["resolve", "failed"]]);
    assert.equal(new Set(chain.sent).size, 1);
  });

  it("an external wallet's ACCEPTED resolve does not lead to a dependent send", async () => {
    const chain = fakeChain({ snap: review() });
    const h = await make({ chain });
    await h.service.addConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.SETTLE })); // no REVIEW: the worker runs it
    chain.external({ status: "ACCEPTED" });
    for (let i = 0; i < 3; i += 1) await h.service.tick();
    assert.equal(jobs(h.db).length, 0);
    assert.equal(chain.sent.length, 0);
  });
});

describe("Codex r2 #2: one in-flight step per escrow, decided atomically", () => {
  async function race({ escrows = [ESCROW, ESCROW] } = {}) {
    const { createExecutor, enqueue } = await import("../src/executor.js");
    const t = tempDb();
    const db2 = openDb(t.path);
    const chain = fakeChain();
    const plans = [
      { key: "resolve:0:1", functionName: "resolve", args: [0], scope: SCOPES.REVIEW, amount: "0", reason: "r", consentIds: [1] },
      { key: "mark_review_stalled:0:1", functionName: "mark_review_stalled", args: [0], scope: SCOPES.RECOVER, amount: "0", reason: "s", consentIds: [1] },
    ];
    plans.forEach((p, i) => enqueue(t.db, { chainId: CHAIN.id, escrow: escrows[i] }, p, NOW));
    let arrivals = 0;
    let release;
    const barrier = new Promise((r) => { release = r; });
    chain.estimateGas = async () => { if (++arrivals === 2) release(); await barrier; return 200_000n; };
    const opts = { chain, chainConfig: CHAIN, account: OPERATOR, config: baseConfig(), planFresh: async () => plans, consentsActive: () => true };
    const a = createExecutor({ ...opts, db: t.db });
    const b = createExecutor({ ...opts, db: db2 });
    await Promise.all([a.step(t.db.prepare("SELECT * FROM jobs WHERE id = 1").get(), NOW), b.step(db2.prepare("SELECT * FROM jobs WHERE id = 2").get(), NOW)]);
    return { t, db2, chain, a, b, rows: () => t.db.prepare("SELECT id, function_name, state, nonce FROM jobs ORDER BY id").all() };
  }

  it("two processes racing DIFFERENT steps of the SAME escrow: only one is reserved and broadcast", async () => {
    const r = await race();
    const states = r.rows().map((j) => j.state).sort();
    assert.deepEqual(states, ["broadcast", "queued"]);
    assert.equal(r.chain.sent.length, 1);
  });

  it("the waiting step proceeds only after the first is final; a failed final verdict also releases it, once", async () => {
    for (const glResult of [
      () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE" }),
      () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", resultName: "AGREE" }),
    ]) {
      const r = await race();
      r.chain.estimateGas = async () => 200_000n;
      r.chain.genlayerResult = () => ({ statusName: "ACCEPTED", resultName: "AGREE" });
      r.chain.mine();
      await r.a.runOnce(NOW); // first: tracking (ACCEPTED)
      await r.b.runOnce(NOW);
      assert.equal(r.chain.sent.length, 1, "second still waits while the first is only ACCEPTED");
      const first = r.rows().find((j) => j.state === "tracking");
      r.chain.setResult(r.t.db.prepare("SELECT gl_tx_id FROM jobs WHERE id = ?").get(first.id).gl_tx_id, glResult());
      await r.a.runOnce(NOW); // first final -> done/failed
      await Promise.all([r.a.runOnce(NOW), r.b.runOnce(NOW)]); // both race for the second
      assert.equal(new Set(r.chain.sent).size, 2);
      assert.equal(r.rows().filter((j) => ["signing", "signed", "broadcast", "tracking"].includes(j.state)).length, 1);
    }
  });

  it("restart while one step is in flight: the other still waits", async () => {
    const r = await race();
    r.chain.estimateGas = async () => 200_000n;
    const { createExecutor } = await import("../src/executor.js");
    const fresh = createExecutor({ db: openDb(r.t.path), chain: r.chain, chainConfig: CHAIN, account: OPERATOR, config: baseConfig(), planFresh: async () => [
      { key: "resolve:0:1" }, { key: "mark_review_stalled:0:1" }].map((p) => ({ ...p })), consentsActive: () => true });
    await fresh.runOnce(NOW);
    assert.equal(r.chain.sent.length >= 1, true);
    assert.equal(new Set(r.chain.sent).size, 1);
  });

  it("different escrows do not block each other", async () => {
    const r = await race({ escrows: [ESCROW, "0x" + "e6".repeat(20)] });
    assert.deepEqual(r.rows().map((j) => j.state), ["broadcast", "broadcast"]);
    assert.equal(new Set(r.rows().map((j) => j.nonce)).size, 2);
  });
});

describe("2. outcome emails: finalized state only, never a guessed cause", () => {
  async function confirmed(chain, t, clock = { now: NOW }) {
    const db = openDb(t.path);
    const cfg = baseConfig({ sendingEnabled: false, mailTransport: "file", mailOutboxDir: join(t.dir, "outbox"), mailFrom: "t@localhost" });
    const service = createService({ db, chain, account: OPERATOR, config: cfg, transport: await createTransport(cfg), now: () => clock.now });
    if (!db.prepare("SELECT count(*) n FROM consents").get().n) {
      await service.addConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.REVIEW, email: "c@example.com" }));
      db.prepare("UPDATE consents SET email_verified = 1").run();
    }
    return { db, service };
  }
  const outcomeMails = (h) => h.db.prepare("SELECT * FROM outbox WHERE event_key NOT LIKE 'verify:%'").all();
  const noTxNamed = (mail) => {
    assert.match(mail.body, /finalized state\. No transaction is named as its cause/);
    assert.doesNotMatch(mail.body, /tx\/0x/);
  };

  it("an ACCEPTED approval sends nothing (finalized state is unchanged)", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const h = await confirmed(chain, t);
    await h.service.tick();
    chain.external({ status: "ACCEPTED", call: ["resolve", 0] });
    await h.service.tick();
    assert.equal(outcomeMails(h).length, 0);
  });

  it("a final failure leaves finalized state unchanged: no approval email", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const h = await confirmed(chain, t);
    await h.service.tick();
    chain.external({ status: "FINALIZED", ok: false, call: ["resolve", 0] });
    for (let i = 0; i < 3; i += 1) await h.service.tick();
    assert.equal(outcomeMails(h).length, 0);
  });

  it("finalized APPROVED: exactly one email, stating finalized state and naming no transaction; nothing more after a restart", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    let h = await confirmed(chain, t);
    await h.service.tick();
    chain.external({ call: ["resolve", 0] });
    chain.snap = approved();
    await h.service.tick();
    const mails = outcomeMails(h);
    assert.equal(mails.length, 1);
    noTxNamed(mails[0]);
    h = await confirmed(chain, t);
    await h.service.tick();
    await h.service.tick();
    assert.equal(outcomeMails(h).length, 1);
    assert.equal(readdirSync(join(t.dir, "outbox")).length, 2, "verification + one approval");
  });

  it("Codex r3: delayed prior-attempt pair, partial inspection and later discovery never put any transaction in the email", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 2 }), milestone(1)] }) });
    chain.external({ call: ["submit_deliverable", 0, "https://example.org/old", ""] });
    const old = chain.external({ call: ["resolve", 0] });
    for (let i = 0; i < 23; i += 1) chain.external({ call: ["set_automation", "1000", NOW + 86400] });
    chain.external({ call: ["submit_deliverable", 0, "https://example.org/new", ""] });
    chain.logsError = "temporary log RPC failure";
    const h = await confirmed(chain, t);
    await h.service.tick(); // B0
    chain.logsError = null;
    const actual = chain.external({ call: ["resolve", 0] });
    chain.snap = snapshot({ milestones: [milestone(0, { status: "APPROVED", attemptCount: 2 }), milestone(1)] });
    await h.service.tick(); // B1
    await h.service.tick(); // later discovery of the actual call
    await h.service.tick();
    const mails = outcomeMails(h);
    assert.equal(mails.length, 1);
    noTxNamed(mails[0]);
    const stored = h.db.prepare("SELECT provenance_json FROM events WHERE kind = 'review_approved'").get().provenance_json;
    for (const id of [old, actual]) assert.ok(!String(stored).includes(id.slice(2)) && !mails[0].body.includes(id.slice(2)));
  });

  it("several milestones in one poll: one state-only email each", async () => {
    const t = tempDb();
    const two = (s0, s1) => snapshot({ milestones: [milestone(0, { status: s0, attemptCount: 1 }), milestone(1, { status: s1, attemptCount: 1 })], grants: grantW });
    const chain = fakeChain({ snap: two("UNDER_REVIEW", "UNDER_REVIEW") });
    const h = await confirmed(chain, t);
    await h.service.tick();
    chain.snap = two("APPROVED", "REVISION_REQUIRED");
    await h.service.tick();
    const mails = outcomeMails(h);
    assert.equal(mails.length, 2);
    mails.forEach(noTxNamed);
  });

  it("a payment is reported only from RELEASED with a CONFIRMED payout, naming no transaction", async () => {
    const t = tempDb();
    const paying = (status, outflowStatus) => snapshot({
      milestones: [milestone(0, { status }), milestone(1)],
      outflows: [{ id: 4, kind: "MILESTONE_PAYOUT", status: outflowStatus, amount: "1000", recipient: WORKER.address, milestone: 0 }],
    });
    const chain = fakeChain({ snap: paying("PAYMENT_PENDING", "EMITTED") });
    const h = await confirmed(chain, t);
    await h.service.tick();
    chain.snap = paying("RELEASED", "CONFIRMED");
    await h.service.tick();
    const [mail] = outcomeMails(h);
    assert.match(mail.body, /Transfer #4: 1000 wei .*CONFIRMED by the contract/);
    noTxNamed(mail);
  });

  it("the service's own finalized step still names its own transaction", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const db = openDb(t.path);
    const cfg = baseConfig({ mailTransport: "file", mailOutboxDir: join(t.dir, "outbox"), mailFrom: "t@localhost" });
    const service = createService({ db, chain, account: OPERATOR, config: cfg, transport: await createTransport(cfg), now: () => NOW });
    await service.addConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW, email: "w@example.com" }));
    db.prepare("UPDATE consents SET email_verified = 1").run();
    await service.tick();
    chain.mine();
    await service.tick();
    await service.tick();
    const job = db.prepare("SELECT gl_tx_id FROM jobs").get();
    const stepMail = db.prepare("SELECT body FROM outbox WHERE event_key LIKE '%step_completed%'").get();
    assert.match(stepMail.body, new RegExp(`resolve · .*${job.gl_tx_id.slice(2)}`));
  });

  it("an event is not lost for a subscriber who confirms the address later", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const db = openDb(t.path);
    const cfg = baseConfig({ sendingEnabled: false, mailTransport: "file", mailOutboxDir: join(t.dir, "outbox"), mailFrom: "t@localhost" });
    const service = createService({ db, chain, account: OPERATOR, config: cfg, transport: await createTransport(cfg), now: () => NOW });
    await service.addConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.REVIEW, email: "c@example.com" }));
    await service.tick();
    chain.snap = approved();
    await service.tick();
    assert.equal(outcomeMails({ db }).length, 0);
    db.prepare("UPDATE consents SET email_verified = 1").run();
    await service.tick();
    assert.equal(outcomeMails({ db }).length, 1);
  });
});

describe("3. tracking-only mode never signs or broadcasts, in any state", () => {
  it("restart in off mode with signing, signed and broadcast jobs: zero signatures and broadcasts; receipts still progress", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    // Produce one job in each state with sending on.
    const on = await make({ chain, dbFile: t.path });
    await on.service.addConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW }));
    await on.service.tick(); // broadcast
    const insert = on.db.prepare(`INSERT INTO jobs (key, chain_id, escrow, function_name, args_json, scope, amount, reason, consent_ids, state, sender, nonce, gas, gas_price, data, raw_tx, evm_hash, created_at, updated_at)
      SELECT key || ?, chain_id, escrow, function_name, args_json, scope, amount, reason, consent_ids, ?, sender, nonce + ?, gas, gas_price, data, raw_tx, evm_hash, created_at, updated_at FROM jobs WHERE id = 1`);
    insert.run(":signing", "signing", 1);
    insert.run(":signed", "signed", 2);
    on.db.prepare("UPDATE jobs SET raw_tx = NULL, evm_hash = NULL WHERE state = 'signing'").run();
    const before = jobs(on.db).map((j) => ({ id: j.id, raw: j.raw_tx, data: j.data, nonce: j.nonce }));
    const sentBefore = chain.sent.length;

    let signed = 0;
    const watching = { ...OPERATOR, address: OPERATOR.address, signTransaction: async (...a) => { signed += 1; return OPERATOR.signTransaction(...a); } };
    for (const opts of [{ config: { sendingEnabled: false }, account: watching }, { config: { sendingEnabled: true }, account: null }]) {
      const off = await make({ chain, dbFile: t.path, ...opts });
      for (let i = 0; i < 3; i += 1) {
        off.db.prepare("UPDATE jobs SET next_attempt_at = 0, last_broadcast_at = 0").run();
        await off.service.tick();
      }
    }
    assert.equal(signed, 0);
    assert.equal(chain.sent.length, sentBefore, "no broadcast or rebroadcast");

    // Receipts of what was already broadcast still progress.
    chain.mine();
    const off = await make({ chain, dbFile: t.path, config: { sendingEnabled: false } });
    await off.service.tick();
    await off.service.tick();
    const after = jobs(off.db);
    assert.equal(after.find((j) => j.id === 1).state, "done");
    for (const b of before) {
      const a = after.find((j) => j.id === b.id);
      assert.equal(a.raw_tx, b.raw, "signed bytes preserved");
      assert.equal(a.data, b.data);
      assert.equal(a.nonce, b.nonce);
    }

    // Turning sending back on resumes the same bytes only.
    const resumed = await make({ chain, dbFile: t.path });
    resumed.db.prepare("UPDATE jobs SET next_attempt_at = 0").run();
    await resumed.service.tick();
    const signedJob = jobs(resumed.db).find((j) => j.key.endsWith(":signed"));
    assert.ok(chain.sent.includes(signedJob.raw_tx));
  });
});

describe("4. the lifecycle closes the project once settlement is final", () => {
  const settled = (over = {}) =>
    snapshot({
      project: { status: "SETTLING", locked: "0", totalRefunded: "2000", ...over },
      milestones: [milestone(0, { status: "REFUNDED" }), milestone(1, { status: "REFUNDED" })],
      outflows: [{ id: 0, kind: "PROJECT_REMAINDER_REFUND", status: "CONFIRMED", amount: "2000", recipient: CLIENT.address, milestone: 0 }],
      balance: { wei: 0n },
    });

  it("a refunded project closes exactly once, also across a restart", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: settled() });
    const a = await make({ chain, dbFile: t.path });
    await a.service.addConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.RECOVER }));
    await a.service.tick();
    assert.deepEqual(jobs(a.db).map((j) => [j.function_name, j.state]), [["close_project", "broadcast"]]);
    const b = await make({ chain, dbFile: t.path });
    await b.service.tick();
    assert.equal(jobs(b.db).length, 1);
    assert.equal(new Set(chain.sent).size, 1);
  });

  it("a released project closes too", () => {
    const s = snapshot({
      project: { status: "SETTLING", locked: "0", totalReleased: "2000" },
      milestones: [milestone(0, { status: "RELEASED" }), milestone(1, { status: "RELEASED" })],
      outflows: [0, 1].map((id) => ({ id, kind: "MILESTONE_PAYOUT", status: "CONFIRMED", amount: "1000", recipient: WORKER.address, milestone: id })),
    });
    assert.deepEqual(planActions(s, [{ id: 1, scopes: SCOPES.SETTLE, maxAmount: "1" }]).map((p) => p.key), ["close_project"]);
  });

  it("any open obligation prevents closing", () => {
    const consent = [{ id: 1, scopes: SCOPES.RECOVER, maxAmount: "1" }];
    const blocked = [
      settled({ status: "ACTIVE" }),
      settled({ locked: "1" }),
      settled({ queuedOut: "1" }),
      settled({ inflightOut: "1" }),
      settled({ bouncedHeld: "1" }),
      settled({ appealBondHeld: "1" }),
      settled({ appealCreditHeld: "1" }),
      settled({ depositCreditHeld: "1" }),
      { ...settled(), outflows: [{ id: 0, kind: "PROJECT_REMAINDER_REFUND", status: "EMITTED", amount: "2000", recipient: CLIENT.address, milestone: 0 }] },
      { ...settled(), milestones: [milestone(0, { status: "REFUNDED" }), milestone(1, { status: "REFUND_PENDING" })] },
    ];
    for (const s of blocked) assert.ok(!planActions(s, consent).some((p) => p.functionName === "close_project"));
    assert.ok(!planActions(settled(), [{ id: 1, scopes: SCOPES.REVIEW, maxAmount: "1" }]).some((p) => p.functionName === "close_project"), "consent required");
  });
});

describe("outbox leases across processes", () => {
  it("a row another live process is sending is left alone; an expired lease is retried (at-least-once)", async () => {
    const { deliverOutbox } = await import("../src/mailer.js");
    const t = tempDb();
    const now = Math.floor(Date.now() / 1000);
    t.db.prepare("INSERT INTO outbox (event_key, email, subject, body, state, lease_owner, lease_until, created_at) VALUES ('a','x@example.com','s','b','sending','other', ?, ?)").run(now + 300, now);
    t.db.prepare("INSERT INTO outbox (event_key, email, subject, body, state, lease_owner, lease_until, created_at) VALUES ('b','x@example.com','s','b','sending','dead', ?, ?)").run(now - 1, now);
    const sent = [];
    const transport = { send: async (m) => sent.push(m.id) };
    assert.equal(await deliverOutbox(t.db, transport, { mailFrom: "t@localhost" }, { owner: "me" }), 1);
    assert.deepEqual(sent, [2]);
    assert.equal(t.db.prepare("SELECT state FROM outbox WHERE id = 1").get().state, "sending");
  });
});
