/**
 * Bradbury access for the service: GenLayer reads through genlayer-js, EVM
 * calls through a plain viem public client. Read-only except
 * sendRawTransaction, which only ever receives bytes the executor stored.
 */

import { createClient } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { createPublicClient, http } from "viem";

import { readMilestone, readOutflows, readProject } from "../../dapp/src/escrow.js";
import { readAttempts } from "../../dapp/src/workspace/history.js";
import { readFinalityWindow } from "../../dapp/src/workspace/auto-tracker.js";
import { classifyReceipt } from "../../dapp/src/workspace/finality.js";

export function chainConfigFor(network) {
  const chain = chains[network];

  if (!chain) throw new Error(`Unsupported network ${network}`);

  return chain;
}

export function createChain({ network, rpcUrl }, injected = {}) {
  const chainConfig = chainConfigFor(network);
  const url = rpcUrl || chainConfig.rpcUrls.default.http[0];
  const gl = injected.gl || createClient({ chain: { ...chainConfig, rpcUrls: { default: { http: [url] } } } });
  const evm = injected.evm || createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 0 }) });
  // Every decision and every notification reads FINALIZED contract state
  // ("latest-final"), never the SDK's default "latest-nonfinal": a step that
  // depends on an earlier one is only planned once that earlier one is final.
  const final = { ...gl, readContract: (args) => gl.readContract({ ...args, transactionHashVariant: "latest-final" }) };
  const newTx = chainConfig.consensusMainContract.abi.find((e) => e.type === "event" && e.name === "NewTransaction");

  return {
    chainConfig,

    async chainTime() {
      const block = await evm.getBlock({ blockTag: "latest" });

      return Number(block.timestamp);
    },

    /** Finalized contract state plus chain time, balance and block. */
    async snapshot(escrow) {
      const latestBlock = await evm.getBlock({ blockTag: "latest" });
      const project = await readProject(final, escrow);
      const count = Math.min(project.milestoneCount, 20);
      const milestones = await Promise.all(Array.from({ length: count }, (_, i) => readMilestone(final, escrow, i)));
      const outflows = await readOutflows(final, escrow, project.outflowCount);
      const [chainTime, balance, grants] = await Promise.all([
        Number(latestBlock.timestamp),
        evm.getBalance({ address: escrow }).then((wei) => ({ wei })).catch((error) => ({ wei: null, error: String(error?.shortMessage || error?.message || error) })),
        Promise.all([
          final.readContract({ address: escrow, functionName: "get_automation", args: ["client"] }),
          final.readContract({ address: escrow, functionName: "get_automation", args: ["worker"] }),
        ])
          .then(([client, worker]) => ({ client, worker }))
          .catch(() => null), // contract without automation grants: party-only steps stay manual
      ]);

      return { finality: "final", block: String(latestBlock.number), project, milestones, outflows, chainTime, balance, grants };
    },

    attempts(escrow, milestoneCount) {
      return readAttempts(final, escrow, milestoneCount).then((r) => r.attempts);
    },

    latestBlock: () => evm.getBlockNumber(),

    /** GenLayer transactions sent to `escrow` in [fromBlock, toBlock] (consensus NewTransaction logs). */
    async transactionsTo(escrow, fromBlock, toBlock) {
      const logs = await evm.getLogs({ address: chainConfig.consensusMainContract.address, event: newTx, args: { recipient: escrow }, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) });

      return logs.map((l) => ({ txId: l.args.txId, evmHash: l.transactionHash, block: String(l.blockNumber) }));
    },

    /** Classify one GenLayer transaction for `escrow` (FINALIZED is not success by itself). */
    async verdictOf(txId, escrow) {
      const tx = await gl.getTransaction({ hash: txId });

      return classifyReceipt(tx, escrow);
    },

    estimateGas: ({ from, to, data }) => evm.estimateGas({ account: from, to, data, value: 0n }),
    gasPrice: () => evm.getGasPrice(),
    pendingNonce: (address) => evm.getTransactionCount({ address, blockTag: "pending" }),
    latestNonce: (address) => evm.getTransactionCount({ address, blockTag: "latest" }),
    sendRawTransaction: (raw) => evm.sendRawTransaction({ serializedTransaction: raw }),

    async getReceipt(hash) {
      try {
        return await evm.getTransactionReceipt({ hash });
      } catch (error) {
        if (/could not be found|not found/i.test(String(error?.message))) return null;
        throw error;
      }
    },

    getGenLayerTx: (txId) => gl.getTransaction({ hash: txId }),
    finalityWindow: (txId) => readFinalityWindow(gl, txId),
    parties: (escrow) => gl.readContract({ address: escrow, functionName: "parties", args: [] }),
  };
}
