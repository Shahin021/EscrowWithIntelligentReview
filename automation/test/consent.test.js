import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCOPES, verifyConsent, verifyRevoke } from "../src/consent.js";
import { CHAIN, CLIENT, ESCROW, NOW, STRANGER, WORKER, signConsent, signRevoke } from "./helpers.js";

const parties = { client: CLIENT.address, worker: WORKER.address };
const ctx = (over = {}) => ({ chainId: CHAIN.id, parties, now: NOW, lastNonce: null, ...over });

describe("EIP-712 consent is bound to domain, chain, contract, signer, scopes, amount, nonce and expiry", () => {
  it("accepts a well-formed worker consent", async () => {
    const c = await verifyConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.SETTLE | SCOPES.REVIEW }), ctx());
    assert.equal(c.role, "worker");
    assert.equal(c.scopes, SCOPES.SETTLE | SCOPES.REVIEW);
    assert.equal(c.email, "user@example.com");
  });

  it("refuses replay on another network or another contract", async () => {
    const s = await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW });
    await assert.rejects(verifyConsent(s, ctx({ chainId: 61999 })), /does not match the signer/);
    await assert.rejects(verifyConsent({ ...s, escrow: "0x" + "77".repeat(20) }, ctx()), /does not match the signer/);
    const other = await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW, chainId: 1 });
    await assert.rejects(verifyConsent(other, ctx()), /does not match the signer/);
  });

  it("refuses a changed field (scope, amount, expiry or email) after signing", async () => {
    const s = await signConsent(WORKER, { role: "worker", scopes: SCOPES.REVIEW });
    await assert.rejects(verifyConsent({ ...s, message: { ...s.message, scopes: SCOPES.REVIEW | SCOPES.SETTLE } }, ctx()), /does not match/);
    await assert.rejects(verifyConsent({ ...s, message: { ...s.message, maxAmount: "99999999" } }, ctx()), /does not match/);
    await assert.rejects(verifyConsent({ ...s, email: "attacker@example.com" }, ctx()), /emailHash/);
  });

  it("a client cannot consent for the worker's step, nor the worker for the client's", async () => {
    await assert.rejects(verifyConsent(await signConsent(CLIENT, { role: "client", scopes: SCOPES.SETTLE }), ctx()), /not available to the client/);
    await assert.rejects(verifyConsent(await signConsent(WORKER, { role: "worker", scopes: SCOPES.ACTIVATE }), ctx()), /not available to the worker/);
    await assert.rejects(verifyConsent(await signConsent(CLIENT, { role: "worker", scopes: SCOPES.REVIEW }), ctx()), /is the client/);
  });

  it("a third party may ask only for permissionless steps", async () => {
    const ok = await verifyConsent(await signConsent(STRANGER, { role: "observer", scopes: SCOPES.REVIEW | SCOPES.RECOVER }), ctx());
    assert.equal(ok.role, "observer");
    await assert.rejects(verifyConsent(await signConsent(STRANGER, { role: "observer", scopes: SCOPES.SETTLE }), ctx()), /not available/);
    await assert.rejects(verifyConsent(await signConsent(STRANGER, { role: "worker", scopes: SCOPES.REVIEW }), ctx()), /is the observer/);
  });

  it("expiry, nonce and amount limits", async () => {
    await assert.rejects(verifyConsent(await signConsent(WORKER, { role: "worker", scopes: 1, expiresAt: NOW }), ctx()), /expiry/);
    await assert.rejects(verifyConsent(await signConsent(WORKER, { role: "worker", scopes: 1, expiresAt: NOW + 181 * 86400 }), ctx()), /expiry/);
    await assert.rejects(verifyConsent(await signConsent(WORKER, { role: "worker", scopes: 1, maxAmount: "0" }), ctx()), /maxAmount/);
    await assert.rejects(verifyConsent(await signConsent(WORKER, { role: "worker", scopes: 1, nonce: 5 }), ctx({ lastNonce: "5" })), /nonce/);
  });

  it("revocations are signed, bound to the contract and ordered by nonce", async () => {
    const r = await signRevoke(WORKER, { nonce: 2 });
    assert.equal((await verifyRevoke(r, { chainId: CHAIN.id, now: NOW, lastNonce: "1" })).signer, WORKER.address);
    await assert.rejects(verifyRevoke(r, { chainId: CHAIN.id, now: NOW, lastNonce: "2" }), /nonce/);
    await assert.rejects(verifyRevoke({ ...r, escrow: "0x" + "77".repeat(20) }, { chainId: CHAIN.id, now: NOW }), /does not match/);
    void ESCROW;
  });
});
