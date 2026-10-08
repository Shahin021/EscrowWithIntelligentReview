import { beforeEach, describe, expect, it, vi } from "vitest";

import { createController } from "../src/controller.js";
import { SUPPORTED_NETWORKS } from "../src/config.js";

const ESCROW = "0x" + "ab".repeat(20);
const CLIENT = "0x" + "c1".repeat(20);
const WORKER = "0x" + "a1".repeat(20);
const STRANGER = "0x" + "99".repeat(20);

const NOW = 1_800_000_000;
const DAY = 86400;

const config = { ok: true, escrowAddress: ESCROW, network: "testnetBradbury" };
const networkInfo = SUPPORTED_NETWORKS.testnetBradbury;

/** A chain fixture built from the contract's real view names. */
function chainState(overrides = {}) {
  return {
    status: "ACTIVE",
    milestoneCount: 2,
    locked: "1000",
    total_required: "1000",
    deposit_credit_held: "0",
    deposits_received: "1000",
    deposits_refunded: "0",
    queued_out: "0",
    inflight_out: "0",
    bounced_held: "0",
    unmatched_held: "0",
    appeal_credit_held: "0",
    appeal_bond_held: "0",
    settlement: { active: false, proposer: "", to_worker: "0", to_client: "0", nonce: "3" },
    outflows: [],
    milestones: [
      { status: "AWAITING_DELIVERY", amount: "600" },
      { status: "LOCKED", amount: "400" },
    ],
    ...overrides,
  };
}

function fakeClient(scenario) {
  const milestoneValue = (index, fn) => {
    const m = scenario.milestones[index] || {};
    const defaults = {
      get_milestone_status: m.status,
      get_milestone_amount: m.amount,
      get_milestone_revision_count: m.revisions || "0",
      get_attempt_count: m.attempts || "0",
      get_milestone_delivery_deadline: m.deliveryDeadline || "0",
      get_milestone_stall_eligible_at: m.stallEligibleAt || "0",
      get_milestone_unavailable_grace_expiry: m.graceExpiry || "0",
      get_milestone_unavailable_since: m.unavailableSince || "0",
      get_milestone_appeal_expiry: m.appealExpiry || "0",
      get_milestone_appeal_used: m.appealUsed || false,
      get_milestone_appeal_open: m.appealOpen || false,
      get_milestone_appeal_failure_threshold: m.appealThreshold || "0",
      get_milestone_required_appeal_bond: m.requiredBond || "60",
    };

    return defaults[fn];
  };

  return {
    writes: [],
    readContract: vi.fn(async ({ functionName, args }) => {
      if (functionName === "parties") {
        return {
          interface_id: scenario.interface_id || "genlayer.milestone-escrow.v2",
          client: CLIENT,
          worker: WORKER,
          project_status: scenario.status,
          milestone_count: String(scenario.milestoneCount),
          total_required: scenario.total_required || "1000",
          total_funded: "1000",
          total_released: "0",
          total_refunded: "0",
        };
      }

      if (functionName === "get_accounting") return scenario;
      if (functionName === "get_settlement") return scenario.settlement;
      if (functionName === "get_outflow_count") return String(scenario.outflows.length);

      if (functionName.startsWith("get_outflow_")) {
        const o = scenario.outflows[args[0]];
        const map = {
          get_outflow_kind: o.kind,
          get_outflow_status: o.status,
          get_outflow_amount: o.amount,
          get_outflow_recipient: o.recipient,
          get_outflow_milestone: String(o.milestone || 0),
        };

        return map[functionName];
      }

      return milestoneValue(args[0], functionName);
    }),
    writeContract: vi.fn(async function (call) {
      this.writes.push(call);

      return "0xhash";
    }),
    waitForTransactionReceipt: vi.fn(async () => ({ status_name: "FINALIZED" })),
  };
}

async function loaded(scenario, { account = WORKER, chainId = 4221 } = {}) {
  const client = fakeClient(scenario);
  const controller = createController({ config, networkInfo });

  controller.setWallet({ client, account, chainId });
  await controller.refresh(client, NOW);

  return { controller, client };
}

describe("exact calls sent to the client", () => {
  it("funds with the typed amount as the payable value", async () => {
    const { controller, client } = await loaded(
      chainState({ status: "AWAITING_DEPOSIT" }),
      { account: CLIENT },
    );

    await controller.dispatch("fund", { input: { amount: "1000" } });

    expect(client.writeContract).toHaveBeenCalledWith({
      address: ESCROW,
      functionName: "fund",
      args: [],
      value: 1000n,
    });
  });

  it("submits evidence with the milestone index, url and notes", async () => {
    const { controller, client } = await loaded(chainState());

    await controller.dispatch("submit_deliverable", {
      milestoneIndex: 0,
      input: { artifact_url: "https://raw.githubusercontent.com/a/b/c/d.html", notes: "first" },
    });

    expect(client.writeContract).toHaveBeenCalledWith({
      address: ESCROW,
      functionName: "submit_deliverable",
      args: [0, "https://raw.githubusercontent.com/a/b/c/d.html", "first"],
      value: 0n,
    });
  });

  it("replaces evidence on the milestone it was clicked for", async () => {
    const scenario = chainState({
      milestones: [
        { status: "RELEASED", amount: "600" },
        { status: "UNDER_REVIEW", amount: "400" },
      ],
    });
    const { controller, client } = await loaded(scenario);

    await controller.dispatch("replace_evidence", {
      milestoneIndex: 1,
      input: { artifact_url: "https://x/y/z" },
    });

    expect(client.writeContract.mock.calls[0][0].args).toEqual([
      1,
      "https://x/y/z",
      "",
    ]);
  });

  it("sends resolve and the timed actions with the milestone index", async () => {
    const { controller, client } = await loaded(
      chainState({ milestones: [{ status: "UNDER_REVIEW", amount: "600" }], milestoneCount: 1 }),
      { account: STRANGER },
    );

    await controller.dispatch("resolve", { milestoneIndex: 0 });

    expect(client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "resolve",
      args: [0],
      value: 0n,
    });
  });

  it("appeals with the note and funds credit as a payable call", async () => {
    const { controller, client } = await loaded(
      chainState({
        milestones: [
          {
            status: "REJECTED_FINAL",
            amount: "600",
            appealExpiry: String(NOW + DAY),
          },
        ],
        milestoneCount: 1,
      }),
    );

    await controller.dispatch("fund_appeal_credit", { input: { amount: "60" } });
    await controller.dispatch("appeal", {
      milestoneIndex: 0,
      input: { note: "please re-check" },
    });

    expect(client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "fund_appeal_credit",
      args: [],
      value: 60n,
    });
    expect(client.writeContract.mock.calls[1][0]).toMatchObject({
      functionName: "appeal",
      args: [0, "please re-check"],
      value: 0n,
    });
  });

  it("withdraws credit with a decimal string amount", async () => {
    const { controller, client } = await loaded(
      chainState({ appeal_credit_held: "250" }),
    );

    await controller.dispatch("withdraw_appeal_credit", { input: { amount: "250" } });

    expect(client.writeContract.mock.calls[0][0].args).toEqual(["250"]);
  });

  it("proposes a settlement with both amounts as strings", async () => {
    const { controller, client } = await loaded(chainState(), { account: CLIENT });

    await controller.dispatch("propose_settlement", {
      input: { to_worker: "600", to_client: "400" },
    });

    expect(client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "propose_settlement",
      args: ["600", "400"],
      value: 0n,
    });
  });

  it("accepts a settlement with the nonce read from the contract", async () => {
    const scenario = chainState({
      settlement: {
        active: true,
        proposer: CLIENT,
        to_worker: "600",
        to_client: "400",
        nonce: "7",
      },
    });
    const { controller, client } = await loaded(scenario);

    // The user never types the nonce.
    await controller.dispatch("accept_settlement", {});

    expect(client.writeContract.mock.calls[0][0].args).toEqual([7]);
  });

  it("confirms and redirects a specific outflow by id", async () => {
    const scenario = chainState({
      outflows: [
        { kind: "MILESTONE_PAYOUT", status: "CONFIRMED", amount: "600", recipient: WORKER },
        { kind: "MILESTONE_PAYOUT", status: "EMITTED", amount: "400", recipient: WORKER },
      ],
      inflight_out: "400",
    });
    const { controller, client } = await loaded(scenario);

    await controller.dispatch("confirm_outflow", { outflowId: 1 });

    expect(client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "confirm_outflow",
      args: [1],
    });

    await controller.dispatch("redirect_outflow", {
      outflowId: 1,
      input: { to: WORKER },
    });

    expect(client.writeContract.mock.calls[1][0].args).toEqual([1, WORKER]);
  });

  it("refuses a call whose required input is missing", async () => {
    const { controller, client } = await loaded(chainState());

    await expect(
      controller.dispatch("submit_deliverable", { milestoneIndex: 0, input: {} }),
    ).rejects.toThrow(/Missing input for submit_deliverable: artifact_url/);

    expect(client.writeContract).not.toHaveBeenCalled();
  });

  it("refuses a malformed amount or address instead of sending it", async () => {
    const { controller, client } = await loaded(chainState());

    await expect(
      controller.dispatch("fund_appeal_credit", { input: { amount: "1.5" } }),
    ).rejects.toThrow(/whole number of wei/);

    await expect(
      controller.dispatch("redirect_outflow", { outflowId: 0, input: { to: "0x123" } }),
    ).rejects.toThrow(/20-byte hex address/);

    expect(client.writeContract).not.toHaveBeenCalled();
  });
});

describe("network and account changes", () => {
  it("disables writes when the wallet is on another chain", async () => {
    const { controller, client } = await loaded(chainState(), { chainId: 1 });

    expect(controller.correctNetwork).toBe(false);
    expect(controller.writesEnabled).toBe(false);
    expect(controller.networkWarning).toMatch(/chain 1.*Bradbury.*4221/s);

    await expect(
      controller.dispatch("resolve", { milestoneIndex: 0 }),
    ).rejects.toThrow(/Switch the network/);

    expect(client.writeContract).not.toHaveBeenCalled();
  });

  it("re-enables writes when the wallet switches back", async () => {
    const { controller } = await loaded(chainState(), { chainId: 1 });

    controller.setChainId(4221);

    expect(controller.correctNetwork).toBe(true);
    expect(controller.writesEnabled).toBe(true);
    expect(controller.networkWarning).toBeNull();
  });

  it("follows an account change into a different role", async () => {
    const { controller } = await loaded(chainState(), { account: WORKER });

    expect(controller.role()).toBe("worker");

    controller.setAccount(CLIENT);
    expect(controller.role()).toBe("client");

    controller.setAccount(null);
    expect(controller.role()).toBe("observer");
    expect(controller.writesEnabled).toBe(false);
  });
});

describe("multiple milestones and outflows", () => {
  it("offers actions per milestone, not only the first", async () => {
    const scenario = chainState({
      milestones: [
        { status: "RELEASED", amount: "600" },
        { status: "AWAITING_DELIVERY", amount: "400" },
      ],
    });
    const { controller } = await loaded(scenario);

    const rows = controller.actionsByMilestone();

    expect(rows).toHaveLength(2);
    expect(rows[0].milestoneIndex).toBe(0);
    expect(rows[0].actions.map((a) => a.action)).not.toContain("submit_deliverable");
    expect(rows[1].actions.map((a) => a.action)).toContain("submit_deliverable");
  });

  it("lists outflows and only lets the recipient redirect a bounced one", async () => {
    const scenario = chainState({
      outflows: [
        { kind: "MILESTONE_PAYOUT", status: "BOUNCED", amount: "600", recipient: WORKER },
      ],
      bounced_held: "600",
    });

    const asWorker = await loaded(scenario, { account: WORKER });
    const workerRow = asWorker.controller.outflowRows()[0];

    expect(workerRow.id).toBe(0);
    expect(workerRow.actions).toContain("redirect_outflow");

    const asClient = await loaded(scenario, { account: CLIENT });
    const clientRow = asClient.controller.outflowRows()[0];

    expect(clientRow.actions).not.toContain("redirect_outflow");
    expect(clientRow.redirectBlockedReason).toMatch(/Only the recipient/);
  });
});

describe("timed actions come from contract timestamps", () => {
  it("offers expiry only once the contract's deadline has passed", async () => {
    const notYet = await loaded(
      chainState({
        milestones: [
          { status: "AWAITING_DELIVERY", amount: "600", deliveryDeadline: String(NOW + 60) },
        ],
        milestoneCount: 1,
      }),
    );

    expect(
      notYet.controller.actionsByMilestone()[0].actions.map((a) => a.action),
    ).not.toContain("expire_delivery");

    const due = await loaded(
      chainState({
        milestones: [
          { status: "AWAITING_DELIVERY", amount: "600", deliveryDeadline: String(NOW) },
        ],
        milestoneCount: 1,
      }),
    );

    expect(
      due.controller.actionsByMilestone()[0].actions.map((a) => a.action),
    ).toContain("expire_delivery");
  });

  it("offers an appeal only inside the window and finalization only after it", async () => {
    const inside = await loaded(
      chainState({
        milestones: [
          { status: "REJECTED_FINAL", amount: "600", appealExpiry: String(NOW + 60) },
        ],
        milestoneCount: 1,
      }),
    );

    const insideActions = inside.controller
      .actionsByMilestone()[0]
      .actions.map((a) => a.action);

    expect(insideActions).toContain("appeal");
    expect(insideActions).not.toContain("finalize_rejection");

    const after = await loaded(
      chainState({
        milestones: [
          { status: "REJECTED_FINAL", amount: "600", appealExpiry: String(NOW) },
        ],
        milestoneCount: 1,
      }),
    );

    const afterActions = after.controller
      .actionsByMilestone()[0]
      .actions.map((a) => a.action);

    expect(afterActions).not.toContain("appeal");
    expect(afterActions).toContain("finalize_rejection");
  });

  it("offers the stall marker only at the contract's threshold", async () => {
    const due = await loaded(
      chainState({
        milestones: [
          { status: "UNDER_REVIEW", amount: "600", stallEligibleAt: String(NOW) },
        ],
        milestoneCount: 1,
      }),
    );

    expect(
      due.controller.actionsByMilestone()[0].actions.map((a) => a.action),
    ).toContain("mark_review_stalled");
  });
});

describe("no deployment configured", () => {
  it("keeps writes disabled and sends nothing", async () => {
    const controller = createController({
      config: { ok: false, escrowAddress: null },
      networkInfo,
    });

    controller.setWallet({ client: fakeClient(chainState()), account: WORKER, chainId: 4221 });

    expect(controller.writesEnabled).toBe(false);

    await expect(controller.dispatch("resolve", { milestoneIndex: 0 })).rejects.toThrow(
      /Writes are disabled/,
    );
  });
});

describe("proposer versus counterparty, and permissionless calls", () => {
  it("lets the proposer withdraw and the counterparty accept", async () => {
    const scenario = chainState({
      settlement: {
        active: true,
        proposer: CLIENT,
        to_worker: "600",
        to_client: "400",
        nonce: "4",
      },
    });

    const asClient = await loaded(scenario, { account: CLIENT });
    const clientActions = asClient.controller
      .projectActions()
      .map((a) => a.action);

    expect(clientActions).toContain("withdraw_settlement");
    expect(clientActions).not.toContain("accept_settlement");

    await asClient.controller.dispatch("withdraw_settlement", {});

    expect(asClient.client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "withdraw_settlement",
      args: [],
      value: 0n,
    });

    const asWorker = await loaded(scenario, { account: WORKER });
    const workerActions = asWorker.controller
      .projectActions()
      .map((a) => a.action);

    expect(workerActions).toContain("accept_settlement");
    expect(workerActions).not.toContain("withdraw_settlement");
  });

  it("sends the permissionless project calls with no arguments", async () => {
    const scenario = chainState({
      status: "SETTLING",
      locked: "0",
      unmatched_held: "25",
      milestones: [{ status: "CANCELLED", amount: "600" }],
      milestoneCount: 1,
    });
    const { controller, client } = await loaded(scenario, { account: STRANGER });

    await controller.dispatch("sweep_unmatched", {});
    await controller.dispatch("close_project", {});

    expect(client.writeContract.mock.calls.map((c) => c[0])).toMatchObject([
      { functionName: "sweep_unmatched", args: [], value: 0n },
      { functionName: "close_project", args: [], value: 0n },
    ]);
  });

  it("emits the next queued transfer when nothing is in flight", async () => {
    const scenario = chainState({
      outflows: [
        { kind: "MILESTONE_PAYOUT", status: "QUEUED", amount: "600", recipient: WORKER },
      ],
      queued_out: "600",
    });
    const { controller, client } = await loaded(scenario);

    const actions = controller.projectActions().map((a) => a.action);

    expect(actions).toContain("emit_next_outflow");

    await controller.dispatch("emit_next_outflow", {});

    expect(client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "emit_next_outflow",
      args: [],
    });
  });

  it("offers closing only when the ledger is actually idle", async () => {
    const busy = await loaded(
      chainState({
        status: "SETTLING",
        locked: "0",
        inflight_out: "400",
        outflows: [
          { kind: "SETTLEMENT_CLIENT", status: "EMITTED", amount: "400", recipient: CLIENT },
        ],
        milestones: [{ status: "CANCELLED", amount: "600" }],
        milestoneCount: 1,
      }),
      { account: CLIENT },
    );

    const busyActions = busy.controller.projectActions().map((a) => a.action);

    expect(busyActions).toContain("confirm_outflow");
    expect(busyActions).not.toContain("close_project");
  });
});

describe("account switching cannot reuse the old signer", () => {
  /** Each fake client is bound to the account it was created for. */
  function boundClient(scenario, account) {
    const client = fakeClient(scenario);
    const write = client.writeContract;

    client.boundTo = account;
    client.writeContract = vi.fn(async (call) => {
      if (client.boundTo !== client.currentSigner) {
        throw new Error(
          `client bound to ${client.boundTo} cannot sign for ${client.currentSigner}`,
        );
      }

      return write.call(client, call);
    });
    client.currentSigner = account;

    return client;
  }

  it("drops the old client and blocks writes until reconnect", async () => {
    const scenario = chainState();
    const workerClient = boundClient(scenario, WORKER);
    const controller = createController({ config, networkInfo });

    controller.setWallet({ client: workerClient, account: WORKER, chainId: 4221 });
    await controller.refresh(workerClient, NOW);

    expect(controller.writesEnabled).toBe(true);

    // The wallet switches to the client's account.
    controller.setAccount(CLIENT);

    expect(controller.state.account).toBe(CLIENT);
    expect(controller.role()).toBe("client");

    // The stale, worker-bound client must not be used.
    expect(controller.state.client).toBeNull();
    expect(controller.writesEnabled).toBe(false);
    expect(controller.reconnectWarning).toMatch(/Reconnect to sign as/);

    await expect(
      controller.dispatch("propose_settlement", {
        input: { to_worker: "600", to_client: "400" },
      }),
    ).rejects.toThrow(/Reconnect to sign as/);

    expect(workerClient.writeContract).not.toHaveBeenCalled();
  });

  it("works again once a client for the new account is supplied", async () => {
    const scenario = chainState();
    const workerClient = boundClient(scenario, WORKER);
    const controller = createController({ config, networkInfo });

    controller.setWallet({ client: workerClient, account: WORKER, chainId: 4221 });
    await controller.refresh(workerClient, NOW);

    controller.setAccount(CLIENT);

    const clientClient = boundClient(scenario, CLIENT);

    controller.setWallet({ client: clientClient, account: CLIENT, chainId: 4221 });
    await controller.refresh(clientClient, NOW);

    expect(controller.writesEnabled).toBe(true);
    expect(controller.reconnectWarning).toBeNull();

    await controller.dispatch("propose_settlement", {
      input: { to_worker: "600", to_client: "400" },
    });

    expect(clientClient.writeContract).toHaveBeenCalledTimes(1);
    expect(workerClient.writeContract).not.toHaveBeenCalled();
  });

  it("disables writes when the wallet disconnects every account", async () => {
    const scenario = chainState();
    const client = boundClient(scenario, WORKER);
    const controller = createController({ config, networkInfo });

    controller.setWallet({ client, account: WORKER, chainId: 4221 });
    await controller.refresh(client, NOW);

    controller.setAccount(null);

    expect(controller.state.account).toBeNull();
    expect(controller.state.client).toBeNull();
    expect(controller.writesEnabled).toBe(false);
    expect(controller.role()).toBe("observer");

    await expect(
      controller.dispatch("resolve", { milestoneIndex: 0 }),
    ).rejects.toThrow(/Writes are disabled|Reconnect/);

    expect(client.writeContract).not.toHaveBeenCalled();
  });
});

describe("project actions are not repeated per milestone", () => {
  it("lists project-wide actions once across several milestones", async () => {
    const scenario = chainState({
      milestoneCount: 3,
      milestones: [
        { status: "RELEASED", amount: "300" },
        { status: "AWAITING_DELIVERY", amount: "400" },
        { status: "LOCKED", amount: "300" },
      ],
      appeal_credit_held: "50",
    });
    const { controller } = await loaded(scenario, { account: WORKER });

    const projectActions = controller.projectActions().map((a) => a.action);
    const rows = controller.actionsByMilestone();

    expect(rows).toHaveLength(3);

    // Project-wide work appears exactly once, in the project section.
    for (const action of [
      "fund_appeal_credit",
      "withdraw_appeal_credit",
      "propose_settlement",
    ]) {
      expect(projectActions.filter((a) => a === action)).toHaveLength(1);

      const repeated = rows.flatMap((row) =>
        row.actions.map((a) => a.action).filter((a) => a === action),
      );

      expect(repeated).toEqual([]);
    }

    // Milestone work stays with its milestone.
    expect(rows[1].actions.map((a) => a.action)).toContain("submit_deliverable");
    expect(rows[0].actions.map((a) => a.action)).not.toContain("submit_deliverable");
  });

  it("keeps settling and closing in the project section only", async () => {
    const scenario = chainState({
      status: "SETTLING",
      locked: "0",
      milestoneCount: 2,
      milestones: [
        { status: "CANCELLED", amount: "600" },
        { status: "CANCELLED", amount: "400" },
      ],
    });
    const { controller } = await loaded(scenario, { account: CLIENT });

    expect(controller.projectActions().map((a) => a.action)).toContain(
      "close_project",
    );

    for (const row of controller.actionsByMilestone()) {
      expect(row.actions.map((a) => a.action)).not.toContain("close_project");
    }
  });
});

describe("the three-step funding flow", () => {
  const awaitingDeposit = (overrides = {}) =>
    chainState({
      status: "AWAITING_DEPOSIT",
      locked: "0",
      total_required: "1000",
      deposits_received: "0",
      milestones: [
        { status: "LOCKED", amount: "600" },
        { status: "LOCKED", amount: "400" },
      ],
      ...overrides,
    });

  it("deposits any amount as a payable call", async () => {
    const { controller, client } = await loaded(awaitingDeposit(), {
      account: CLIENT,
    });

    const actions = controller.projectActions().map((a) => a.action);

    expect(actions).toContain("fund");
    // Nothing to activate or withdraw before a deposit exists.
    expect(actions).not.toContain("activate_funding");
    expect(actions).not.toContain("withdraw_deposit_credit");

    await controller.dispatch("fund", { input: { amount: "999" } });

    expect(client.writeContract).toHaveBeenCalledWith({
      address: ESCROW,
      functionName: "fund",
      args: [],
      value: 999n,
    });
  });

  it("offers activation only when the credit matches exactly", async () => {
    const short = await loaded(
      awaitingDeposit({ deposit_credit_held: "999", deposits_received: "999" }),
      { account: CLIENT },
    );

    const shortActions = short.controller
      .projectActions()
      .map((a) => a.action);

    // A short deposit can be topped up or taken back, but not activated.
    expect(shortActions).toContain("fund");
    expect(shortActions).toContain("withdraw_deposit_credit");
    expect(shortActions).not.toContain("activate_funding");

    const exact = await loaded(
      awaitingDeposit({
        deposit_credit_held: "1000",
        deposits_received: "1000",
      }),
      { account: CLIENT },
    );

    expect(exact.controller.projectActions().map((a) => a.action)).toContain(
      "activate_funding",
    );
  });

  it("activates funding with no arguments and no value", async () => {
    const { controller, client } = await loaded(
      awaitingDeposit({
        deposit_credit_held: "1000",
        deposits_received: "1000",
      }),
      { account: CLIENT },
    );

    await controller.dispatch("activate_funding", {});

    expect(client.writeContract).toHaveBeenCalledWith({
      address: ESCROW,
      functionName: "activate_funding",
      args: [],
      value: 0n,
    });
  });

  it("withdraws surplus credit as a decimal string", async () => {
    const { controller, client } = await loaded(
      awaitingDeposit({ deposit_credit_held: "1500", deposits_received: "1500" }),
      { account: CLIENT },
    );

    await controller.dispatch("withdraw_deposit_credit", {
      input: { amount: "500" },
    });

    expect(client.writeContract.mock.calls[0][0]).toMatchObject({
      functionName: "withdraw_deposit_credit",
      args: ["500"],
      value: 0n,
    });
  });

  it("refuses a malformed withdrawal instead of sending it", async () => {
    const { controller, client } = await loaded(
      awaitingDeposit({ deposit_credit_held: "1500", deposits_received: "1500" }),
      { account: CLIENT },
    );

    await expect(
      controller.dispatch("withdraw_deposit_credit", {
        input: { amount: "12.5" },
      }),
    ).rejects.toThrow(/whole number of wei/);

    expect(client.writeContract).not.toHaveBeenCalled();
  });

  it("offers none of the funding steps to the worker", async () => {
    const { controller } = await loaded(
      awaitingDeposit({ deposit_credit_held: "1000", deposits_received: "1000" }),
      { account: WORKER },
    );

    const actions = controller.projectActions().map((a) => a.action);

    expect(actions).not.toContain("fund");
    expect(actions).not.toContain("activate_funding");
    expect(actions).not.toContain("withdraw_deposit_credit");
  });
});

describe("interface version is enforced, not just displayed", () => {
  it("refuses to drive a contract reporting another interface", async () => {
    const { controller, client } = await loaded(
      chainState({ interface_id: "genlayer.milestone-escrow.v1" }),
      { account: WORKER },
    );

    expect(controller.interfaceSupported).toBe(false);
    expect(controller.writesEnabled).toBe(false);
    expect(controller.interfaceWarning).toMatch(/v1.*v2/s);

    await expect(
      controller.dispatch("resolve", { milestoneIndex: 0 }),
    ).rejects.toThrow(/interface/i);

    expect(client.writeContract).not.toHaveBeenCalled();
  });

  it("allows writes on the expected interface", async () => {
    const { controller } = await loaded(chainState(), { account: WORKER });

    expect(controller.interfaceSupported).toBe(true);
    expect(controller.interfaceWarning).toBeNull();
    expect(controller.writesEnabled).toBe(true);
  });

  it("refuses to dispatch before the contract has been read", async () => {
    const client = fakeClient(chainState());
    const controller = createController({ config, networkInfo });

    // Wallet connected and on the right chain, but no refresh has run, so
    // the interface is unconfirmed.
    controller.setWallet({ client, account: WORKER, chainId: 4221 });

    expect(controller.interfaceSupported).toBe(false);
    expect(controller.writesEnabled).toBe(false);
    expect(controller.interfaceWarning).toMatch(/not been read yet/i);

    await expect(
      controller.dispatch("resolve", { milestoneIndex: 0 }),
    ).rejects.toThrow(/interface is unconfirmed|not been read yet/i);

    expect(client.writeContract).not.toHaveBeenCalled();

    // Once the contract is read and reports the expected id, writes open.
    await controller.refresh(client, NOW);

    expect(controller.interfaceSupported).toBe(true);
    expect(controller.writesEnabled).toBe(true);
  });
});
