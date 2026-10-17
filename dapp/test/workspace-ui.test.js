import { describe, expect, it, vi } from "vitest";

import { createController } from "../src/controller.js";
import { SUPPORTED_NETWORKS } from "../src/config.js";
import { milestoneTimeline } from "../src/workspace/history.js";
import { recoveryPlan } from "../src/workspace/recovery.js";
import {
  activityPanel,
  createPanel,
  criteriaBlock,
  escape,
  finalityPanel,
  historyBlock,
  projectsPanel,
  recoveryBlock,
} from "../src/workspace/views.js";

const ESCROW = "0x" + "ab".repeat(20);
const CLIENT = "0x" + "c1".repeat(20);
const WORKER = "0x" + "a1".repeat(20);
const TX = "0x" + "12".repeat(32);

function client(outflows, milestone = { status: "REFUNDED", amount: "400" }) {
  return {
    readContract: vi.fn(async ({ functionName, args }) => {
      if (functionName === "parties") {
        return { interface_id: "genlayer.milestone-escrow.v2", client: CLIENT, worker: WORKER, project_status: "SETTLING", milestone_count: "1", total_required: "400", total_funded: "400", total_released: "0", total_refunded: "400" };
      }
      if (functionName === "get_accounting") return { locked: "0", queued_out: "0", inflight_out: "0", bounced_held: "0", unmatched_held: "0", deposit_credit_held: "0", appeal_credit_held: "0", appeal_bond_held: "0" };
      if (functionName === "get_settlement") return { active: false, nonce: "0" };
      if (functionName === "get_outflow_count") return String(outflows.length);
      if (functionName.startsWith("get_outflow_")) {
        const o = outflows[args[0]];

        return { get_outflow_kind: o.kind, get_outflow_status: o.status, get_outflow_amount: o.amount, get_outflow_recipient: o.recipient, get_outflow_milestone: "0" }[functionName];
      }
      if (functionName === "get_milestone_status") return milestone.status;
      if (functionName === "get_milestone_amount") return milestone.amount;
      if (functionName === "get_milestone_evidence_recovery_deadline") return "100";

      return "0";
    }),
  };
}

describe("controller keeps every transfer for history and recovery", () => {
  it("a CONFIRMED refund is kept in allOutflows and makes the recovery plan settled", async () => {
    const refund = { kind: "MILESTONE_REFUND", status: "CONFIRMED", amount: "400", recipient: CLIENT };
    const c = createController({ config: { ok: true, escrowAddress: ESCROW, network: "testnetBradbury" }, networkInfo: SUPPORTED_NETWORKS.testnetBradbury });

    await c.refresh(client([refund]), 200);

    expect(c.state.outflows).toHaveLength(0); // not actionable
    expect(c.state.allOutflows).toHaveLength(1);

    const plan = recoveryPlan({ milestone: c.state.milestones[0], project: c.state.project, outflows: c.state.allOutflows, chainTime: 200, activeIndex: -1 });

    expect(plan.settled).toBe(true);
    expect(plan.refundToClient).toBe(true);
  });

  it("an EMITTED refund is not settled: it still needs confirming", async () => {
    const refund = { kind: "MILESTONE_REFUND", status: "EMITTED", amount: "400", recipient: CLIENT };
    const c = createController({ config: { ok: true, escrowAddress: ESCROW, network: "testnetBradbury" }, networkInfo: SUPPORTED_NETWORKS.testnetBradbury });

    await c.refresh(client([refund], { status: "REFUND_PENDING", amount: "400" }), 200);

    // The fixture's ledger is all zero, so a landed transfer leaves 0 wei.
    c.state.project.inflightOut = "400";
    const plan = recoveryPlan({ milestone: c.state.milestones[0], project: c.state.project, outflows: c.state.allOutflows, chainTime: 200, activeIndex: 0, balance: { wei: 0n } });
    const html = recoveryBlock(plan, { writable: true, busy: false, deadlineText: "x" });

    expect(plan.settled).toBe(false);
    expect(plan.next).toBe("confirm_outflow");
    expect(html).toContain("Confirm the refund transfer");
    expect(html).toContain("counts as paid only when its transfer is CONFIRMED");
  });

  it("reads use the read client passed in, not the wallet client", async () => {
    const c = createController({ config: { ok: true, escrowAddress: ESCROW, network: "testnetBradbury" }, networkInfo: SUPPORTED_NETWORKS.testnetBradbury });
    const wallet = client([]);
    const reader = client([]);

    c.setWallet({ client: wallet, account: CLIENT, chainId: 4221 });
    await c.refresh(reader, 200);

    expect(reader.readContract).toHaveBeenCalled();
    expect(wallet.readContract).not.toHaveBeenCalled();
  });
});

describe("views say what each source does and does not prove", () => {
  it("escapes every interpolated value", () => {
    expect(escape('<img src=x onerror="a">')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");

    const html = activityPanel({ entries: [{ id: "1", label: "<b>x</b>", account: CLIENT, createdAt: 0, phase: "prompting" }], explorer: "https://e/" });

    expect(html).not.toContain("<b>x</b>");
  });

  it("registry membership is labelled as reporting permission, not validity or ownership", () => {
    const html = projectsPanel({
      rows: [{ address: ESCROW, sources: ["registry"], registered: true, info: { ok: true, supported: true, status: "ACTIVE", role: "observer", milestoneCount: 1 } }],
      current: null, account: CLIENT, registry: "0x" + "33".repeat(20), registryResult: { ok: true, escrows: [], scanned: { from: 0, to: 9, total: 10 }, complete: true }, busy: false,
    });

    expect(html).toContain("does not prove the project is valid or who owns it");
    expect(html).toContain("Only finished milestones are reported there");
  });

  it("finality states that the project address alone is not a history source", () => {
    const html = finalityPanel({ project: ESCROW, rows: [{ txId: TX, sources: ["logs"], verdict: { ok: false, label: "Finalized · success unverified" } }], scan: { ok: true, complete: false, logs: [], scanned: { from: 10n, to: 99n }, latest: 500n }, busy: false, explorer: "https://e/" });

    expect(html).toContain("The project address alone is not a history source");
    expect(html).toContain("blocks 10–99");
    expect(html).toContain("not complete; search again from 100");
    expect(html).toContain("0 / 1 finalized with successful execution");
  });

  it("criteria results appear only when the stored bits match the rubric", () => {
    const rubric = { rubricHash: "0xabc", criteria: [{ text: "A criterion here", required: true }, { text: "Another criterion", required: false }] };

    expect(criteriaBlock(rubric, { criteriaBits: "10" })).toContain("Not met");
    expect(criteriaBlock(rubric, { criteriaBits: "" })).not.toMatch(/>Met<|Not met/);
    expect(criteriaBlock(rubric, { criteriaBits: "1" })).toContain("does not match");
    expect(criteriaBlock(rubric, null)).toContain("No attempt has been reviewed yet");
  });

  it("history states the contract's limits and never invents times", () => {
    const timeline = milestoneTimeline({ milestoneIndex: 0, attempts: [{ index: 0, milestone: 0, kind: "INITIAL_SUBMISSION", url: "https://x.org", notes: "", verdict: "REJECTED", reason: "r", excerpt: "", evidenceHash: "", criteriaBits: "", revisionAfter: 0 }], outflows: [] });
    const html = historyBlock(timeline, { explorer: "https://e/" });

    expect(html).toContain("stores no time for each attempt");
    expect(html).toContain("Rejected");
  });

  it("create panel shows the exact constructor arguments and the gas cap warning", () => {
    const form = { worker: WORKER, milestones: [{ spec: "s", amount: "1", criteria: [] }], allowedSources: "", renderMode: "text", maxRevisions: "3", continueAfterRefund: false, registry: "" };
    const preview = { ok: true, account: CLIENT, args: [WORKER, "[]", "", "text", 3, false, ""], totalRequired: "1", gas: { txDataBytes: 30000, projected: 20_000_000n, likelyFits: false } };
    const html = createPanel(form, { preview, estimate: { gas: 17_000_000n, fits: false }, canDeploy: false, deployReason: "over the cap" });

    expect(html).toContain("observed per-transaction gas cap. Shorten");
    expect(html).toContain("<b>over the observed cap</b>");
    expect(html).toContain("disabled>Create project");
  });

  it("a possibly-sent entry offers a chain search and hash attach, and 'not sent' only after a releasable chain check", () => {
    const base = { id: "p1", label: "Fund", account: CLIENT, createdAt: 0, phase: "prompting", possiblySent: true };
    const before = activityPanel({ entries: [base], explorer: "https://e/" });

    expect(before).toContain("Possibly sent");
    expect(before).toContain("Look for it on chain");
    expect(before).toContain("data-attach-form");
    expect(before).not.toContain("data-release");
    expect(before).not.toMatch(/resend|send again/i);

    const advanced = activityPanel({ entries: [{ ...base, lastCheck: { releasable: false, reason: "This account has sent a transaction since the prompt" } }], explorer: "https://e/" });

    expect(advanced).not.toContain("data-release");
    expect(advanced).toContain("has sent a transaction since the prompt");

    const clear = activityPanel({ entries: [{ ...base, lastCheck: { releasable: true, reason: "nonce has not advanced", search: { ok: true, from: "1", to: "9" } } }], explorer: "https://e/" });

    expect(clear).toContain("data-release");
    expect(clear).toContain("blocks 1–9");
  });

  it("an emitted refund never offers confirmation while the balance is unknown or the transfer is in flight", () => {
    const html = recoveryBlock(
      recoveryPlan({
        milestone: { index: 0, amount: "400", status: "REFUND_PENDING", evidenceRecoveryDeadline: "1" },
        project: { client: CLIENT, status: "SETTLING", inflightOut: "400", locked: "0", depositCreditHeld: "0", appealCreditHeld: "0", appealBondHeld: "0", queuedOut: "0", bouncedHeld: "0", unmatchedHeld: "0" },
        outflows: [{ id: 0, milestone: 0, kind: "MILESTONE_REFUND", status: "EMITTED", amount: "400", recipient: CLIENT }],
        chainTime: 10,
        activeIndex: 0,
        balance: { wei: 400n },
      }),
      { writable: true, busy: false, deadlineText: "x" },
    );

    expect(html).toContain("has not landed yet");
    expect(html).not.toContain("data-recovery-action");
  });
});
