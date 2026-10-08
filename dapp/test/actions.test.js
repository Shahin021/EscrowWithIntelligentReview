import { describe, expect, it } from "vitest";

import {
  availableActions,
  isPermissionless,
  ROLE_CLIENT,
  ROLE_OBSERVER,
  ROLE_WORKER,
  roleOf,
  writesEnabled,
} from "../src/actions.js";

const CLIENT = "0x" + "c1".repeat(20);
const WORKER = "0x" + "a1".repeat(20);
const STRANGER = "0x" + "99".repeat(20);

const project = (overrides = {}) => ({
  status: "ACTIVE",
  client: CLIENT,
  worker: WORKER,
  account: null,
  locked: "1000",
  unmatchedHeld: "0",
  appealCreditHeld: "0",
  settlement: { active: false },
  canPropose: true,
  canClose: false,
  hasConfirmableOutflow: false,
  ...overrides,
});

// Timing flags mirror what predicates.js derives from the contract's own
// timestamp views, so these unit tests and the controller tests agree.
const milestone = (overrides = {}) => ({
  index: 0,
  status: "AWAITING_DELIVERY",
  appealUsed: false,
  appealOpen: false,
  appealable: false,
  appealAbortable: false,
  stallable: false,
  expirable: false,
  finalizable: false,
  ...overrides,
});

const names = (list) => list.map((a) => a.action);

describe("roles", () => {
  it("identifies client, worker and everyone else", () => {
    expect(roleOf(CLIENT, project())).toBe(ROLE_CLIENT);
    expect(roleOf(WORKER, project())).toBe(ROLE_WORKER);
    expect(roleOf(STRANGER, project())).toBe(ROLE_OBSERVER);
  });

  it("is case insensitive about addresses", () => {
    expect(roleOf(WORKER.toUpperCase(), project())).toBe(ROLE_WORKER);
  });

  it("treats a disconnected visitor as an observer", () => {
    expect(roleOf(null, project())).toBe(ROLE_OBSERVER);
  });
});

describe("funding", () => {
  it("offers funding to the client only", () => {
    const p = project({ status: "AWAITING_DEPOSIT" });

    expect(
      names(availableActions({ role: ROLE_CLIENT, project: p, milestone: null })),
    ).toContain("fund");

    expect(
      names(availableActions({ role: ROLE_WORKER, project: p, milestone: null })),
    ).not.toContain("fund");
  });
});

describe("worker workflow", () => {
  it("offers submission only when delivery is open", () => {
    for (const status of ["AWAITING_DELIVERY", "REVISION_REQUIRED"]) {
      const actions = names(
        availableActions({
          role: ROLE_WORKER,
          project: project(),
          milestone: milestone({ status }),
        }),
      );

      expect(actions).toContain("submit_deliverable");
    }

    const underReview = names(
      availableActions({
        role: ROLE_WORKER,
        project: project(),
        milestone: milestone({ status: "UNDER_REVIEW" }),
      }),
    );

    expect(underReview).not.toContain("submit_deliverable");
    expect(underReview).toContain("replace_evidence");
  });

  it("offers claiming only on an approved milestone", () => {
    expect(
      names(
        availableActions({
          role: ROLE_WORKER,
          project: project(),
          milestone: milestone({ status: "APPROVED" }),
        }),
      ),
    ).toContain("claim_payment");

    expect(
      names(
        availableActions({
          role: ROLE_WORKER,
          project: project(),
          milestone: milestone({ status: "UNDER_REVIEW" }),
        }),
      ),
    ).not.toContain("claim_payment");
  });

  it("offers an appeal once, and the abort only when it has failed", () => {
    const fresh = names(
      availableActions({
        role: ROLE_WORKER,
        project: project(),
        milestone: milestone({ status: "REJECTED_FINAL", appealable: true }),
      }),
    );

    expect(fresh).toContain("appeal");

    const used = names(
      availableActions({
        role: ROLE_WORKER,
        project: project(),
        milestone: milestone({
          status: "REJECTED_FINAL",
          appealUsed: true,
          appealable: false,
        }),
      }),
    );

    expect(used).not.toContain("appeal");

    const stalled = names(
      availableActions({
        role: ROLE_WORKER,
        project: project(),
        milestone: milestone({
          status: "UNDER_APPEAL",
          appealUsed: true,
          appealOpen: true,
          appealAbortable: true,
        }),
      }),
    );

    expect(stalled).toContain("abort_failed_appeal");
  });

  it("offers credit withdrawal only when credit exists", () => {
    const none = names(
      availableActions({
        role: ROLE_WORKER,
        project: project(),
        milestone: milestone(),
      }),
    );

    expect(none).toContain("fund_appeal_credit");
    expect(none).not.toContain("withdraw_appeal_credit");

    const some = names(
      availableActions({
        role: ROLE_WORKER,
        project: project({ appealCreditHeld: "100" }),
        milestone: milestone(),
      }),
    );

    expect(some).toContain("withdraw_appeal_credit");
  });

  it("never offers worker actions to the client or an observer", () => {
    for (const role of [ROLE_CLIENT, ROLE_OBSERVER]) {
      const actions = names(
        availableActions({
          role,
          project: project(),
          milestone: milestone({ status: "APPROVED" }),
        }),
      );

      expect(actions).not.toContain("claim_payment");
      expect(actions).not.toContain("submit_deliverable");
      expect(actions).not.toContain("appeal");
    }
  });
});

describe("settlement", () => {
  it("offers a proposal to both parties but not to an observer", () => {
    for (const role of [ROLE_CLIENT, ROLE_WORKER]) {
      expect(
        names(
          availableActions({ role, project: project(), milestone: milestone() }),
        ),
      ).toContain("propose_settlement");
    }

    expect(
      names(
        availableActions({
          role: ROLE_OBSERVER,
          project: project(),
          milestone: milestone(),
        }),
      ),
    ).not.toContain("propose_settlement");
  });

  it("offers acceptance to the counterparty and withdrawal to the proposer", () => {
    const p = project({
      account: CLIENT,
      settlement: { active: true, proposer: CLIENT },
    });

    expect(
      names(availableActions({ role: ROLE_CLIENT, project: p, milestone: milestone() })),
    ).toContain("withdraw_settlement");

    const asWorker = project({
      account: WORKER,
      settlement: { active: true, proposer: CLIENT },
    });

    expect(
      names(
        availableActions({
          role: ROLE_WORKER,
          project: asWorker,
          milestone: milestone(),
        }),
      ),
    ).toContain("accept_settlement");
  });
});

describe("permissionless and terminal states", () => {
  it("marks the deterministic timeouts as open to anyone", () => {
    for (const action of [
      "resolve",
      "confirm_outflow",
      "finalize_rejection",
      "sweep_unmatched",
      "close_project",
    ]) {
      expect(isPermissionless(action)).toBe(true);
    }

    expect(isPermissionless("claim_payment")).toBe(false);
    expect(isPermissionless("appeal")).toBe(false);
  });

  it("offers review to an observer when a review is open", () => {
    expect(
      names(
        availableActions({
          role: ROLE_OBSERVER,
          project: project(),
          milestone: milestone({ status: "UNDER_REVIEW" }),
        }),
      ),
    ).toContain("resolve");
  });

  it("offers only closing-related work while settling", () => {
    const actions = names(
      availableActions({
        role: ROLE_CLIENT,
        project: project({
          status: "SETTLING",
          canClose: true,
          hasConfirmableOutflow: true,
        }),
        milestone: milestone({ status: "CANCELLED" }),
      }),
    );

    expect(actions).toEqual(["confirm_outflow", "close_project"]);
  });

  it("offers nothing but a sweep once closed", () => {
    expect(
      names(
        availableActions({
          role: ROLE_CLIENT,
          project: project({ status: "CLOSED" }),
          milestone: milestone({ status: "RELEASED" }),
        }),
      ),
    ).toEqual([]);

    expect(
      names(
        availableActions({
          role: ROLE_OBSERVER,
          project: project({ status: "CLOSED", unmatchedHeld: "42" }),
          milestone: null,
        }),
      ),
    ).toEqual(["sweep_unmatched"]);
  });
});

describe("write gating", () => {
  it("requires configuration, a wallet and the right network", () => {
    expect(
      writesEnabled({ configOk: true, connected: true, correctNetwork: true }),
    ).toBe(true);

    expect(
      writesEnabled({ configOk: false, connected: true, correctNetwork: true }),
    ).toBe(false);

    expect(
      writesEnabled({ configOk: true, connected: false, correctNetwork: true }),
    ).toBe(false);

    expect(
      writesEnabled({ configOk: true, connected: true, correctNetwork: false }),
    ).toBe(false);
  });
});
