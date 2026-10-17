import { describe, expect, it, vi } from "vitest";
import { testnetBradbury } from "genlayer-js/chains";

import { createJournal, PHASE_DONE, PHASE_PROMPTING, PHASE_SENT, PHASE_TRACKING } from "../src/workspace/journal.js";
import { memoryStorage, safeStorage } from "../src/workspace/storage.js";
import { classifyReceipt, collectProjectTransactions, scanNewTransactionLogs } from "../src/workspace/finality.js";
import { controllerConfig, parseProjectParam, resolveWorkspace } from "../src/workspace/project.js";
import { createProjectBook, inspectProject, registryCandidates } from "../src/workspace/projects.js";
import { criterionResults, milestoneTimeline, readAttempts } from "../src/workspace/history.js";
import { formatDuration, readContractBalance, recoveryPlan } from "../src/workspace/recovery.js";
import { connectSession, disconnectSession, restoreSession } from "../src/workspace/session.js";

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const P = "0x" + "c0".repeat(20);
const Q = "0x" + "d0".repeat(20);
const store = () => safeStorage(memoryStorage());
const tx = (h) => "0x" + h.repeat(64).slice(0, 64);

describe("project selection from the link", () => {
  it("reads ?project= and ignores malformed values with a reason", () => {
    expect(parseProjectParam(`?project=${P}`).address).toBe(P);
    expect(parseProjectParam("?project=0x12").problem).toMatch(/not a 20-byte/);
    expect(parseProjectParam("").address).toBeNull();
  });

  it("a link wins over the configured project, and no project is not a config error", () => {
    const env = { VITE_GENLAYER_NETWORK: "testnetBradbury", VITE_ESCROW_ADDRESS: Q };
    expect(resolveWorkspace(env, `?project=${P}`)).toMatchObject({ projectAddress: P, projectSource: "link" });
    expect(resolveWorkspace(env, "")).toMatchObject({ projectAddress: Q, projectSource: "configured" });
    const none = resolveWorkspace({}, "");
    expect(none.networkOk).toBe(true);
    expect(controllerConfig(none).ok).toBe(false);
    expect(controllerConfig(resolveWorkspace(env, "")).escrowAddress).toBe(Q);
  });
});

describe("journal", () => {
  it("separates network, project and account, and blocks a second unresolved identical call", () => {
    const j = createJournal(store());
    const b = { network: "testnetBradbury", project: P, account: A, functionName: "resolve", args: [0], value: 0n };
    const e = j.create(b);
    expect(e.phase).toBe(PHASE_PROMPTING);
    expect(j.findUnresolved(b)?.id).toBe(e.id);
    expect(j.findUnresolved({ ...b, account: B })).toBeNull();
    expect(j.findUnresolved({ ...b, project: Q })).toBeNull();
    expect(j.findUnresolved({ ...b, network: "testnetAsimov" })).toBeNull();
    expect(j.findUnresolved({ ...b, args: [1] })).toBeNull();
    j.update(e.id, { phase: PHASE_DONE });
    expect(j.findUnresolved(b)).toBeNull();
    expect(j.list({ project: P.toUpperCase().replace("0X", "0x") })).toHaveLength(1);
  });

  it("identifiers are write-once", () => {
    const j = createJournal(store());
    const e = j.create({ network: "n", project: P, account: A, functionName: "f", args: [] });
    j.update(e.id, { phase: PHASE_SENT, evmHash: tx("1") });
    const after = j.update(e.id, { evmHash: tx("2"), txId: tx("3") });
    expect(after.evmHash).toBe(tx("1"));
    expect(after.txId).toBe(tx("3"));
    expect(after.identifierConflict.field).toBe("evmHash");
  });

  it("refuses to record an intent when storage throws, but still lists (empty) for display", () => {
    const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
    const j = createJournal(safeStorage(broken));
    expect(() => j.create({ network: "n", project: P, account: A, functionName: "f", args: [] })).toThrow(/Writes are disabled/);
    expect(j.list({})).toEqual([]);
    expect(j.health().ok).toBe(false);
  });

  it("trims only settled history, never unresolved entries", () => {
    const j = createJournal(store());
    const pending = j.create({ network: "n", project: P, account: A, functionName: "keep", args: [] });
    for (let i = 0; i < 320; i += 1) {
      const e = j.create({ network: "n", project: P, account: A, functionName: "f", args: [i] });
      j.update(e.id, { phase: PHASE_DONE });
    }
    expect(j.get(pending.id)?.phase).toBe(PHASE_PROMPTING);
    expect(j.list({}).length).toBeLessThanOrEqual(300);
  });
});

describe("receipt classification: FINALIZED is not success by itself", () => {
  const base = { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "AGREE", recipient: P };
  it.each([
    [base, "success", true],
    [{ ...base, txExecutionResultName: "FINISHED_WITH_ERROR" }, "execution-failed", false],
    [{ ...base, resultName: "DISAGREE" }, "not-agreed", false],
    [{ ...base, resultName: undefined }, "finalized-unverified", false],
    [{ ...base, statusName: "ACCEPTED" }, "accepted", false],
    [{ ...base, statusName: "UNDETERMINED" }, "failed", false],
    [{ ...base, statusName: "LEADER_TIMEOUT" }, "failed", false],
    [{ ...base, recipient: Q }, "wrong-recipient", false],
    [null, "missing", false],
  ])("%j -> %s", (receipt, key, ok) => {
    const v = classifyReceipt(receipt, P);
    expect(v.key).toBe(key);
    expect(v.ok).toBe(ok);
  });

  it("numeric status and execution codes are understood", () => {
    expect(classifyReceipt({ status: 7, txExecutionResult: 1, resultName: "MAJORITY_AGREE", to_address: P }, P).key).toBe("success");
  });
});

describe("where a project's transactions come from", () => {
  it("merges published, journal, log and manual sources and labels each", () => {
    const list = collectProjectTransactions({
      project: P,
      published: { escrow: P, transactions: [{ label: "Deposit", hash: tx("1") }] },
      journalEntries: [{ project: P, txId: tx("1"), label: "Deposit", evmHash: tx("e") }, { project: Q, txId: tx("2") }],
      logs: [{ txId: tx("3"), evmHash: tx("f") }],
      manual: [tx("4"), "not-a-hash"],
    });
    expect(list.map((t) => [t.txId, t.sources])).toEqual([
      [tx("1"), ["published", "journal"]], [tx("3"), ["logs"]], [tx("4"), ["manual"]],
    ]);
  });

  it("published evidence of another escrow is not shown for this project", () => {
    expect(collectProjectTransactions({ project: Q, published: { escrow: P, transactions: [{ hash: tx("1") }] } })).toEqual([]);
  });

  it("log discovery reports the exact block range searched, or why it could not search", async () => {
    const consensus = testnetBradbury.consensusMainContract;
    const client = { getBlockNumber: async () => 12_000n, getLogs: vi.fn(async ({ fromBlock }) =>
      fromBlock === 10_000n ? [{ args: { txId: tx("9") }, transactionHash: tx("8"), blockNumber: 10_001n }] : []) };
    const r = await scanNewTransactionLogs(client, { consensus, project: P, fromBlock: 10_000n, chunk: 1000n });
    expect(r).toMatchObject({ ok: true, complete: true, scanned: { from: 10_000n, to: 12_000n } });
    expect(r.logs[0].txId).toBe(tx("9"));
    expect(client.getLogs.mock.calls[0][0].args).toEqual({ recipient: P });

    const refusing = { getBlockNumber: async () => 12_000n, getLogs: async () => { throw new Error("range too large"); } };
    const bad = await scanNewTransactionLogs(refusing, { consensus, project: P, fromBlock: 10_000n });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/refused for blocks 10000/);

    const partial = await scanNewTransactionLogs(client, { consensus, project: P, fromBlock: 0n, chunk: 1000n, maxChunks: 2 });
    expect(partial).toMatchObject({ ok: true, complete: false, scanned: { from: 0n, to: 1999n } });
  });
});

describe("the project book and the registry", () => {
  it("remembers projects per network with their sources", () => {
    const book = createProjectBook(store());
    book.remember("testnetBradbury", P, "created");
    book.remember("testnetBradbury", P.toUpperCase().replace("0X", "0x"), "saved");
    book.remember("testnetAsimov", Q, "saved");
    expect(book.list("testnetBradbury")).toEqual([expect.objectContaining({ address: P, sources: ["created", "saved"] })]);
    book.forget("testnetBradbury", P);
    expect(book.list("testnetBradbury")).toEqual([]);
  });

  it("registry candidates come only from the outcome log, filtered by party", async () => {
    const reports = [
      { escrow: P, party: A, outcome: "RELEASED", milestone: "0", amount: "5" },
      { escrow: Q, party: B, outcome: "REFUNDED", milestone: "0", amount: "1" },
    ];
    const client = { readContract: async ({ functionName, args }) => ({
      interface_id: "genlayer.escrow-registry.v1", report_count: "2", get_report: reports[args?.[0]] })[functionName] };
    const r = await registryCandidates(client, Q, A);
    expect(r.ok).toBe(true);
    expect(r.escrows).toEqual([{ address: P, outcomes: [{ outcome: "RELEASED", milestone: 0, amount: "5" }] }]);
    expect(r.complete).toBe(true);
  });

  it("the role comes from the contract, not from where the project was found", async () => {
    const client = { readContract: async () => ({ interface_id: "genlayer.milestone-escrow.v2", client: B, worker: A,
      project_status: "ACTIVE", milestone_count: "2", total_required: "9" }) };
    expect(await inspectProject(client, P, A, "genlayer.milestone-escrow.v2")).toMatchObject({ role: "worker", supported: true });
    expect(await inspectProject(client, P, "0x" + "99".repeat(20), "genlayer.milestone-escrow.v2")).toMatchObject({ role: "observer" });
    expect(await inspectProject(client, P, A, "other")).toMatchObject({ supported: false });
    const failing = { readContract: async () => { throw new Error("no contract"); } };
    expect(await inspectProject(failing, P, A, "x")).toMatchObject({ ok: false });
  });
});

describe("milestone history from the attempt log", () => {
  const views = {
    get_attempt_count: [2, 1],
    attempts: [
      { m: 0, kind: "INITIAL_SUBMISSION", verdict: "REJECTED", reason: "Missing tests", bits: "10" },
      { m: 1, kind: "INITIAL_SUBMISSION", verdict: "UNAVAILABLE", reason: "", bits: "" },
      { m: 0, kind: "REVISION_SUBMISSION", verdict: "APPROVED", reason: "All good", bits: "11" },
    ],
  };
  const client = { readContract: async ({ functionName, args }) => {
    if (functionName === "get_attempt_count") return views.get_attempt_count[args[0]];
    const a = views.attempts[args[0]];
    return { get_attempt_milestone: a.m, get_attempt_kind: a.kind, get_attempt_url: "https://x/" + args[0],
      get_attempt_notes: "", get_attempt_verdict: a.verdict, get_attempt_reason: a.reason, get_attempt_excerpt: "",
      get_attempt_evidence_hash: "", get_attempt_criteria_bits: a.bits, get_attempt_revision_after: 0 }[functionName];
  } };

  it("reads every attempt in the global append order and groups by milestone", async () => {
    const { total, attempts } = await readAttempts(client, P, 2);
    expect(total).toBe(3);
    const t = milestoneTimeline({ milestoneIndex: 0, attempts, outflows: [{ id: 0, milestone: 0, kind: "MILESTONE_PAYOUT", status: "CONFIRMED" }] });
    expect(t.events.map((e) => e.title)).toEqual(["Evidence submitted", "Revised evidence submitted", "MILESTONE_PAYOUT"]);
    expect(t.events[0].verdictLabel).toBe("Rejected");
    expect(t.limits.join(" ")).toMatch(/stores no time/);
  });

  it("per-criterion results only from stored bits", () => {
    const criteria = [{ text: "a", required: true }, { text: "b", required: false }];
    expect(criterionResults(criteria, "10")).toMatchObject({ available: true, results: [{ met: true }, { met: false }] });
    expect(criterionResults(criteria, "")).toMatchObject({ available: false });
    expect(criterionResults(criteria, "1")).toMatchObject({ available: false });
    expect(criterionResults(criteria, "1x")).toMatchObject({ available: false });
  });
});

describe("recovery steps", () => {
  const ledger = { locked: "0", depositCreditHeld: "0", appealCreditHeld: "0", appealBondHeld: "0", queuedOut: "0", bouncedHeld: "0", unmatchedHeld: "0",
    totalFunded: "1", totalReleased: "0", totalRefunded: "0" };
  const project = { status: "ACTIVE", client: A, canClose: false, inflightOut: "0", ...ledger };
  const m = (over = {}) => ({ index: 0, amount: "1", status: "EVIDENCE_UNAVAILABLE", appealOpen: false, evidenceRecoveryDeadline: "1000", ...over });

  it("counts down on chain time and only then offers recovery", () => {
    const before = recoveryPlan({ milestone: m(), project, outflows: [], chainTime: 400, activeIndex: 0 });
    expect(before.steps[0].state).toBe("waiting");
    expect(before.steps[0].detail).toMatch(/Opens in 10m/);
    expect(before.next).toBeNull();
    const after = recoveryPlan({ milestone: m(), project, outflows: [], chainTime: 1000, activeIndex: 0 });
    expect(after.eligible).toBe(true);
    expect(after.next).toBe("recover_unavailable_evidence");
  });

  it("an expired deadline is not a refund: settled only when CONFIRMED and REFUNDED", () => {
    const emitted = recoveryPlan({ milestone: m({ status: "REFUND_PENDING" }), project: { ...project, status: "SETTLING", inflightOut: "1" },
      outflows: [{ id: 0, milestone: 0, kind: "PROJECT_REMAINDER_REFUND", status: "EMITTED", amount: "1", recipient: A }], chainTime: 5000, activeIndex: 0,
      balance: { wei: 0n } });
    expect(emitted.settled).toBe(false);
    expect(emitted.next).toBe("confirm_outflow");
    expect(emitted.outflowId).toBe(0);
    const done = recoveryPlan({ milestone: m({ status: "REFUNDED" }), project: { ...project, status: "SETTLING", canClose: true, totalRefunded: "1" },
      outflows: [{ id: 0, milestone: 0, kind: "PROJECT_REMAINDER_REFUND", status: "CONFIRMED", amount: "1", recipient: A }], chainTime: 5000, activeIndex: 0 });
    expect(done.settled).toBe(true);
    expect(done.refundToClient).toBe(true);
    expect(done.next).toBe("close_project");
  });

  describe("confirming the refund needs the native transfer to have landed", () => {
    const emittedPlan = (balance, over = {}) => recoveryPlan({
      milestone: m({ status: "REFUND_PENDING" }),
      project: { ...project, status: "SETTLING", inflightOut: "1", locked: "5", ...over.project },
      outflows: [{ id: 0, milestone: 0, kind: "MILESTONE_REFUND", status: "EMITTED", amount: "1", recipient: A, ...over.outflow }],
      chainTime: 5000, activeIndex: 0, balance });

    it("delayed transfer: balance still includes the in-flight amount → waiting, nothing to press", () => {
      const p = emittedPlan({ wei: 6n });              // ledger 5 + in flight 1
      expect(p.steps[1].state).toBe("waiting");
      expect(p.steps[1].detail).toMatch(/has not landed yet/);
      expect(p.next).toBeNull();
      expect(p.settled).toBe(false);
    });

    it("transfer landed: balance equals the ledger without the in-flight amount → ready", () => {
      const p = emittedPlan({ wei: 5n });
      expect(p.steps[1].state).toBe("ready");
      expect(p.next).toBe("confirm_outflow");
      expect(p.settled).toBe(false);                   // ready to confirm is still not paid
    });

    it("balance unreadable → waiting with the reason; never ready", () => {
      const p = emittedPlan({ wei: null, error: "eth_getBalance refused" });
      expect(p.steps[1].state).toBe("waiting");
      expect(p.steps[1].detail).toMatch(/eth_getBalance refused/);
      expect(p.next).toBeNull();
      expect(emittedPlan(null).next).toBeNull();
    });

    it("balance matching neither side, or in-flight mismatch → blocked", () => {
      expect(emittedPlan({ wei: 9n }).steps[1].state).toBe("blocked");
      expect(emittedPlan({ wei: 5n }, { project: { inflightOut: "2" } }).steps[1].state).toBe("blocked");
    });

    it("an outflow that is not the expected refund is never confirmed or called settled", () => {
      for (const outflow of [{ recipient: "0x" + "99".repeat(20) }, { milestone: 1 }, { amount: "2" }, { kind: "MILESTONE_PAYOUT" }]) {
        const p = emittedPlan({ wei: 5n }, { outflow });
        expect(p.next, JSON.stringify(outflow)).toBeNull();
      }
      const confirmedWrong = recoveryPlan({ milestone: m({ status: "REFUNDED" }), project: { ...project, status: "SETTLING", totalRefunded: "1" },
        outflows: [{ id: 0, milestone: 0, kind: "MILESTONE_REFUND", status: "CONFIRMED", amount: "1", recipient: "0x" + "99".repeat(20) }], chainTime: 5000, activeIndex: 0 });
      expect(confirmedWrong.settled).toBe(false);
      expect(confirmedWrong.steps[1].label).toMatch(/does not match/);
    });

    it("CONFIRMED without REFUNDED is not settled", () => {
      const p = recoveryPlan({ milestone: m({ status: "REFUND_PENDING" }), project: { ...project, status: "SETTLING" },
        outflows: [{ id: 0, milestone: 0, kind: "MILESTONE_REFUND", status: "CONFIRMED", amount: "1", recipient: A }], chainTime: 5000, activeIndex: 0 });
      expect(p.settled).toBe(false);
    });

    it("reads the native balance, reporting an RPC failure instead of a number", async () => {
      expect(await readContractBalance({ getBalance: async () => 7n }, P)).toMatchObject({ wei: 7n });
      expect(await readContractBalance({ getBalance: async () => { throw new Error("refused"); } }, P)).toMatchObject({ wei: null, error: "refused" });
    });
  });

  it("blocked by an open appeal or a missing deadline; unknown chain time never says eligible", () => {
    expect(recoveryPlan({ milestone: m({ appealOpen: true }), project, outflows: [], chainTime: 9e9, activeIndex: 0 }).steps[0].state).toBe("blocked");
    expect(recoveryPlan({ milestone: m({ evidenceRecoveryDeadline: "0" }), project, outflows: [], chainTime: 9e9, activeIndex: 0 }).steps[0].state).toBe("blocked");
    expect(recoveryPlan({ milestone: m(), project, outflows: [], chainTime: null, activeIndex: 0 }).eligible).toBe(false);
    expect(recoveryPlan({ milestone: m({ status: "APPROVED" }), project, outflows: [], chainTime: 9e9, activeIndex: 0 })).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(3 * 86400 + 3600 * 2 + 60 * 5)).toBe("3d 2h 5m");
  });
});

describe("wallet session", () => {
  const wallet = (accounts = [A], chain = "0x107d") => ({ calls: [], async request({ method }) {
    this.calls.push(method);
    if (method === "eth_accounts") return accounts;
    if (method === "eth_chainId") return chain;
    if (method === "eth_requestAccounts") return accounts;
    throw new Error("unexpected " + method);
  } });

  it("restores silently with eth_accounts and eth_chainId only — no prompt, no Snap, no switch", async () => {
    const w = wallet();
    const make = vi.fn(() => ({ connect: vi.fn() }));
    const r = await restoreSession("testnetBradbury", { provider: w, prefs: store(), guard: {}, make });
    expect(r).toMatchObject({ restored: true, account: A, chainId: 4221 });
    expect(w.calls).toEqual(["eth_accounts", "eth_chainId"]);
    expect(make.mock.results[0].value.connect).not.toHaveBeenCalled();
  });

  it("explicit disconnect is honoured across refreshes until the user connects again", async () => {
    const prefs = store();
    disconnectSession("testnetBradbury", { prefs });
    const w = wallet();
    expect(await restoreSession("testnetBradbury", { provider: w, prefs, guard: {}, make: vi.fn() })).toMatchObject({ restored: false, reason: "explicitly-disconnected" });
    expect(w.calls).toEqual([]);
    const windowRef = { ethereum: wallet() };
    await connectSession("testnetBradbury", { windowRef, prefs, guard: {}, make: () => ({ connect: async () => {} }) });
    expect((await restoreSession("testnetBradbury", { provider: wallet(), prefs, guard: {}, make: vi.fn(() => ({})) })).restored).toBe(true);
  });

  it("nothing authorized: no restore and no prompt", async () => {
    const w = wallet([]);
    expect(await restoreSession("testnetBradbury", { provider: w, prefs: store(), guard: {}, make: vi.fn() })).toMatchObject({ restored: false, reason: "not-authorized" });
  });

  it("the kept client is built on the guarded provider", async () => {
    const guard = { request: vi.fn() };
    const make = vi.fn(() => ({ connect: async () => {} }));
    await connectSession("testnetBradbury", { windowRef: { ethereum: wallet() }, prefs: store(), guard, make });
    expect(make.mock.calls.at(-1)[0].provider).toBe(guard);
  });

  void PHASE_TRACKING;
});
