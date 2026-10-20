/** Read-only scheduler: deliberately has no wallet or send dependency. */
import { encodeFunctionData, decodeFunctionResult } from "viem";

export function createAutoTracker({ tick, enabled = () => true, intervalMs = 15000,
  schedule = setTimeout, cancel = clearTimeout, onError = () => {} }) {
  let stopped = true;
  let running = false;
  let timer = null;
  const wake = async () => {
    if (stopped || running) return;
    if (timer !== null) cancel(timer);
    timer = null;
    running = true;
    try { if (enabled()) await tick(); }
    catch (error) { onError(error); }
    finally {
      running = false;
      if (!stopped) timer = schedule(wake, intervalMs);
    }
  };
  return {
    start() { if (!stopped) return; stopped = false; return wake(); },
    wake,
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; },
  };
}

/** eth_call is intentional: the SDK readContract is for Intelligent Contracts. */
export async function readFinalityWindow(client, txId) {
  const config = client.chain?.consensusDataContract;
  if (!config?.abi?.some((f) => f.name === "canFinalize")) return { available: false };
  const block = await client.getBlock({ blockTag: "latest" });
  const data = encodeFunctionData({ abi: config.abi, functionName: "canFinalize", args: [txId, BigInt(block.timestamp)] });
  const result = await client.request({ method: "eth_call", params: [{ to: config.address, data }, "latest"] });
  const [eligible, current, deadline] = decodeFunctionResult({ abi: config.abi, functionName: "canFinalize", data: result });
  return { available: true, eligible, current: String(current), deadline: String(deadline), readAt: Date.now() };
}

export function windowLabel(window, now = Date.now()) {
  if (!window?.available) return "Network timing unavailable; tracking continues automatically.";
  const deadline = Number(window.deadline);
  const current = Number(window.current);
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(current) || deadline <= 0) {
    return "Consensus in progress; finalization time is not set yet.";
  }
  if (now - window.readAt > 90000) return "Network timing is stale; awaiting a fresh chain read.";
  const remaining = Math.max(0, deadline - current - Math.floor(Math.max(0, now - window.readAt) / 1000));
  if (remaining === 0) return "Network window elapsed; awaiting FINALIZED. This is not a success confirmation.";
  return `Network window: ${Math.floor(remaining / 60)}m ${remaining % 60}s remaining (estimate; finalization may follow later).`;
}
