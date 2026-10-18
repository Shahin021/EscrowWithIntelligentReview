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
import { CLIENT, ESCROW, NOW, OPERATOR, WORKER, baseConfig, fakeChain, milestone, signConsent, snapshot, tempDb } from "./helpers.js";

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

describe("2. outcome emails need finalized state and verified finalized provenance", () => {
  async function confirmed(chain, t) {
    const h = await make({ chain, dbFile: t.path, mail: true, dir: t.dir, config: { sendingEnabled: false } });
    await h.service.addConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.REVIEW, email: "c@example.com" }));
    h.db.prepare("UPDATE consents SET email_verified = 1").run();
    await h.service.tick();
    return h;
  }
  const outcomeMails = (h) => h.db.prepare("SELECT * FROM outbox WHERE event_key NOT LIKE 'verify:%'").all();

  it("an ACCEPTED approval sends nothing; an approval with no verified final transaction stays pending, visibly", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const h = await confirmed(chain, t);
    chain.external({ status: "ACCEPTED" }); // not final: finalized state is unchanged
    await h.service.tick();
    assert.equal(outcomeMails(h).length, 0);

    // State moves, but the only transaction is not a finalized success: pending.
    chain.snap = approved();
    await h.service.tick();
    assert.equal(outcomeMails(h).length, 0);
    const status = await h.service.publicStatus(ESCROW);
    assert.equal(status.notifications[0].state, "pending");
    assert.match(status.notifications[0].note, /waiting for a verified finalized transaction/);
  });

  it("a final failure produces no approval email", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const h = await confirmed(chain, t);
    chain.external({ status: "FINALIZED", ok: false });
    for (let i = 0; i < 3; i += 1) await h.service.tick();
    assert.equal(outcomeMails(h).length, 0);
  });

  it("a final success emits once, with its transaction, and not again after a restart", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const h = await confirmed(chain, t);
    const txId = chain.external({ status: "FINALIZED", ok: true });
    chain.snap = approved();
    await h.service.tick();
    let mails = outcomeMails(h);
    assert.equal(mails.length, 1);
    assert.match(mails[0].body, new RegExp(txId.slice(2)));

    const again = await make({ chain, dbFile: t.path, mail: true, dir: t.dir, config: { sendingEnabled: false } });
    await again.service.tick();
    await again.service.tick();
    mails = outcomeMails(again);
    assert.equal(mails.length, 1);
    assert.equal(readdirSync(join(t.dir, "outbox")).length, 2, "verification + one approval");
  });

  it("an event is not lost for a subscriber who confirms the address later", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: review() });
    const h = await make({ chain, mail: true, dir: t.dir, config: { sendingEnabled: false } });
    await h.service.addConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.REVIEW, email: "c@example.com" }));
    await h.service.tick();
    chain.external({ status: "FINALIZED", ok: true });
    chain.snap = approved();
    await h.service.tick();
    assert.equal(outcomeMails(h).length, 0);
    h.db.prepare("UPDATE consents SET email_verified = 1").run();
    await h.service.tick();
    assert.equal(outcomeMails(h).length, 1);
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
