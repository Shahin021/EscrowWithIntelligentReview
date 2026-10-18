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

export function chainConfigFor(network) {
  const chain = chains[network];

  if (!chain) throw new Error(`Unsupported network ${network}`);

  return chain;
}

export function createChain({ network, rpcUrl }) {
  const chainConfig = chainConfigFor(network);
  const url = rpcUrl || chainConfig.rpcUrls.default.http[0];
  const gl = createClient({ chain: { ...chainConfig, rpcUrls: { default: { http: [url] } } } });
  const evm = createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 0 }) });

  return {
    chainConfig,

    async chainTime() {
      const block = await evm.getBlock({ blockTag: "latest" });

      return Number(block.timestamp);
    },

    async snapshot(escrow) {
      const project = await readProject(gl, escrow);
      const count = Math.min(project.milestoneCount, 20);
      const milestones = await Promise.all(Array.from({ length: count }, (_, i) => readMilestone(gl, escrow, i)));
      const outflows = await readOutflows(gl, escrow, project.outflowCount);
      const [chainTime, balance, grants] = await Promise.all([
        this.chainTime(),
        evm.getBalance({ address: escrow }).then((wei) => ({ wei })).catch((error) => ({ wei: null, error: String(error?.shortMessage || error?.message || error) })),
        Promise.all([
          gl.readContract({ address: escrow, functionName: "get_automation", args: ["client"] }),
          gl.readContract({ address: escrow, functionName: "get_automation", args: ["worker"] }),
        ])
          .then(([client, worker]) => ({ client, worker }))
          .catch(() => null), // contract without automation grants: party-only steps stay manual
      ]);

      return { project, milestones, outflows, chainTime, balance, grants };
    },

    attempts(escrow, milestoneCount) {
      return readAttempts(gl, escrow, milestoneCount).then((r) => r.attempts);
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
