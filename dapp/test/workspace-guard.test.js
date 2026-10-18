// The wallet boundary and sendTracked, driven through the real genlayer-js
// 1.1.8 testnetBradbury client. The wallet signs nothing real: a fake EIP-1193
// provider returns a hash, and a fake JSON-RPC endpoint answers the reads the
// SDK makes (nonce, gas, EVM receipt with the consensus NewTransaction event).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";

import { createGuardedProvider, checkAddTransaction, expectedCallData } from "../src/workspace/guard.js";
import { sendTracked, DuplicatePending, advance, newTransactionFromReceipt, checkPossiblySent, releaseIfNeverForwarded, attachEvmHash } from "../src/workspace/sender.js";
import { createJournal, PHASE_ABANDONED, PHASE_DONE, PHASE_NOT_SENT, PHASE_PROMPTING, PHASE_SENT, PHASE_TRACKING } from "../src/workspace/journal.js";
import { memoryStorage, safeStorage, StorageUnavailable } from "../src/workspace/storage.js";

const CHAIN_HEX = "0x107d"; // 4221
const ACCOUNT = "0x" + "a1".repeat(20);
const OTHER = "0x" + "b2".repeat(20);
const PROJECT = "0x" + "c0".repeat(20);
const CONSENSUS = testnetBradbury.consensusMainContract;
const NEW_TX = CONSENSUS.abi.find((e) => e.type === "event" && e.name === "NewTransaction");

function receiptFor(evmHash, { txId, recipient, status = "0x1" }) {
  const topics = encodeEventTopics({ abi: [NEW_TX], eventName: "NewTransaction", args: { txId, recipient, activator: ACCOUNT } });

  return {
    transactionHash: evmHash, blockHash: "0x" + "11".repeat(32), blockNumber: "0x10", transactionIndex: "0x0",
    from: ACCOUNT, to: CONSENSUS.address, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
    contractAddress: null, logsBloom: "0x" + "00".repeat(256), type: "0x0", status,
    logs: [{ address: CONSENSUS.address, topics, data: "0x", blockNumber: "0x10", transactionHash: evmHash,
             transactionIndex: "0x0", blockHash: "0x" + "11".repeat(32), logIndex: "0x0", removed: false }],
  };
}

function harness({ sendErrors = [], estimate = "0x7a120", chain = CHAIN_HEX, accounts = [ACCOUNT] } = {}) {
  const h = { sent: [], rpc: [], receipts: new Map(), txIds: new Map(), sendErrors: [...sendErrors], wallet: { chain, accounts },
              evmTxs: new Map(), chainLogs: [], nonce: 7n, block: 32n, storage: memoryStorage() };
  h.provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return h.wallet.chain;
      if (method === "eth_accounts") return h.wallet.accounts;
      if (method === "eth_sendTransaction") {
        h.sent.push(params[0]);
        if (h.walletGate) await h.walletGate;
        if (h.sendErrors.length) {
          const e = h.sendErrors.shift();
          throw typeof e === "string" ? new Error(e) : e;
        }
        // The wallet signs and broadcasts: the chain now has the transaction.
        const evmHash = keccak256(toHex(`${h.sent.length}:${params[0].data}`));
        const txId = keccak256(toHex(`gl:${evmHash}`));
        const recipient = h.recipientFor?.(params[0]) ?? PROJECT;
        h.receipts.set(evmHash, receiptFor(evmHash, { txId, recipient }));
        h.txIds.set(evmHash, txId);
        // The wallet assigns its own nonce (it may ignore the SDK's hint).
        h.evmTxs.set(evmHash, { hash: evmHash, from: params[0].from, to: params[0].to, input: params[0].data, value: params[0].value ?? "0x0",
                                nonce: toHex(h.nonce), blockNumber: toHex(h.block) });
        h.chainLogs.push({ transactionHash: evmHash, args: { txId, recipient, activator: ACCOUNT } });
        h.nonce += 1n;
        // ...and then the page never hears back (extension crash, disconnect).
        if (h.loseResponse) {
          const lost = h.loseResponse;
          h.loseResponse = null;
          throw typeof lost === "string" ? new Error(lost) : lost;
        }
        return evmHash;
      }
      throw new Error("wallet: unexpected " + method);
    },
  };
  globalThis.fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const batch = Array.isArray(body) ? body : [body];
    const answers = batch.map(({ id, method, params }) => {
      h.rpc.push(method);
      const result = {
        eth_chainId: chain,
        eth_getTransactionCount: "0x7",
        eth_estimateGas: estimate,
        eth_gasPrice: "0x3b9aca00",
        eth_blockNumber: "0x20",
        eth_maxPriorityFeePerGas: "0x0",
      }[method];
      if (method === "eth_getTransactionReceipt") {
        if (h.rpcReceiptError) return { jsonrpc: "2.0", id, error: { code: -32000, message: "upstream timeout" } };
        const r = h.receipts.get(params[0]);
        return { jsonrpc: "2.0", id, result: r ? { ...r, status: h.evmStatus ?? r.status } : null };
      }
      if (method === "eth_getTransactionByHash") return { jsonrpc: "2.0", id, result: null };
      if (method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id, result: { number: "0x20", timestamp: "0x1", hash: "0x" + "22".repeat(32), transactions: [] } };
      if (result === undefined) return { jsonrpc: "2.0", id, error: { code: -32601, message: "fake: " + method } };
      return { jsonrpc: "2.0", id, result };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { headers: { "content-type": "application/json" } });
  });
  h.guard = createGuardedProvider({ provider: h.provider, chainId: 4221, consensus: CONSENSUS });
  h.client = createClient({ chain: testnetBradbury, account: ACCOUNT, provider: h.guard });
  h.journal = createJournal(safeStorage(h.storage));
  h.readClient = {
    getTransactionCount: vi.fn(async () => { if (h.nonceError) throw new Error("nonce unavailable"); return h.nonce; }),
    getBlockNumber: vi.fn(async () => h.block),
    getLogs: vi.fn(async ({ args }) => {
      if (h.logsError) throw new Error("eth_getLogs refused");
      return h.chainLogs.filter((l) => l.args.activator.toLowerCase() === args.activator.toLowerCase()
        && (!args.recipient || l.args.recipient.toLowerCase() === args.recipient.toLowerCase()));
    }),
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_getTransactionByHash") return h.evmTxs.get(params[0]) ?? null;
      throw new Error("unexpected " + method);
    }),
    getTransactionReceipt: vi.fn(async ({ hash }) => {
      const r = h.receipts.get(hash);
      if (!r) throw new Error("not found");
      return { ...r, status: r.status === "0x1" ? "success" : "reverted", blockNumber: 16n,
               logs: r.logs.map((l) => ({ ...l })) };
    }),
    getTransaction: vi.fn(async ({ hash }) => h.genlayerTx?.(hash) ?? {
      statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE", recipient: PROJECT,
    }),
  };
  h.send = (request = {}) => sendTracked({
    kind: "call", network: "testnetBradbury", chainId: 4221, account: ACCOUNT, project: PROJECT,
    functionName: "resolve", args: [0], value: 0n, label: "Run review", ...request,
  }, { client: h.client, guard: h.guard, journal: h.journal, readClient: h.readClient, consensus: CONSENSUS,
       sleep: async () => {}, polls: 3, intervalMs: 1 });
  return h;
}

afterEach(() => { delete globalThis.fetch; });

describe("guarded write through the real SDK", () => {
  it("sends exactly one transaction, records the EVM hash, resolves the GenLayer id and classifies success", async () => {
    const h = harness();
    const entry = await h.send();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to.toLowerCase()).toBe(CONSENSUS.address.toLowerCase());
    expect(entry.phase).toBe(PHASE_DONE);
    expect(entry.evmHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.txId).toBe(h.txIds.get(entry.evmHash));
    expect(entry.verdict.key).toBe("success");
  });

  it("refuses the SDK's fallback re-send after an ABI-mismatch error: one wallet prompt only", async () => {
    const h = harness({ sendErrors: ["could not decode result data"] });
    await expect(h.send()).rejects.toThrow(/may have been sent/i);
    expect(h.sent).toHaveLength(1);
    const [e] = h.journal.list({});
    // An error from the wallet after it had the transaction is not proof of
    // non-submission: the intent stays open and cannot be sent again.
    expect(e.phase).toBe(PHASE_PROMPTING);
    expect(e.possiblySent).toBe(true);
    await expect(h.send()).rejects.toBeInstanceOf(DuplicatePending);
    expect(h.sent).toHaveLength(1);
  });

  it("a wallet rejection is recorded as not sent", async () => {
    const err = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const h = harness({ sendErrors: [err] });
    await expect(h.send()).rejects.toThrow(/rejected/i);
    const [e] = h.journal.list({});
    expect(e.phase).toBe(PHASE_NOT_SENT);
    expect(e.rejectedByUser).toBe(true);
    // and the same call can be tried again afterwards
    h.sendErrors = [];
    await expect(h.send()).resolves.toMatchObject({ phase: PHASE_DONE });
  });

  it("wallet on another chain: nothing reaches the wallet", async () => {
    const h = harness();
    h.wallet.chain = "0xf22f";
    await expect(h.send()).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
  });

  it("wallet account switched after arming: nothing is sent", async () => {
    const h = harness();
    h.wallet.accounts = [OTHER];
    await expect(h.send()).rejects.toThrow(/account changed/);
    expect(h.sent).toHaveLength(0);
  });

  it("gas below the read-only estimate (the SDK's 200,000 fallback) is refused", async () => {
    const h = harness({ estimate: "0x30d40" }); // 200,000
    await expect(h.send({ minGas: 900_000n, maxGas: 16_777_216n })).rejects.toThrow(/below the read-only estimate/);
    expect(h.sent).toHaveLength(0);
  });

  it("an unresolved identical call is never sent twice", async () => {
    const h = harness();
    h.readClient.getTransaction = vi.fn(async () => ({ statusName: "ACCEPTED", recipient: PROJECT }));
    const first = await h.send();
    expect(first.phase).toBe(PHASE_TRACKING);
    await expect(h.send()).rejects.toBeInstanceOf(DuplicatePending);
    expect(h.sent).toHaveLength(1);
  });

  it("timeout after the wallet returned a hash keeps the hash and resumes read-only later", async () => {
    const h = harness();
    h.rpcReceiptError = true;                     // the SDK's own receipt wait fails after the send
    h.readClient.getTransactionReceipt = vi.fn(async () => { throw new Error("not mined"); });
    const entry = await h.send();
    expect(entry.txId).toBeNull();
    expect(entry.phase === PHASE_SENT || entry.phase === PHASE_TRACKING).toBe(true);
    expect(entry.evmHash).toBeTruthy();
    // "refresh": a new journal over the same storage, no wallet at all
    const reloaded = h.journal.get(entry.id);
    h.readClient.getTransactionReceipt = vi.fn(async ({ hash }) => ({ status: "success", blockNumber: 16n, logs: h.receipts.get(hash).logs }));
    const done = await advance(reloaded, { readClient: h.readClient, consensus: CONSENSUS, journal: h.journal, polls: 1, sleep: async () => {} });
    expect(done.phase).toBe(PHASE_DONE);
    expect(done.verdict.key).toBe("success");
    expect(h.sent).toHaveLength(1);
  });

  it("a FINALIZED transaction with an execution error is a failure, not a success", async () => {
    const h = harness();
    h.genlayerTx = () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", resultName: "AGREE", recipient: PROJECT });
    const entry = await h.send();
    expect(entry.verdict.key).toBe("execution-failed");
    expect(entry.verdict.ok).toBe(false);
  });

  it("an EVM-reverted transaction is recorded as failed", async () => {
    const h = harness();
    h.evmStatus = "0x0";                          // the SDK sees the revert and throws after the send
    h.readClient.getTransactionReceipt = vi.fn(async () => ({ status: "reverted", logs: [] }));
    h.readClient.getTransaction = vi.fn();
    const entry = await h.send();
    expect(entry.verdict.key).toBe("evm-reverted");
  });
});

describe("decoding what the SDK built", () => {
  it("accepts exactly the expected call and rejects a different argument", async () => {
    const h = harness();
    await h.send();
    const data = h.sent[0].data;
    const ok = checkAddTransaction(data, { consensusAbi: CONSENSUS.abi, sender: ACCOUNT,
      expect: { kind: "call", project: PROJECT, functionName: "resolve", calldataHex: expectedCallData("resolve", [0]) } });
    expect(ok).toEqual([]);
    const bad = checkAddTransaction(data, { consensusAbi: CONSENSUS.abi, sender: ACCOUNT,
      expect: { kind: "call", project: PROJECT, functionName: "resolve", calldataHex: expectedCallData("resolve", [1]) } });
    expect(bad.join()).toMatch(/not exactly resolve/);
    const wrongProject = checkAddTransaction(data, { consensusAbi: CONSENSUS.abi, sender: ACCOUNT,
      expect: { kind: "call", project: OTHER, functionName: "resolve", calldataHex: expectedCallData("resolve", [0]) } });
    expect(wrongProject.join()).toMatch(/recipient/);
  });

  it("refuses leader-only execution", async () => {
    const h = harness();
    const slot = h.guard.arm({ account: ACCOUNT, value: 0n, expect: { kind: "call", project: PROJECT, functionName: "resolve", calldataHex: expectedCallData("resolve", [0]) } });
    await expect(h.client.writeContract({ address: PROJECT, functionName: "resolve", args: [0], value: 0n, leaderOnly: true })).rejects.toThrow();
    h.guard.disarm(slot);
    expect(h.sent).toHaveLength(0);
    expect(slot.refusal.message).toMatch(/leader-only/);
  });

  it("refuses an eth_sendTransaction when nothing is armed", async () => {
    const h = harness();
    await expect(h.guard.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow(/No write is armed/);
    await expect(h.guard.request({ method: "wallet_requestSnaps", params: [] })).rejects.toThrow(/not used/);
  });

  it("finds the GenLayer id in the receipt only from the consensus contract", () => {
    const txId = "0x" + "77".repeat(32);
    const r = receiptFor("0x" + "01".repeat(32), { txId, recipient: PROJECT });
    expect(newTransactionFromReceipt(r, CONSENSUS)).toMatchObject({ txId, count: 1 });
    const spoofed = { logs: r.logs.map((l) => ({ ...l, address: OTHER })) };
    expect(newTransactionFromReceipt(spoofed, CONSENSUS)).toMatchObject({ txId: null, count: 0 });
    void encodeAbiParameters;
  });
});


/** A fresh page over the same browser storage: new journal, guard and client. */
function reload(h) {
  h.journal = createJournal(safeStorage(h.storage));
  h.guard = createGuardedProvider({ provider: h.provider, chainId: 4221, consensus: CONSENSUS });
  h.client = createClient({ chain: testnetBradbury, account: ACCOUNT, provider: h.guard });
  h.send = (request = {}) => sendTracked({
    kind: "call", network: "testnetBradbury", chainId: 4221, account: ACCOUNT, project: PROJECT,
    functionName: "resolve", args: [0], value: 0n, label: "Run review", ...request,
  }, { client: h.client, guard: h.guard, journal: h.journal, readClient: h.readClient, consensus: CONSENSUS,
       sleep: async () => {}, polls: 3, intervalMs: 1 });
}

const deps = (h) => ({ readClient: h.readClient, consensus: CONSENSUS, journal: h.journal });
const JOURNAL_KEY = "escrow-workspace:v2:journal";

describe("a forwarded transaction whose answer is lost is never sent twice", () => {
  it("forward → broadcast → response lost → reload → retry refused → its own transaction found and tracked", async () => {
    const h = harness();
    h.loseResponse = "Provider disconnected";
    const err = await h.send().catch((e) => e);
    expect(err.name).toBe("PossiblySent");
    expect(h.sent).toHaveLength(1);
    let [e] = h.journal.list({});
    expect(e.phase).toBe(PHASE_PROMPTING);
    expect(e.possiblySent).toBe(true);
    expect(e.forwardedAt).toBeTruthy();
    expect(e.forwarded.data).toBe(h.sent[0].data);       // identity recorded at the wallet boundary

    reload(h);
    expect(releaseIfNeverForwarded(e, deps(h)).released).toBe(false);
    await expect(h.send()).rejects.toBeInstanceOf(DuplicatePending);
    expect(h.sent).toHaveLength(1);

    [e] = h.journal.list({});
    const { entry, check } = await checkPossiblySent(e, deps(h));
    expect(check.found).toHaveLength(1);
    expect(entry.evmHash).toBe([...h.evmTxs.keys()][0]);
    expect(entry.phase).toBe(PHASE_DONE);
    expect(entry.verdict.key).toBe("success");
  });

  it("Codex #1: a wallet request still pending after reload and 11 minutes is never released; approving it yields exactly one transaction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = harness();
      let approve;
      h.walletGate = new Promise((resolve) => { approve = resolve; });
      const oldPage = h.send().catch((e) => e);          // the wallet prompt stays open
      await vi.waitFor(() => expect(h.sent).toHaveLength(1));

      reload(h);                                          // the page reloads; the request is still pending in the wallet
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);      // eleven minutes pass; nonces are unchanged
      let [e] = h.journal.list({});
      expect(e.phase).toBe(PHASE_PROMPTING);
      expect(releaseIfNeverForwarded(e, deps(h)).released).toBe(false);
      const { check } = await checkPossiblySent(e, deps(h));
      expect(check.found).toEqual([]);
      expect(check.reason).toMatch(/stays open/);
      expect(h.journal.get(e.id).phase).toBe(PHASE_PROMPTING);
      await expect(h.send()).rejects.toBeInstanceOf(DuplicatePending);   // no second request is opened
      expect(h.sent).toHaveLength(1);

      h.loseResponse = "page gone";                        // the old page never hears the approval
      h.walletGate = null;
      approve();
      await oldPage;
      expect(h.evmTxs.size).toBe(1);                       // exactly one broadcast

      [e] = h.journal.list({});
      const found = await checkPossiblySent(e, deps(h));
      expect(found.entry.phase).toBe(PHASE_DONE);
      expect(h.evmTxs.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Codex #2: an older identical transaction is never attached, by hash or by discovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = harness();
      const first = await h.send();                        // completed call A
      expect(first.phase).toBe(PHASE_DONE);
      const hashA = first.evmHash;

      vi.setSystemTime(Date.now() + 5000);
      h.block += 3n;
      h.loseResponse = "disconnected";                     // identical call B, answer lost
      await expect(h.send()).rejects.toThrow(/may have been sent/);
      const b = h.journal.list({}).find((x) => x.phase === PHASE_PROMPTING);

      const pasted = await attachEvmHash(b, hashA, deps(h)).catch((err) => err);
      expect(pasted.message).toMatch(/not this action/);
      expect(pasted.message).toMatch(/below this action's baseline/);
      expect(pasted.message).toMatch(/already belongs to another recorded action/);
      expect(pasted.message).toMatch(/not the exact transaction/);
      expect(h.journal.get(b.id).phase).toBe(PHASE_PROMPTING);
      await expect(h.send()).rejects.toBeInstanceOf(DuplicatePending);   // no third send
      expect(h.sent).toHaveLength(2);

      // Discovery sees both NewTransaction logs and picks only B's own.
      const { entry, check } = await checkPossiblySent(h.journal.get(b.id), deps(h));
      expect(check.rejected.map((r) => r.hash)).toContain(hashA);
      expect(check.found).toHaveLength(1);
      expect(check.found[0]).not.toBe(hashA);
      expect(entry.phase).toBe(PHASE_DONE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Codex #2, A sent from another browser: nonce and block bounds still refuse it", async () => {
    const h = harness();
    const first = await h.send();
    h.storage.removeItem(JOURNAL_KEY);                    // this browser has no record of A
    reload(h);
    h.block += 1n;
    h.loseResponse = "disconnected";
    await expect(h.send()).rejects.toThrow(/may have been sent/);
    const [b] = h.journal.list({});
    const err = await attachEvmHash(b, first.evmHash, deps(h)).catch((e) => e);
    expect(err.message).toMatch(/below this action's baseline/);
    expect(err.message).toMatch(/before this action's prompt/);
    expect(h.journal.get(b.id).phase).toBe(PHASE_PROMPTING);
  });

  it("a candidate with identical calldata but a different exact input is refused", async () => {
    const h = harness();
    h.loseResponse = "disconnected";
    await expect(h.send()).rejects.toThrow(/may have been sent/);
    const [b] = h.journal.list({});
    // Same call, same sender, within bounds, but a different validUntil: another build of the call.
    const own = [...h.evmTxs.values()][0];
    const other = { ...own, hash: "0x" + "ee".repeat(32), input: own.input.slice(0, -2) + (own.input.endsWith("0") ? "1" : "0") };
    h.evmTxs.set(other.hash, other);
    const err = await attachEvmHash(b, other.hash, deps(h)).catch((e) => e);
    expect(err.message).toMatch(/not the exact transaction/);
  });

  it("an intent that never reached the wallet is released on reload, and only that", async () => {
    const h = harness();
    // The page stopped after recording the intent, before the guard forwarded it.
    const e = h.journal.create({ network: "testnetBradbury", project: PROJECT, account: ACCOUNT, functionName: "resolve", args: [0], value: "0",
      kind: "call", label: "Run review", nonceBefore: "7", promptBlock: "32" });
    reload(h);
    const r = releaseIfNeverForwarded(h.journal.get(e.id), deps(h));
    expect(r.released).toBe(true);
    expect(r.entry.phase).toBe(PHASE_NOT_SENT);
    await expect(h.send()).resolves.toMatchObject({ phase: PHASE_DONE });
    expect(h.sent).toHaveLength(1);
  });

  it("if the forwarded record cannot be written, nothing reaches the wallet", async () => {
    const h = harness();
    const inner = h.storage;
    let failWrites = false;
    const flaky = { getItem: (k) => inner.getItem(k), setItem: (k, v) => { if (failWrites) throw new Error("disk full"); inner.setItem(k, v); }, removeItem: (k) => inner.removeItem(k) };
    h.journal = createJournal(safeStorage(flaky));
    h.readClient.getBlockNumber = vi.fn(async () => { return h.block; });
    const origEstimate = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (JSON.parse(init.body).method === "eth_estimateGas") failWrites = true;   // after the intent, before forwarding
      return origEstimate(url, init);
    });
    const err = await sendTracked({ kind: "call", network: "testnetBradbury", chainId: 4221, account: ACCOUNT, project: PROJECT,
      functionName: "resolve", args: [0], value: 0n }, { client: h.client, guard: h.guard, journal: h.journal,
      readClient: h.readClient, consensus: CONSENSUS, sleep: async () => {} }).catch((e) => e);
    expect(err.name).toBe("GuardRefusal");
    expect(err.message).toMatch(/could not be recorded/);
    expect(h.sent).toHaveLength(0);
    // what is stored has no forwarded record, so a later page releases it safely
    const stored = JSON.parse(inner.getItem(JOURNAL_KEY));
    expect(stored[0].forwardedAt).toBeUndefined();
  });

  it("an explicit rejection after forwarding is not sent and may be retried", async () => {
    const h = harness();
    h.loseResponse = Object.assign(new Error("User rejected the request."), { code: 4001 });
    await expect(h.send()).rejects.toThrow(/rejected/i);
    expect(h.journal.list({})[0].phase).toBe(PHASE_NOT_SENT);
  });
});

describe("no wallet prompt without a durable record", () => {
  it("a nonce baseline that cannot be read sends nothing and records nothing", async () => {
    const h = harness();
    h.nonceError = true;
    await expect(h.send()).rejects.toThrow(/Nothing was sent/);
    expect(h.sent).toHaveLength(0);
    expect(h.journal.list({})).toEqual([]);
  });

  it("storage that is unavailable, full, silently dropping or corrupt blocks the send before the wallet", async () => {
    const cases = {
      unavailable: () => safeStorage(null),
      full: () => safeStorage({ getItem: () => null, setItem() { throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" }); }, removeItem() {} }),
      dropping: () => safeStorage({ getItem: () => null, setItem() {}, removeItem() {} }),
      corrupt: () => { const m = memoryStorage(); m.setItem("escrow-workspace:v2:journal", "{not json"); return safeStorage(m); },
    };
    for (const [name, make] of Object.entries(cases)) {
      const h = harness();
      const store = make();
      h.journal = createJournal(store);
      const err = await sendTracked({ kind: "call", network: "testnetBradbury", chainId: 4221, account: ACCOUNT, project: PROJECT,
        functionName: "resolve", args: [0], value: 0n }, { client: h.client, guard: h.guard, journal: h.journal,
        readClient: h.readClient, consensus: CONSENSUS, sleep: async () => {} }).catch((e) => e);
      expect(err, name).toBeInstanceOf(StorageUnavailable);
      expect(h.sent, name).toHaveLength(0);
      expect(h.journal.health().ok, name).toBe(false);
      if (name === "full") expect(err.message).toMatch(/full/);
      if (name === "corrupt") {
        expect(err.message).toMatch(/corrupt/);
        expect(store.getItem("escrow-workspace:v2:journal")).toBe("{not json"); // left untouched
      }
    }
  });
});

describe('one-transaction funded deployment', () => {
  it('forwards principal and constructor authorization in one wallet transaction, then only reads', async () => {
    const { deployConsensusCall } = await import('../src/workspace/create.js');
    const h = harness();
    const code = new TextEncoder().encode('# test only\nclass Contract: pass\n');
    const args = [OTHER, '[{"spec":"A work specification","amount":"1"}]', 'raw.githubusercontent.com/test/repo', 'text', 1, false, '', 0, 1800000000, 'a'.repeat(64)];
    const call = deployConsensusCall({chain:testnetBradbury,sender:ACCOUNT,code,constructorArgs:args,validUntil:1900000000});
    const e = await h.send({kind:'deploy', code,constructorArgs:args,value:1n,minGas:500000n,maxGas:16777216n,fundedDeploy:call,enrollment:{role:'client',email:'client@example.com'}});
    expect(h.sent).toHaveLength(1);
    expect(BigInt(h.sent[0].value)).toBe(1n);
    expect(e.createdAddress.toLowerCase()).toBe(PROJECT);
    expect(e.enrollment.role).toBe('client');
    await advance(e,{readClient:h.readClient,consensus:CONSENSUS,journal:h.journal});
    expect(h.sent).toHaveLength(1);
  });
  it('cannot replace the exact constructor call while attaching money', async () => {
    const h = harness();
    await expect(h.send({kind:'deploy',code:new Uint8Array([1]),constructorArgs:[],value:1n,minGas:500000n,maxGas:16777216n,fundedDeploy:{data:'0xdeadbeef'}})).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
  });
  it('the worker evidence and permission travel in one SDK call', async () => {
    const h = harness();
    const e = await h.send({functionName:'submit_once',args:['[{"url":"https://example.com/pinned"}]',1800000000,'b'.repeat(64)],enrollment:{role:'worker',email:'worker@example.com'}});
    expect(h.sent).toHaveLength(1);
    expect(e.verdict.ok).toBe(true);
    expect(e.enrollment.role).toBe('worker');
  });
});
