// Test doubles: an in-memory Bradbury with an EVM mempool, receipts carrying
// the real consensus NewTransaction event, and GenLayer transactions.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testnetBradbury } from "genlayer-js/chains";
import { encodeEventTopics, keccak256, parseTransaction, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { openDb } from "../src/db.js";

export const CHAIN = testnetBradbury;
export const ESCROW = "0x" + "e5".repeat(20);
export const CLIENT = privateKeyToAccount(generatePrivateKey());
export const WORKER = privateKeyToAccount(generatePrivateKey());
export const STRANGER = privateKeyToAccount(generatePrivateKey());
export const OPERATOR = privateKeyToAccount(generatePrivateKey());
export const NOW = 1_800_000_000;

const NEW_TX = CHAIN.consensusMainContract.abi.find((e) => e.type === "event" && e.name === "NewTransaction");

export function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "escrow-auto-"));

  return { path: join(dir, "db.sqlite"), dir, db: openDb(join(dir, "db.sqlite")) };
}

export const baseConfig = (over = {}) => ({
  network: "testnetBradbury",
  sendingEnabled: true,
  maxGas: 3_000_000n,
  maxGasPriceWei: 100_000_000_000n,
  maxFeePerTxWei: 50_000_000_000_000_000n,
  dailyBudgetWei: 500_000_000_000_000_000n,
  maxAttempts: 3,
  backoffBaseSeconds: 1,
  feeWaitSeconds: 60,
  rebroadcastSeconds: 0,
  maxEscrows: 50,
  scanLookbackBlocks: 5000,
  siteUrl: "http://site/",
  publicApiUrl: "http://api",
  allowedOrigins: ["http://site"],
  ...over,
});

export function milestone(index, over = {}) {
  return {
    index,
    status: "LOCKED",
    amount: "1000",
    revisionCount: 0,
    attemptCount: 0,
    deliveryDeadline: "0",
    stallEligibleAt: "0",
    graceExpiry: "0",
    unavailableSince: "0",
    appealExpiry: "0",
    appealUsed: false,
    appealOpen: false,
    appealFailureThreshold: "0",
    requiredAppealBond: "100",
    evidenceRecoveryDeadline: "0",
    ...over,
  };
}

export function snapshot(over = {}) {
  const project = {
    interfaceId: "genlayer.milestone-escrow.v2",
    client: CLIENT.address,
    worker: WORKER.address,
    status: "ACTIVE",
    milestoneCount: 2,
    totalFunded: "2000",
    totalReleased: "0",
    totalRefunded: "0",
    locked: "2000",
    depositCreditHeld: "0",
    totalRequired: "2000",
    queuedOut: "0",
    inflightOut: "0",
    bouncedHeld: "0",
    unmatchedHeld: "0",
    appealCreditHeld: "0",
    appealBondHeld: "0",
    settlement: { active: false, nonce: "0" },
    outflowCount: 0,
    ...(over.project || {}),
  };

  return {
    finality: "final",
    block: over.block ?? "1000",
    project,
    milestones: over.milestones || [milestone(0, { status: "AWAITING_DELIVERY" }), milestone(1)],
    outflows: over.outflows || [],
    chainTime: over.chainTime ?? NOW,
    balance: over.balance ?? { wei: 2000n },
    grants: over.grants === undefined ? null : over.grants,
  };
}

/** A fake chain exposing the interface src/chain.js provides. */
export function fakeChain({ snap = snapshot(), parties } = {}) {
  const c = {
    chainConfig: CHAIN,
    snap,
    nonces: new Map(), // address -> mined count
    mempool: new Map(), // hash -> raw
    receipts: new Map(),
    glTxs: new Map(),
    sent: [], // every raw passed to sendRawTransaction
    gasEstimate: 200_000n,
    gasPriceWei: 1_000_000_000n,
    behaviour: { send: "ok" }, // ok | timeout-after-accept | timeout-before-accept | reject | nonce-too-low
    failReads: 0,
    genlayerResult: () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE" }),

    txLogs: [], // { txId, block } of every GenLayer transaction sent to the escrow
    logsError: null,
    block: 1000,

    /** Finalized state only, as src/chain.js reads it ("latest-final"). */
    async snapshot() {
      if (c.failReads > 0) {
        c.failReads -= 1;
        throw new Error("rpc unavailable");
      }

      return { ...structuredClone(c.snap), block: String(c.block) };
    },
    async transactionsTo(_escrow, from, to) {
      if (c.logsError) throw new Error(c.logsError);
      return c.txLogs.filter((t) => BigInt(t.block) >= BigInt(from) && BigInt(t.block) <= BigInt(to)).map((t) => ({ ...t, block: String(t.block) }));
    },
    async verdictOf(txId) {
      const { classifyReceipt } = await import("../../dapp/src/workspace/finality.js");
      const tx = c.glTxs.get(txId);
      return classifyReceipt(tx ? { ...tx, recipient: ESCROW } : null, ESCROW);
    },
    /** An external wallet sends a GenLayer transaction to the escrow. */
    external({ status = "FINALIZED", ok = true, block = (c.block += 1) } = {}) {
      const txId = keccak256(toHex(`external:${c.txLogs.length}:${Math.random()}`));
      c.txLogs.push({ txId, block });
      c.glTxs.set(txId, { statusName: status, txExecutionResultName: ok ? "FINISHED_WITH_RETURN" : "FINISHED_WITH_ERROR", resultName: "AGREE" });
      return txId;
    },
    async attempts() {
      return c.attemptsList || [];
    },
    async parties() {
      return parties || { interface_id: "genlayer.milestone-escrow.v2", client: CLIENT.address, worker: WORKER.address };
    },
    async estimateGas() {
      if (c.estimateError) throw new Error(c.estimateError);
      return c.gasEstimate;
    },
    async gasPrice() {
      return c.gasPriceWei;
    },
    async pendingNonce(address) {
      const pending = [...c.mempool.values()].filter((raw) => parseTransaction(raw).from === undefined || true).length;
      return (c.nonces.get(address.toLowerCase()) || 0) + pending;
    },
    async latestNonce(address) {
      return c.nonces.get(address.toLowerCase()) || 0;
    },
    async sendRawTransaction(raw) {
      c.sent.push(raw);
      const hash = keccak256(raw);
      const mode = c.behaviour.send;

      if (mode === "timeout-before-accept") throw new Error("request timed out");
      if (mode === "reject") throw new Error("insufficient funds for gas * price + value");
      if (mode === "nonce-too-low") throw new Error("nonce too low");

      c.mempool.set(hash, raw);
      if (mode === "timeout-after-accept") throw new Error("request timed out");

      return hash;
    },
    async getReceipt(hash) {
      return c.receipts.get(hash) || null;
    },
    async getGenLayerTx(txId) {
      const tx = c.glTxs.get(txId);
      return tx ? { ...tx, recipient: ESCROW } : null;
    },
    async finalityWindow() {
      return { available: false };
    },

    /** Mine everything in the mempool: receipt with the consensus event. */
    mine({ status = "0x1", glResult } = {}) {
      c.block += 1;
      for (const [hash, raw] of c.mempool) {
        const tx = parseTransaction(raw);
        const txId = keccak256(toHex(`gl:${hash}`));
        const topics = encodeEventTopics({ abi: [NEW_TX], eventName: "NewTransaction", args: { txId, recipient: ESCROW, activator: OPERATOR.address } });

        c.txLogs.push({ txId, block: c.block });
        c.receipts.set(hash, {
          transactionHash: hash,
          status: status === "0x1" ? "success" : "reverted",
          blockNumber: BigInt(c.block),
          logs: [{ address: CHAIN.consensusMainContract.address, topics, data: "0x" }],
        });
        c.glTxs.set(txId, (glResult || c.genlayerResult)());
        c.nonces.set(OPERATOR.address.toLowerCase(), (c.nonces.get(OPERATOR.address.toLowerCase()) || 0) + 1);
        void tx;
      }

      c.mempool.clear();
    },
  };

  return c;
}

export async function signConsent(account, { role, scopes, maxAmount = "1000000", nonce = 1, expiresAt = NOW + 86400, email = "user@example.com", escrow = ESCROW, chainId = CHAIN.id }) {
  const { consentTypedData } = await import("../src/consent.js");
  const typed = consentTypedData({ chainId, escrow, signer: account.address, role, scopes, maxAmount, nonce, expiresAt, email });
  const signature = await account.signTypedData(typed);

  return {
    escrow,
    email,
    signature,
    message: { ...typed.message, maxAmount: typed.message.maxAmount.toString(), nonce: typed.message.nonce.toString(), expiresAt: typed.message.expiresAt.toString() },
  };
}

export async function signRevoke(account, { nonce, issuedAt = NOW, escrow = ESCROW, chainId = CHAIN.id }) {
  const { revokeTypedData } = await import("../src/consent.js");
  const typed = revokeTypedData({ chainId, escrow, signer: account.address, nonce, issuedAt });

  return {
    escrow,
    signature: await account.signTypedData(typed),
    message: { signer: account.address, nonce: String(nonce), issuedAt: String(issuedAt) },
  };
}
