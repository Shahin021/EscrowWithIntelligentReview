import { describe, expect, it, vi } from "vitest";

import { readMilestone, readProject, sendAction } from "../src/escrow.js";
import { TX_FAILED, TX_FINALIZED, TX_SUBMITTED } from "../src/tx.js";

const ADDRESS = "0x" + "ab".repeat(20);

function fakeClient(receipt) {
  return {
    readContract: vi.fn(async ({ functionName }) => {
      if (functionName === "parties") {
        return {
          interface_id: "genlayer.milestone-escrow.v2",
          client: "0x" + "c1".repeat(20),
          worker: "0x" + "a1".repeat(20),
          project_status: "ACTIVE",
          milestone_count: "2",
          total_funded: "1000",
          total_released: "0",
          total_refunded: "0",
        };
      }

      if (functionName === "get_accounting") {
        return {
          locked: "1000",
          queued_out: "0",
          inflight_out: "0",
          bounced_held: "0",
          unmatched_held: "0",
          appeal_credit_held: "0",
          appeal_bond_held: "0",
        };
      }

      if (functionName === "get_settlement") {
        return { active: false, proposer: "", nonce: "0" };
      }

      if (functionName === "get_milestone_status") return "AWAITING_DELIVERY";
      if (functionName === "get_milestone_amount") return "600";
      if (functionName === "get_milestone_revision_count") return "0";
      if (functionName === "get_attempt_count") return "0";

      return null;
    }),
    writeContract: vi.fn(async () => "0xdeadbeef"),
    waitForTransactionReceipt: vi.fn(async () => receipt),
  };
}

describe("reading", () => {
  it("maps the interface views onto a project view model", async () => {
    const project = await readProject(fakeClient(), ADDRESS);

    expect(project.status).toBe("ACTIVE");
    expect(project.milestoneCount).toBe(2);
    expect(project.locked).toBe("1000");
    expect(project.settlement.active).toBe(false);
  });

  it("reads a milestone", async () => {
    const milestone = await readMilestone(fakeClient(), ADDRESS, 0);

    expect(milestone.index).toBe(0);
    expect(milestone.status).toBe("AWAITING_DELIVERY");
    expect(milestone.amount).toBe("600");
  });
});

describe("sending an action", () => {
  it("reports submitted first and only then finalized", async () => {
    const client = fakeClient({ status_name: "FINALIZED" });
    const seen = [];

    const result = await sendAction(
      client,
      { address: ADDRESS, functionName: "resolve", args: [0] },
      (state) => seen.push(state),
    );

    expect(seen).toEqual([TX_SUBMITTED, TX_FINALIZED]);
    expect(result.state).toBe(TX_FINALIZED);
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: "0xdeadbeef",
      status: "FINALIZED",
    });
  });

  it("reports failure when execution errored despite finalizing", async () => {
    const client = fakeClient({
      status_name: "FINALIZED",
      txExecutionResultName: "FINISHED_WITH_ERROR",
    });
    const seen = [];

    const result = await sendAction(
      client,
      { address: ADDRESS, functionName: "claim_payment", args: [0] },
      (state) => seen.push(state),
    );

    expect(seen).toEqual([TX_SUBMITTED, TX_FAILED]);
    expect(result.state).toBe(TX_FAILED);
  });

  it("passes value through for payable actions", async () => {
    const client = fakeClient({ status_name: "FINALIZED" });

    await sendAction(client, {
      address: ADDRESS,
      functionName: "fund",
      value: 1000n,
    });

    expect(client.writeContract).toHaveBeenCalledWith({
      address: ADDRESS,
      functionName: "fund",
      args: [],
      value: 1000n,
    });
  });
});
