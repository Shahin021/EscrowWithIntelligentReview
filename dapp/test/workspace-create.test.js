import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { encodeEventTopics, keccak256, toHex } from "viem";

import {
  BASELINE, OBSERVED_GAS_CAP, deployConsensusCall, deployTxData, estimateDeployGas, projectGas,
  splitSources, validateProject, verifyCreatedProject,
} from "../src/workspace/create.js";
import { ARTIFACT, loadArtifact } from "../src/workspace/artifact.js";
import { createGuardedProvider } from "../src/workspace/guard.js";
import { sendTracked } from "../src/workspace/sender.js";
import { createJournal } from "../src/workspace/journal.js";
import { memoryStorage, safeStorage } from "../src/workspace/storage.js";

const ACCOUNT = "0x" + "a1".repeat(20);
const WORKER = "0x2a749c03a6DE888B7B42305b92032Fa9c1D54543";
const CODE = new Uint8Array(readFileSync(new URL("../public/contracts/project_escrow.packed.py", import.meta.url)));
const SOURCE = readFileSync(new URL("../../contracts/project_escrow.py", import.meta.url));

const form = (over = {}) => ({
  account: ACCOUNT,
  worker: WORKER,
  allowedSources: "raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview",
  renderMode: "text",
  maxRevisions: 3,
  continueAfterRefund: false,
  registry: "",
  milestones: [{ spec: "Design and deliver the landing page", amount: "1000", criteria: [] }],
  ...over,
});

afterEach(() => { delete globalThis.fetch; });

describe("the deployment artifact", () => {
  it("is the pinned packed build of the unchanged contract source", () => {
    expect(CODE.length).toBe(ARTIFACT.bytes);
    expect(createHash("sha256").update(CODE).digest("hex")).toBe(ARTIFACT.sha256);
    expect(createHash("sha256").update(SOURCE).digest("hex")).toBe(ARTIFACT.sourceSha256);
    expect(new TextDecoder().decode(CODE.slice(0, 90))).toMatch(/^# \{ "Depends": "py-genlayer:1jb45aa8/);
  });

  it("loadArtifact refuses a modified file", async () => {
    const changed = new Uint8Array(CODE); changed[200] ^= 1;
    const ok = await loadArtifact({ fetchImpl: async () => new Response(CODE), base: "http://x/" });
    expect(ok.length).toBe(CODE.length);
    await expect(loadArtifact({ fetchImpl: async () => new Response(changed), base: "http://x/" })).rejects.toThrow(/does not match/);
    await expect(loadArtifact({ fetchImpl: async () => new Response("", { status: 404 }), base: "http://x/" })).rejects.toThrow(/HTTP 404/);
  });
});

describe("form validation mirrors the constructor", () => {
  it("builds the exact constructor arguments", () => {
    const r = validateProject(form({ milestones: [{ spec: "  Spec  ", amount: "007", deliveryDays: "2",
      criteria: [{ text: "The page loads on mobile", required: true }, { text: "Lighthouse score above 90", required: false }] }] }));
    expect(r.ok).toBe(true);
    expect(r.args[0]).toBe(WORKER);
    expect(JSON.parse(r.args[1])).toEqual([{ spec: "Spec", amount: "7", criteria: [
      { text: "The page loads on mobile", required: true }, { text: "Lighthouse score above 90", required: false }],
      delivery_window_seconds: 172800 }]);
    expect(r.args.slice(2)).toEqual(["raw.githubusercontent.com/shahin021/escrowwithintelligentreview", "text", 3, false, ""]);
    expect(r.totalRequired).toBe("7");
  });

  it.each([
    [{ worker: "0x123" }, "worker"],
    [{ worker: ACCOUNT }, "worker"],
    [{ milestones: [] }, "milestones"],
    [{ milestones: Array.from({ length: 11 }, () => ({ spec: "x", amount: "1" })) }, "milestones"],
    [{ milestones: [{ spec: "", amount: "1" }] }, "milestones.0.spec"],
    [{ milestones: [{ spec: "a", amount: "0" }] }, "milestones.0.amount"],
    [{ milestones: [{ spec: "a", amount: "1.5" }] }, "milestones.0.amount"],
    [{ milestones: [{ spec: "a", amount: "1", criteria: [{ text: "short", required: true }] }] }, "milestones.0.criteria.0"],
    [{ milestones: [{ spec: "a", amount: "1", criteria: [{ text: "Long enough text", required: false }] }] }, "milestones.0.criteria"],
    [{ milestones: [{ spec: "a", amount: "1", criteria: [{ text: "Same criterion text", required: true }, { text: "same   CRITERION text", required: true }] }] }, "milestones.0.criteria.1"],
    [{ milestones: [{ spec: "a", amount: "1", criteria: [{ text: "Has a\ttab inside", required: true }] }] }, "milestones.0.criteria.0"],
    [{ milestones: [{ spec: "a", amount: "1", deliveryDays: "400" }] }, "milestones.0.deliveryDays"],
    [{ allowedSources: "  " }, "allowedSources"],
    [{ allowedSources: "a,b,c,d,e,f,g,h,i" }, "allowedSources"],
    [{ maxRevisions: 0 }, "maxRevisions"],
    [{ maxRevisions: 21 }, "maxRevisions"],
    [{ registry: "nope" }, "registry"],
  ])("rejects %j", (over, field) => {
    const r = validateProject(form(over));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toContain(field);
  });

  it("normalizes sources like the contract", () => {
    expect(splitSources(" https://Raw.GitHubusercontent.com/A/ ,, gist.github.com ")).toEqual(["raw.githubusercontent.com/a", "gist.github.com"]);
  });
});

describe("deployment size against Bradbury's observed gas cap", () => {
  it("projects the proven deployment at its measured estimate", () => {
    const p = projectGas(CODE, BASELINE.args);
    expect(p.projected).toBe(BASELINE.gasEstimate);
    expect(p.likelyFits).toBe(true);
  });

  it("a long multi-milestone project is projected over the cap", () => {
    const milestones = Array.from({ length: 4 }, (_, i) => ({
      spec: `Milestone ${i + 1}: ` + "deliver a documented, tested component. ".repeat(8), amount: "1000000000000000000",
      criteria: [{ text: "All acceptance tests in the repository pass", required: true }, { text: "Documentation covers every public function", required: true }],
    }));
    const r = validateProject(form({ milestones }));
    expect(r.ok).toBe(true);
    const p = projectGas(CODE, r.args);
    expect(p.likelyFits).toBe(false);
    expect(p.projected > OBSERVED_GAS_CAP).toBe(true);
  });

  it("the estimate prices the same consensus call the SDK sends", async () => {
    const r = validateProject(form());
    const seen = [];
    const readClient = { estimateTransactionGas: vi.fn(async (p) => { seen.push(p); return 16_200_000n; }) };
    const est = await estimateDeployGas(readClient, { chain: testnetBradbury, sender: ACCOUNT, code: CODE, constructorArgs: r.args, now: () => 1_800_000_000_000 });
    expect(est.fits).toBe(true);
    expect(seen[0].to).toBe(testnetBradbury.consensusMainContract.address);
    const call = deployConsensusCall({ chain: testnetBradbury, sender: ACCOUNT, code: CODE, constructorArgs: r.args, validUntil: 1_800_003_600 });
    expect(seen[0].data).toBe(call.data);
  });
});

describe("browser deployment through the real SDK and the guard", () => {
  function deployHarness() {
    const CONSENSUS = testnetBradbury.consensusMainContract;
    const NEW_TX = CONSENSUS.abi.find((e) => e.type === "event" && e.name === "NewTransaction");
    const CREATED = "0x" + "d3".repeat(20);
    const h = { sent: [], receipts: new Map() };
    const provider = { async request({ method, params }) {
      if (method === "eth_chainId") return "0x107d";
      if (method === "eth_accounts") return [ACCOUNT];
      if (method === "eth_sendTransaction") {
        h.sent.push(params[0]);
        const evm = keccak256(toHex(params[0].data.slice(0, 200)));
        const txId = keccak256(toHex(`gl:${evm}`));
        h.receipts.set(evm, { status: "success", blockNumber: 9n, logs: [{ address: CONSENSUS.address, data: "0x",
          topics: encodeEventTopics({ abi: [NEW_TX], eventName: "NewTransaction", args: { txId, recipient: CREATED, activator: ACCOUNT } }) }] });
        return evm;
      }
      throw new Error("unexpected " + method);
    } };
    globalThis.fetch = vi.fn(async (_u, init) => {
      const b = JSON.parse(init.body);
      const result = { eth_chainId: "0x107d", eth_getTransactionCount: "0x1", eth_estimateGas: "0xf60000", eth_gasPrice: "0x1", eth_blockNumber: "0x1" }[b.method];
      return new Response(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "n/a" } } : { jsonrpc: "2.0", id: b.id, result }));
    });
    const guard = createGuardedProvider({ provider, chainId: 4221, consensus: CONSENSUS });
    h.client = createClient({ chain: testnetBradbury, account: ACCOUNT, provider: guard });
    h.guard = guard; h.CREATED = CREATED; h.CONSENSUS = CONSENSUS;
    h.journal = createJournal(safeStorage(memoryStorage()));
    h.readClient = {
      getTransactionCount: async () => 1n,
      getBlockNumber: async () => 1n,
      getTransactionReceipt: async ({ hash }) => h.receipts.get(hash),
      getTransaction: async () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE", recipient: CREATED }),
    };
    return h;
  }

  it("sends exactly the reviewed code and the previewed constructor args, and learns the new address", async () => {
    const h = deployHarness();
    const r = validateProject(form());
    const entry = await sendTracked({ kind: "deploy", network: "testnetBradbury", chainId: 4221, account: ACCOUNT,
      code: CODE, constructorArgs: r.args, minGas: 15_000_000n, maxGas: OBSERVED_GAS_CAP, label: "Create project" },
      { client: h.client, guard: h.guard, journal: h.journal, readClient: h.readClient, consensus: h.CONSENSUS, sleep: async () => {}, polls: 2, intervalMs: 1 });
    expect(h.sent).toHaveLength(1);
    expect(entry.createdAddress.toLowerCase()).toBe(h.CREATED.toLowerCase());
    expect(entry.verdict.key).toBe("success");
    expect(deployTxData(CODE, r.args).length).toBeGreaterThan(CODE.length * 2);
  });

  it("keeps the chosen recovery window with the creation record and checks it after finality, read-only", async () => {
    const { verifyRecoveryWindow, recoveryCheckText } = await import("../src/workspace/one-tx.js");
    const h = deployHarness();
    const r = validateProject(form());
    const entry = await sendTracked({ kind: "deploy", network: "testnetBradbury", chainId: 4221, account: ACCOUNT,
      code: CODE, constructorArgs: r.args, minGas: 15_000_000n, maxGas: OBSERVED_GAS_CAP, label: "Create project", expectedRecoverySeconds: 604800, enrollment: { role: "client", email: "client@example.com", emailSalt: "ab".repeat(32) } },
      { client: h.client, guard: h.guard, journal: h.journal, readClient: h.readClient, consensus: h.CONSENSUS, sleep: async () => {}, polls: 2, intervalMs: 1 });
    expect(entry.expectedRecoverySeconds).toBe(604800);
    expect(h.journal.list().find((e) => e.id === entry.id).expectedRecoverySeconds).toBe(604800);
    expect(h.journal.list().find((e) => e.id === entry.id).enrollment.emailSalt).toBe("ab".repeat(32)); // durable before the wallet opened
    let onChain = "259200";
    const readContract = vi.fn(async ({ address, functionName, transactionHashVariant }) => {
      expect([address.toLowerCase(), functionName, transactionHashVariant]).toEqual([h.CREATED.toLowerCase(), "get_evidence_recovery_seconds", "latest-final"]);
      return onChain;
    });
    const checked = await verifyRecoveryWindow(entry, { readClient: { readContract }, journal: h.journal });
    expect(checked.recoveryCheck).toMatchObject({ state: "mismatch", expected: "604800", onChain: "259200" });
    expect(recoveryCheckText(checked)).toMatch(/MISMATCH.*168 hours.*72 hours.*Do not resend/);
    onChain = "604800";
    await verifyRecoveryWindow(h.journal.list().find((e) => e.id === entry.id), { readClient: { readContract }, journal: h.journal });
    expect(readContract).toHaveBeenCalledTimes(1); // a mismatch is final: the window is immutable
    expect(h.sent).toHaveLength(1); // the check never sends anything
  });

  it("refuses to sign if the code differs from the reviewed artifact", async () => {
    const h = deployHarness();
    const r = validateProject(form());
    const other = new Uint8Array(CODE); other[300] ^= 1;
    // the guard expects CODE but the SDK is handed `other`
    const slot = h.guard.arm({ account: ACCOUNT, value: 0n, expect: { kind: "deploy", codeHex: toHex(CODE),
      calldataHex: "0x" } });
    await expect(h.client.deployContract({ code: other, args: r.args })).rejects.toThrow();
    h.guard.disarm(slot);
    expect(h.sent).toHaveLength(0);
    expect(slot.refusal.message).toMatch(/not the reviewed artifact/);
  });
});

describe("verifying a created project", () => {
  it("passes only when the contract matches the form", async () => {
    const r = validateProject(form());
    const reads = { parties: { interface_id: "genlayer.milestone-escrow.v2", client: ACCOUNT, worker: WORKER, milestone_count: "1",
      total_required: "1000", project_status: "AWAITING_DEPOSIT" }, get_milestone_amount: "1000",
      get_milestone_spec: "Design and deliver the landing page", get_milestone_criteria_count: 1 };
    const client = { readContract: async ({ functionName }) => reads[functionName] };
    expect((await verifyCreatedProject(client, "0x" + "d3".repeat(20), { account: ACCOUNT, form: r, expectedInterface: "genlayer.milestone-escrow.v2" })).ok).toBe(true);
    reads.parties = { ...reads.parties, worker: ACCOUNT };
    const bad = await verifyCreatedProject(client, "0x" + "d3".repeat(20), { account: ACCOUNT, form: r, expectedInterface: "genlayer.milestone-escrow.v2" });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join()).toMatch(/worker/);
  });
});
