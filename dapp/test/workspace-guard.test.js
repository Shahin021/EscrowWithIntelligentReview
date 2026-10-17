// The wallet boundary and sendTracked, driven through the real genlayer-js
// 1.1.8 testnetBradbury client. The wallet signs nothing real: a fake EIP-1193
// provider returns a hash, and a fake JSON-RPC endpoint answers the reads the
// SDK makes (nonce, gas, EVM receipt with the consensus NewTransaction event).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";

import { createGuardedProvider, checkAddTransaction, expectedCallData } from "../src/workspace/guard.js";
import { sendTracked, DuplicatePending, advance, newTransactionFromReceipt, checkPossiblySent, releaseIfNotSent, attachEvmHash } from "../src/workspace/sender.js";
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
              evmTxs: new Map(), chainLogs: [], nonce: 7n, storage: memoryStorage() };
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
        h.evmTxs.set(evmHash, { hash: evmHash, from: params[0].from, to: params[0].to, input: params[0].data, value: params[0].value ?? "0x0" });
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
    getBlockNumber: vi.fn(async () => 32n),
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

const LATER = () => Date.now() + 11 * 60 * 1000;      // past the release waiting period
const deps = (h, now = LATER) => ({ readClient: h.readClient, consensus: CONSENSUS, journal: h.journal, now });

describe("a forwarded transaction whose answer is lost is never sent twice", () => {
  it("forward → broadcast → response lost → reload → retry refused → found on chain and tracked", async () => {
    const h = harness();
    h.loseResponse = "Provider disconnected";
    const err = await h.send().catch((e) => e);
    expect(err.name).toBe("PossiblySent");
    expect(h.sent).toHaveLength(1);
    let [e] = h.journal.list({});
    expect(e.phase).toBe(PHASE_PROMPTING);
    expect(e.possiblySent).toBe(true);
    expect(e.evmHash).toBeNull();

    reload(h);                                         // the page reloads
    await expect(h.send()).rejects.toBeInstanceOf(DuplicatePending);
    expect(h.sent).toHaveLength(1);                    // nothing new reached the wallet

    [e] = h.journal.list({});
    const { entry, check } = await checkPossiblySent(e, deps(h));
    expect(check.found).toHaveLength(1);
    expect(check.releasable).toBe(false);
    expect(entry.evmHash).toBe([...h.evmTxs.keys()][0]);
    expect(entry.phase).toBe(PHASE_DONE);
    expect(entry.verdict.key).toBe("success");
    // and it cannot be released as "not sent" afterwards
    expect((await releaseIfNotSent(h.journal.get(entry.id), deps(h))).released).toBe(false);
  });

  it("forwarded but never broadcast: released only after the chain shows the nonce did not move", async () => {
    const h = harness({ sendErrors: ["Extension context invalidated"] }); // fails before broadcasting
    await expect(h.send()).rejects.toThrow(/may have been sent/);
    reload(h);
    let [e] = h.journal.list({});
    // Right after the lost answer the wallet may still broadcast: not yet releasable.
    const early = await releaseIfNotSent(e, deps(h, () => Date.now()));
    expect(early.released).toBe(false);
    expect(early.check.reason).toMatch(/can still broadcast/);
    [e] = h.journal.list({});
    const { check } = await checkPossiblySent(e, deps(h));
    expect(check.found).toEqual([]);
    expect(check.nonce.advanced).toBe(false);
    expect(check.releasable).toBe(true);
    [e] = h.journal.list({});
    const released = await releaseIfNotSent(e, deps(h));
    expect(released.released).toBe(true);
    expect(released.entry.phase).toBe(PHASE_ABANDONED);
    expect(released.entry.expect).toBeUndefined();
    await expect(h.send()).resolves.toMatchObject({ phase: PHASE_DONE });
    expect(h.sent).toHaveLength(2);
  });

  it("an advanced nonce without a matching transaction keeps the action open", async () => {
    const h = harness({ sendErrors: ["timeout"] });
    await expect(h.send()).rejects.toThrow(/may have been sent/);
    h.nonce += 1n;                                     // something else was sent from this account
    const [e] = h.journal.list({});
    const r = await releaseIfNotSent(e, deps(h));
    expect(r.released).toBe(false);
    expect(r.check.reason).toMatch(/has sent a transaction since the prompt/);
    expect(h.journal.get(e.id).phase).toBe(PHASE_PROMPTING);
  });

  it("an unreadable nonce keeps the action open, even if log search is also unavailable", async () => {
    const h = harness({ sendErrors: ["timeout"] });
    await expect(h.send()).rejects.toThrow(/may have been sent/);
    h.nonceError = true;
    h.logsError = true;
    const [e] = h.journal.list({});
    const r = await releaseIfNotSent(e, deps(h));
    expect(r.released).toBe(false);
    expect(r.check.search.ok).toBe(false);
    expect(h.journal.get(e.id).phase).toBe(PHASE_PROMPTING);
  });

  it("an EVM hash pasted by the user is attached only if it is exactly this call", async () => {
    const h = harness();
    await h.send({ args: [1] });                       // a different, completed call
    const other = [...h.evmTxs.keys()][0];
    h.loseResponse = "disconnected";
    await expect(h.send()).rejects.toThrow(/may have been sent/);
    const open = h.journal.list({}).find((x) => x.phase === PHASE_PROMPTING);
    await expect(attachEvmHash(open, other, deps(h))).rejects.toThrow(/not this action/);
    const mine = [...h.evmTxs.keys()][1];
    const attached = await attachEvmHash(open, mine, deps(h));
    expect(attached.evmHash).toBe(mine);
    expect(attached.phase).toBe(PHASE_DONE);
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
