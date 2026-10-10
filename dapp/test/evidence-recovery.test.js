import { describe, expect, it } from "vitest";
import { readMilestone } from "../src/escrow.js";
import { milestonePredicates } from "../src/predicates.js";
import { availableActions, isPermissionless } from "../src/actions.js";
import { METHODS } from "../src/methods.js";

const milestone = {
  index: 0, status: "EVIDENCE_UNAVAILABLE", appealOpen: false,
  evidenceRecoveryDeadline: "1000",
};

describe("unavailable evidence recovery", () => {
  it("preserves the grace boundary and cannot recover approved or inactive work", () => {
    expect(milestonePredicates(milestone, 999, 0).evidenceRecoverable).toBe(false);
    expect(milestonePredicates(milestone, 1000, 0).evidenceRecoverable).toBe(true);
    for (const change of [
      { status: "APPROVED" }, { status: "REFUND_PENDING" }, { appealOpen: true },
      { evidenceRecoveryDeadline: "0" },
    ]) {
      expect(milestonePredicates({ ...milestone, ...change }, 1001, 0).evidenceRecoverable).toBe(false);
    }
    expect(milestonePredicates(milestone, 1001, 1).evidenceRecoverable).toBe(false);
  });

  it("allows any connected role to recover, including a stalled replacement review", () => {
    expect(isPermissionless("recover_unavailable_evidence")).toBe(true);
    for (const role of ["client", "worker", "observer"]) {
      for (const status of ["EVIDENCE_UNAVAILABLE", "UNDER_REVIEW", "REVIEW_STALLED"]) {
        const actions = availableActions({ role, project: { status: "ACTIVE" },
          milestone: milestonePredicates({ ...milestone, status }, 1000, 0) });
        expect(actions.map((a) => a.action)).toContain("recover_unavailable_evidence");
      }
    }
    expect(METHODS.recover_unavailable_evidence.args(2)).toEqual([2]);
    expect(METHODS.recover_unavailable_evidence.payable).toBeUndefined();
  });

  it("keeps legacy deployments readable without advertising an absent method", async () => {
    const client = { readContract: async ({ functionName }) => {
      if (functionName === "get_milestone_evidence_recovery_deadline") throw new Error("unknown method");
      if (functionName === "get_milestone_status") return "EVIDENCE_UNAVAILABLE";
      return "0";
    } };
    const data = await readMilestone(client, "0x" + "ab".repeat(20), 0);
    expect(data.evidenceRecoveryDeadline).toBe("0");
    expect(milestonePredicates(data, 1000000, 0).evidenceRecoverable).toBe(false);
  });
});
