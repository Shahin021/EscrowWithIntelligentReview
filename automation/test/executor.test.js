import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak256 } from "viem";
import { checkAddTransaction, expectedCallData } from "../../dapp/src/workspace/guard.js";

import { openDb } from "../src/db.js";
import { createService } from "../src/service.js";
import { SCOPES } from "../src/consent.js";
import { CHAIN, ESCROW, NOW, OPERATOR, WORKER, CLIENT, baseConfig, fakeChain, milestone, signConsent, signRevoke, snapshot, tempDb } from "./helpers.js";
import { parseTransaction } from "viem";

const reviewSnap = () => snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 1 }), milestone(1)] });

async function setup({ chain = fakeChain({ snap: reviewSnap() }), config = {}, dbFile, account = OPERATOR, logs = [] } = {}) {
  const t = dbFile ? { path: dbFile, db: openDb(dbFile) } : tempDb();
  const service = createService({ db: t.db, chain, account, config: baseConfig(config), transport: null, now: () => NOW, log: (...a) => logs.push(JSON.stringify(a)) });

  return { ...t, chain, service, logs };
}

const jobs = (db) => db.prepare("SELECT * FROM jobs ORDER BY id").all();

async function consent(service, account = WORKER, role = "worker", scopes = SCOPES.REVIEW, nonce = 1) {
  return service.addConsent(await signConsent(account, { role, scopes, nonce }));
}

describe("executor: identity before broadcast, no duplicate sends", () => {
  it("happy path: the stored hash is the hash of the stored bytes before they are broadcast; done only after a successful FINALIZED", async () => {
    const h = await setup();
    await consent(h.service);

    let rowAtBroadcast;
    const send = h.chain.sendRawTransaction;
    h.chain.sendRawTransaction = async (raw) => {
      rowAtBroadcast = jobs(h.db)[0];
      return send(raw);
    };

    await h.service.tick();
    const [j] = jobs(h.db);
    assert.equal(rowAtBroadcast.state, "signed");
    assert.equal(rowAtBroadcast.evm_hash, keccak256(rowAtBroadcast.raw_tx));
    assert.equal(j.state, "broadcast");

    // The transaction is exactly resolve(0) from the operator to the consensus contract.
    const tx = parseTransaction(j.raw_tx);
    assert.equal(tx.to.toLowerCase(), CHAIN.consensusMainContract.address.toLowerCase());
    assert.deepEqual(checkAddTransaction(tx.data, { consensusAbi: CHAIN.consensusMainContract.abi, sender: OPERATOR.address,
      expect: { kind: "call", project: ESCROW, functionName: "resolve", calldataHex: expectedCallData("resolve", [0]) } }), []);

    h.chain.genlayerResult = () => ({ statusName: "ACCEPTED", resultName: "AGREE" });
    h.chain.mine();
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "tracking");
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "tracking", "ACCEPTED is not final");

    h.chain.glTxs.set(jobs(h.db)[0].gl_tx_id, { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE" });
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "done");
    assert.equal(new Set(h.chain.sent).size, 1);
  });

  it("FINALIZED with an execution error is a failure, and the same step is never queued again", async () => {
    const h = await setup();
    await consent(h.service);
    await h.service.tick();
    h.chain.mine({ glResult: () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", resultName: "AGREE" }) });
    await h.service.tick();
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "failed");
    assert.equal(JSON.parse(jobs(h.db)[0].verdict_json).key, "execution-failed");
    await h.service.tick();
    assert.equal(jobs(h.db).length, 1, "no new job for the same state");
    assert.equal(new Set(h.chain.sent).size, 1);
  });

  it("an EVM revert is a failure; no re-signing", async () => {
    const h = await setup();
    await consent(h.service);
    await h.service.tick();
    h.chain.mine({ status: "0x0" });
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "failed");
    assert.equal(new Set(h.chain.sent).size, 1);
  });

  it("broadcast timeout after the node accepted: never re-signed, the same bytes are rebroadcast, the receipt is found", async () => {
    const h = await setup();
    await consent(h.service);
    h.chain.behaviour.send = "timeout-after-accept";
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "signed");
    for (let i = 0; i < 2; i += 1) {
      h.db.prepare("UPDATE jobs SET next_attempt_at = 0").run(); // backoff elapsed
      await h.service.tick();
    }
    assert.ok(h.chain.sent.length >= 2);
    assert.equal(new Set(h.chain.sent).size, 1, "only one distinct signed transaction ever exists");
    h.chain.mine();
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "tracking");
  });

  it("broadcast timeout before acceptance, then restart: the stored bytes are sent, not a new transaction", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: reviewSnap() });
    let h = await setup({ chain, dbFile: t.path });
    await consent(h.service);
    chain.behaviour.send = "timeout-before-accept";
    await h.service.tick();
    const first = jobs(h.db)[0];
    assert.equal(first.state, "signed");

    // restart: a fresh process on the same database
    chain.behaviour.send = "ok";
    h = await setup({ chain, dbFile: t.path });
    await h.service.tick();
    const after = jobs(h.db)[0];
    assert.equal(after.state, "broadcast");
    assert.equal(after.evm_hash, first.evm_hash);
    assert.equal(new Set(chain.sent).size, 1);
  });

  it("crash after reserving (signing): a restart re-signs the identical bytes", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: reviewSnap() });
    let h = await setup({ chain, dbFile: t.path, config: { sendingEnabled: true } });
    await consent(h.service);

    // Stop right after the reservation commits.
    const sign = OPERATOR.signTransaction;
    const crashing = { ...OPERATOR, address: OPERATOR.address, signTransaction: async () => { throw new Error("process killed"); } };
    h = await setup({ chain, dbFile: t.path, account: crashing });
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "signing");
    const reserved = jobs(h.db)[0];

    h = await setup({ chain, dbFile: t.path });
    await h.service.tick();
    const signed = jobs(h.db)[0];
    assert.equal(signed.nonce, reserved.nonce);
    assert.equal(signed.data, reserved.data);
    const again = await OPERATOR.signTransaction({ type: "legacy", chainId: CHAIN.id, nonce: reserved.nonce, gas: BigInt(reserved.gas), gasPrice: BigInt(reserved.gas_price), to: CHAIN.consensusMainContract.address, data: reserved.data, value: 0n });
    assert.equal(signed.raw_tx, again, "deterministic signature");
    assert.equal(new Set(chain.sent).size, 1);
    void sign;
  });

  it("two processes on one database: exactly one signs a job, nonces are never reused", async () => {
    const t = tempDb();
    const chain = fakeChain({ snap: snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 1 }), milestone(1)] }) });
    const a = await setup({ chain, dbFile: t.path });
    const b = await setup({ chain, dbFile: t.path });
    await consent(a.service);
    await Promise.all([a.service.tick(), b.service.tick(), a.service.tick(), b.service.tick()]);
    const rows = jobs(a.db);
    assert.equal(rows.length, 1);
    assert.equal(new Set(chain.sent).size, 1);

    // A second step later gets the next nonce.
    chain.mine();
    chain.snap = snapshot({ milestones: [milestone(0, { status: "UNDER_REVIEW", attemptCount: 2 }), milestone(1)] });
    await Promise.all([a.service.tick(), b.service.tick()]);
    const nonces = jobs(a.db).map((j) => j.nonce);
    assert.equal(new Set(nonces).size, nonces.length);
  });

  it("our nonce consumed without our hash: conflict, never re-signed", async () => {
    const h = await setup();
    await consent(h.service);
    h.chain.behaviour.send = "timeout-before-accept";
    await h.service.tick();
    h.chain.nonces.set(OPERATOR.address.toLowerCase(), 5); // someone else used the key
    h.chain.behaviour.send = "nonce-too-low";
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "conflict");
    assert.equal(new Set(h.chain.sent).size, 1);
  });

  it("caps: gas above cap blocks, fee above cap blocks, gas price above cap waits without spending attempts, budget pauses", async () => {
    let h = await setup();
    await consent(h.service);
    h.chain.gasEstimate = 4_000_000n;
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "blocked");

    h = await setup({ config: { maxFeePerTxWei: 1000n } });
    await consent(h.service);
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "blocked");

    h = await setup();
    await consent(h.service);
    h.chain.gasPriceWei = 200_000_000_000n;
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "queued");
    assert.equal(jobs(h.db)[0].attempts, 0);
    assert.equal(h.chain.sent.length, 0);

    h = await setup({ config: { dailyBudgetWei: 1000n } });
    await consent(h.service);
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "queued");
    assert.match(jobs(h.db)[0].last_error, /budget/);
    assert.equal(h.chain.sent.length, 0);
    const paused = h.db.prepare("SELECT kind FROM events").all().map((e) => e.kind);
    assert.ok(paused.includes("automation_paused"));
  });

  it("transient read errors back off and stop after the attempt limit", async () => {
    const h = await setup();
    await consent(h.service);
    h.chain.estimateError = "upstream unavailable";
    for (let i = 0; i < 6; i += 1) {
      h.db.prepare("UPDATE jobs SET next_attempt_at = 0").run();
      await h.service.tick();
    }
    assert.equal(jobs(h.db)[0].state, "blocked");
    assert.match(jobs(h.db)[0].last_error, /gave up after 3 attempts/);
    assert.equal(h.chain.sent.length, 0);
  });

  it("tracking-only mode (sending off or no key) never signs", async () => {
    let h = await setup({ config: { sendingEnabled: false } });
    await consent(h.service);
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "queued");
    h = await setup({ account: null });
    await consent(h.service);
    await h.service.tick();
    assert.equal(h.chain.sent.length, 0);
  });

  it("a step the chain no longer needs is dropped before signing", async () => {
    const h = await setup({ config: { sendingEnabled: false } });
    await consent(h.service);
    await h.service.tick();
    h.chain.snap = snapshot({ milestones: [milestone(0, { status: "APPROVED", attemptCount: 1 }), milestone(1)] });
    const enabled = await setup({ chain: h.chain, dbFile: h.path });
    await enabled.service.tick();
    assert.equal(jobs(h.db)[0].state, "obsolete");
    assert.equal(h.chain.sent.length, 0);
  });

  it("revocation cancels unsigned steps; a signed step is tracked to its result", async () => {
    const h = await setup({ config: { sendingEnabled: false } });
    await consent(h.service);
    await h.service.tick();
    const r = await h.service.revoke(await signRevoke(WORKER, { nonce: 2 }));
    assert.equal(r.cancelledQueuedJobs, 1);
    assert.equal(jobs(h.db)[0].state, "cancelled");

    const g = await setup();
    await consent(g.service);
    await g.service.tick();
    assert.equal(jobs(g.db)[0].state, "broadcast");
    const r2 = await g.service.revoke(await signRevoke(WORKER, { nonce: 2 }));
    assert.equal(r2.alreadySignedJobsStillTracked, 1);
    g.chain.mine();
    await g.service.tick();
    await g.service.tick();
    assert.equal(jobs(g.db)[0].state, "done");
  });

  it("another transaction with the same calldata never resolves this step", async () => {
    const h = await setup();
    await consent(h.service);
    await h.service.tick();
    const [j] = jobs(h.db);
    // Someone else sends resolve(0) too; its receipt exists under another hash.
    const otherHash = "0x" + "ab".repeat(32);
    h.chain.receipts.set(otherHash, { transactionHash: otherHash, status: "success", blockNumber: 99n, logs: [] });
    h.chain.mempool.clear();
    await h.service.tick();
    assert.equal(jobs(h.db)[0].state, "broadcast");
    assert.equal(jobs(h.db)[0].evm_hash, j.evm_hash);
    assert.equal(new Set(h.chain.sent).size, 1, "rebroadcast of the same bytes only");
  });

  it("worker grant + settle consent: claim_payment is sent, the payout goes to the worker by contract state", async () => {
    const snap = snapshot({ milestones: [milestone(0, { status: "APPROVED", attemptCount: 1 }), milestone(1)], grants: { client: null, worker: { max_amount: "1000", expires_at: String(NOW + 3600) } } });
    const h = await setup({ chain: fakeChain({ snap }) });
    await consent(h.service, WORKER, "worker", SCOPES.SETTLE);
    await h.service.tick();
    const [j] = jobs(h.db);
    assert.equal(j.function_name, "claim_payment");
    assert.deepEqual(JSON.parse(j.args_json), [0]);
    const tx = parseTransaction(j.raw_tx);
    assert.deepEqual(checkAddTransaction(tx.data, { consensusAbi: CHAIN.consensusMainContract.abi, sender: OPERATOR.address,
      expect: { kind: "call", project: ESCROW, functionName: "claim_payment", calldataHex: expectedCallData("claim_payment", [0]) } }), []);
  });

  it("a client consent never triggers the worker's claim", async () => {
    const snap = snapshot({ milestones: [milestone(0, { status: "APPROVED", attemptCount: 1 }), milestone(1)], grants: { client: null, worker: { max_amount: "1000", expires_at: String(NOW + 3600) } } });
    const h = await setup({ chain: fakeChain({ snap }) });
    await consent(h.service, CLIENT, "client", SCOPES.REVIEW | SCOPES.RECOVER);
    await h.service.tick();
    assert.equal(jobs(h.db).length, 0);
  });

  it("a replayed consent is refused", async () => {
    const h = await setup();
    const signed = await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW, nonce: 1 });
    await h.service.addConsent(signed);
    await assert.rejects(h.service.addConsent(signed), /nonce/);
    void CLIENT;
  });

  it("public status and logs never contain raw transactions, signatures, keys or full emails", async () => {
    const h = await setup();
    const signed = await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW, nonce: 1, email: "secret.person@example.com" });
    await h.service.addConsent(signed);
    await h.service.tick();
    const status = JSON.stringify(await h.service.publicStatus(ESCROW));
    const raw = jobs(h.db)[0].raw_tx;
    assert.ok(raw && raw.length > 100);
    for (const text of [status, h.logs.join("\n"), JSON.stringify(h.service.info())]) {
      assert.ok(!text.includes(raw.slice(2, 80)), "raw tx");
      assert.ok(!text.includes(signed.signature.slice(2, 60)), "consent signature");
      assert.ok(!text.includes("secret.person"), "email");
    }
  });
});
