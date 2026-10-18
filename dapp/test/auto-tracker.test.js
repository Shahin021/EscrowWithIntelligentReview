import { describe, it, expect, vi, afterEach } from "vitest";
import { encodeAbiParameters, decodeFunctionData } from "viem";
import { testnetBradbury } from "genlayer-js/chains";
import { createAutoTracker, readFinalityWindow, windowLabel } from "../src/workspace/auto-tracker.js";
import { advance } from "../src/workspace/sender.js";
import { createJournal } from "../src/workspace/journal.js";
import { safeStorage } from "../src/workspace/storage.js";

afterEach(() => vi.useRealTimers());
describe("automatic read-only tracking", () => {
  it("never overlaps polls even when visibility/online wakes arrive during a read", async () => {
    vi.useFakeTimers();
    let release;
    const tick = vi.fn(() => new Promise((r) => { release = r; }));
    const tracker = createAutoTracker({ tick });
    const first = tracker.start();
    await tracker.wake(); await tracker.wake();
    await vi.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(1);
    release(); await first;
    await vi.advanceTimersByTimeAsync(15000);
    expect(tick).toHaveBeenCalledTimes(2);
    tracker.stop(); release();
  });
  it("pauses while hidden/offline and can wake immediately on return", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const tick = vi.fn();
    const tracker = createAutoTracker({ tick, enabled: () => enabled });
    await tracker.start(); await vi.advanceTimersByTimeAsync(30000);
    expect(tick).not.toHaveBeenCalled();
    enabled = true; await tracker.wake();
    expect(tick).toHaveBeenCalledTimes(1);
    tracker.stop(); await vi.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it("continues after a transient read failure", async () => {
    vi.useFakeTimers();
    const tick = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
    const tracker = createAutoTracker({ tick });
    await tracker.start(); await vi.advanceTimersByTimeAsync(15000);
    expect(tick).toHaveBeenCalledTimes(2); tracker.stop();
  });
  it("uses the real consensus ABI, latest chain time and eth_call without a wallet", async () => {
    const hash = "0x" + "ab".repeat(32);
    const client = {
      chain: testnetBradbury,
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1000n }),
      request: vi.fn().mockResolvedValue(encodeAbiParameters(
        [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }], [false, 1000n, 1800n])),
    };
    const result = await readFinalityWindow(client, hash);
    const rpc = client.request.mock.calls[0][0];
    expect(rpc.method).toBe("eth_call"); expect(rpc.params[1]).toBe("latest");
    expect(decodeFunctionData({ abi: testnetBradbury.consensusDataContract.abi, data: rpc.params[0].data }))
      .toMatchObject({ functionName: "canFinalize", args: [hash, 1000n] });
    expect(result).toMatchObject({ deadline: "1800", current: "1000", eligible: false });
  });
  it("does not interpret an unset deadline as 1970 or successful finality", () => {
    expect(windowLabel({ available: true, deadline: "0", current: "1000", readAt: 0 }, 0)).toContain("not set yet");
    expect(windowLabel({ available: true, deadline: "1000", current: "1000", readAt: 0 }, 0)).toContain("awaiting FINALIZED");
    expect(windowLabel({ available: true, deadline: "2000", current: "1000", readAt: 0 }, 91000)).toContain("stale");
    expect(windowLabel({ available: true, deadline: "1060", current: "1000", readAt: 0 }, 5000)).toContain("0m 55s");
  });
  it("resumes the durable journal after reload, then recognizes finalized execution failure without sending", async () => {
    vi.useFakeTimers();
    const map = new Map();
    const local = { getItem: (k) => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: (k) => map.delete(k) };
    const journal = createJournal(safeStorage(local));
    const project = "0x" + "12".repeat(20);
    journal.create({ id: "existing", phase: "tracking", network: "testnetBradbury", project,
      account: project, txId: "0x" + "ab".repeat(32), label: "Submit" });
    const reloaded = createJournal(safeStorage(local));
    let finalized = false;
    const readClient = { getTransaction: vi.fn(async () => ({ recipient: project,
      statusName: finalized ? "FINALIZED" : "ACCEPTED", resultName: "AGREE",
      txExecutionResultName: finalized ? "FINISHED_WITH_ERROR" : "FINISHED_WITH_RETURN" })) };
    const tracker = createAutoTracker({ tick: async () => {
      for (const e of reloaded.list({})) if (reloaded.isUnresolved(e)) {
        await advance(e, { readClient, consensus: {}, journal: reloaded });
      }
    } });
    await tracker.start();
    expect(reloaded.get("existing").phase).toBe("tracking");
    finalized = true; await vi.advanceTimersByTimeAsync(15000);
    expect(reloaded.get("existing").verdict.key).toBe("execution-failed");
    await vi.advanceTimersByTimeAsync(15000);
    expect(readClient.getTransaction).toHaveBeenCalledTimes(2);
    tracker.stop();
  });
});
