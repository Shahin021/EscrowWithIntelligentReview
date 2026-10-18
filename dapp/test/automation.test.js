import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { testnetBradbury } from "genlayer-js/chains";

import { ARTIFACTS, loadArtifact } from "../src/workspace/artifact.js";
import { OBSERVED_GAS_CAP, projectGas, validateProject } from "../src/workspace/create.js";
import { giveConsent, readGrants, revokeConsent, roleScopes, SCOPES } from "../src/workspace/automation-client.js";
import { automationPanel } from "../src/workspace/views.js";
import { METHODS } from "../src/methods.js";
import { verifyConsent, verifyRevoke } from "../../automation/src/consent.js";

const ESCROW = "0x" + "e5".repeat(20);
const CODE = new Uint8Array(readFileSync(new URL("../public/contracts/project_escrow_automation.packed.py", import.meta.url)));

describe("automation contract artifact", () => {
  it("is pinned by hash and size, and loads only when it matches", async () => {
    expect(CODE.length).toBe(ARTIFACTS.automation.bytes);
    expect(createHash("sha256").update(CODE).digest("hex")).toBe(ARTIFACTS.automation.sha256);
    const ok = await loadArtifact({ artifact: ARTIFACTS.automation, fetchImpl: async () => new Response(CODE), base: "http://x/" });
    expect(ok.length).toBe(CODE.length);
    await expect(loadArtifact({ artifact: ARTIFACTS.automation, fetchImpl: async () => new Response(CODE.slice(1)), base: "http://x/" })).rejects.toThrow(/does not match/);
  });

  it("stays within Bradbury's observed per-transaction gas cap for small projects (projection is relative to the proven deployment)", () => {
    const form = { worker: "0x" + "a1".repeat(20), milestones: [{ spec: "Publish the user guide for the API.", amount: "1000", criteria: [{ text: "Covers installation on Windows and Linux.", required: true }, { text: "Documents every error code.", required: true }] }], allowedSources: "https://github.com/", renderMode: "text", maxRevisions: 3 };
    const g = projectGas(CODE, validateProject(form).args);
    expect(g.projected).toBeLessThan(OBSERVED_GAS_CAP);
    expect(g.headroom).toBeGreaterThan(400_000n);
    // a larger artifact is projected higher, never measured against itself
    const v2 = new Uint8Array(readFileSync(new URL("../public/contracts/project_escrow.packed.py", import.meta.url)));
    expect(projectGas(CODE, validateProject(form).args).projected - projectGas(v2, validateProject(form).args).projected).toBe(BigInt(CODE.length - v2.length) * 860n);
  });

  it("set_automation is a plain non-payable call with the caller's own ceiling and expiry", () => {
    expect(METHODS.set_automation.args(0, { max_amount: "1000", expires_at: "1800000000" })).toEqual(["1000", 1800000000]);
    expect(METHODS.set_automation.payable).toBeUndefined();
  });
});

describe("consent signed in the site verifies in the service", () => {
  const worker = privateKeyToAccount(generatePrivateKey());
  const client = privateKeyToAccount(generatePrivateKey());
  const parties = { client: client.address, worker: worker.address };
  // A wallet double that signs eth_signTypedData_v4 exactly like MetaMask's payload shape.
  const wallet = (account) => ({
    request: vi.fn(async ({ method, params }) => {
      expect(method).toBe("eth_signTypedData_v4");
      const typed = JSON.parse(params[1]);
      const { EIP712Domain, ...types } = typed.types;
      expect(EIP712Domain.map((f) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
      return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
    }),
  });

  it("round-trips a worker consent and a revocation", async () => {
    let posted;
    globalThis.fetch = vi.fn(async (url, init) => {
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ scopes: "settle", email: "w…r@example.com" }), { status: 201 });
    });
    const now = Math.floor(Date.now() / 1000);
    await giveConsent({ provider: wallet(worker), base: "http://svc", chainId: testnetBradbury.id, escrow: ESCROW, account: worker.address, role: "worker", scopes: SCOPES.SETTLE, maxAmount: "1000", expiresAt: now + 86400, email: "worker@example.com" });
    const verified = await verifyConsent(posted, { chainId: testnetBradbury.id, parties, now, lastNonce: null });
    expect(verified.role).toBe("worker");
    expect(verified.scopes).toBe(SCOPES.SETTLE);

    await revokeConsent({ provider: wallet(worker), base: "http://svc", chainId: testnetBradbury.id, escrow: ESCROW, account: worker.address });
    expect((await verifyRevoke(posted, { chainId: testnetBradbury.id, now, lastNonce: verified.nonce })).signer).toBe(worker.address);
    delete globalThis.fetch;
  });

  it("refuses to ask for a step the role cannot have", async () => {
    await expect(giveConsent({ provider: wallet(client), base: "http://svc", chainId: 4221, escrow: ESCROW, account: client.address, role: "client", scopes: SCOPES.SETTLE, maxAmount: "1", expiresAt: 2e9, email: "c@example.com" })).rejects.toThrow(/available to your role/);
  });
});

describe("automation panel", () => {
  const base = { serviceUrl: "http://svc", info: { sendingEnabled: false, limits: {} }, status: null, chainTime: 1000, form: { scopes: 0, email: "", days: "30" }, busy: false, explorer: "https://e/" };

  it("without a service: manual path only", () => {
    expect(automationPanel({ ...base, serviceUrl: "" })).toContain("stays available manually");
  });

  it("an old contract shows claim/activation as manual and offers no grant", () => {
    const html = automationPanel({ ...base, grants: { supported: false }, role: "worker", account: "0x1", scopes: roleScopes("worker") });
    expect(html).toContain("stay manual");
    expect(html).not.toContain("data-auto-grant");
  });

  it("nothing is pre-selected; roles only see their own steps; observers only permissionless ones", () => {
    const worker = automationPanel({ ...base, grants: { supported: true, client: { max_amount: "0", expires_at: "0" }, worker: { max_amount: "0", expires_at: "0", version: "0" } }, role: "worker", account: "0x1", scopes: roleScopes("worker") });
    expect(worker).not.toMatch(/data-auto-scope="\d+" checked/);
    expect(worker).toContain("Claim and settle my approved payments");
    expect(worker).not.toContain("Activate funding after my exact deposit");
    expect(worker).toContain("data-auto-grant");
    const observer = roleScopes("observer").map((s) => s.bit);
    expect(observer).toEqual([SCOPES.REVIEW, SCOPES.RECOVER]);
    expect(roleScopes("client").map((s) => s.bit)).toEqual([SCOPES.REVIEW, SCOPES.RECOVER, SCOPES.ACTIVATE]);
  });

  it("reads on-chain grant support from the contract", async () => {
    const supported = { readContract: async ({ args }) => ({ interface: "genlayer.escrow-automation.v1", max_amount: "0", expires_at: "0", party: args[0] }) };
    const old = { readContract: async () => { throw new Error("no method get_automation"); } };
    expect((await readGrants(supported, ESCROW)).supported).toBe(true);
    expect((await readGrants(old, ESCROW)).supported).toBe(false);
  });
});
