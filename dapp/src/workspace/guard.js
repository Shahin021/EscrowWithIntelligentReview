/**
 * The wallet boundary.
 *
 * genlayer-js reaches the wallet only through this object. A transaction is
 * forwarded to MetaMask only while exactly one write is armed, the wallet is
 * on the expected chain and account, and the transaction the SDK built is
 * exactly the expected call (or the exact reviewed deployment). One armed
 * write forwards at most one eth_sendTransaction: genlayer-js re-sends with a
 * different encoding after some errors, and that second prompt is refused.
 *
 * The EVM hash is handed to onSent the moment the wallet returns it, before
 * the SDK waits for anything, so a refresh or timeout cannot lose it.
 */

import { abi } from "genlayer-js";
import { decodeFunctionData, fromRlp, toHex, zeroAddress } from "viem";

const lower = (value) => String(value || "").toLowerCase();

/**
 * True only for an explicit refusal by the user or wallet (EIP-1193 4001).
 * Anything else after a transaction was handed to the wallet is ambiguous.
 */
export function isUserRejection(error) {
  let e = error;

  for (let depth = 0; e && depth < 6; depth += 1) {
    if (e.code === 4001 || /user rejected|user denied|rejected the request/i.test(e.message || "")) return true;
    e = e.cause;
  }

  return false;
}

export class GuardRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardRefusal";
  }
}

/** Exactly what genlayer-js puts in txData for a call. */
export function expectedCallData(functionName, args) {
  return toHex(abi.calldata.encode(abi.calldata.makeCalldataObject(functionName, args, undefined)));
}

/** Exactly what genlayer-js puts in txData for constructor arguments. */
export function expectedConstructorData(args) {
  return toHex(abi.calldata.encode(abi.calldata.makeCalldataObject(undefined, args, undefined)));
}

const NORMAL_FLAGS = new Set(["0x", "0x00"]);

/**
 * Decode an addTransaction call against the chain's consensus ABI and check
 * it against the expectation. Returns a list of problems (empty = exact).
 */
export function checkAddTransaction(data, { consensusAbi, sender, expect }) {
  let decoded;

  try {
    decoded = decodeFunctionData({ abi: consensusAbi, data });
  } catch (error) {
    return [`transaction data is not a consensus call: ${error.shortMessage || error.message}`];
  }

  if (decoded.functionName !== "addTransaction") {
    return [`consensus function ${decoded.functionName} is not addTransaction`];
  }

  const [glSender, recipient, , , txData] = decoded.args;
  const problems = [];

  if (lower(glSender) !== lower(sender)) problems.push(`GenLayer sender ${glSender} is not ${sender}`);

  let items;

  try {
    items = fromRlp(txData, "hex");
  } catch {
    return [...problems, "inner transaction data is not RLP"];
  }

  if (!Array.isArray(items) || items.some(Array.isArray)) {
    return [...problems, "inner transaction data has an unexpected shape"];
  }

  const flag = items[items.length - 1];

  if (!NORMAL_FLAGS.has(lower(flag))) problems.push(`execution mode ${flag} is not normal (leader-only refused)`);

  if (expect.kind === "deploy") {
    if (lower(recipient) !== lower(zeroAddress)) problems.push("a deployment must target the zero address");
    if (items.length !== 3) return [...problems, "deployment data must have code, calldata and mode"];
    if (lower(items[0]) !== lower(expect.codeHex)) problems.push("deployment code is not the reviewed artifact");
    if (lower(items[1]) !== lower(expect.calldataHex)) problems.push("constructor arguments differ from the preview");
  } else {
    if (lower(recipient) !== lower(expect.project)) problems.push(`GenLayer recipient ${recipient} is not the project`);
    if (items.length !== 2) return [...problems, "call data must have calldata and mode"];
    if (lower(items[0]) !== lower(expect.calldataHex)) problems.push(`call is not exactly ${expect.functionName}(…)`);
  }

  return problems;
}

export function createGuardedProvider({ provider, chainId, consensus, log = () => {} }) {
  let slot = null;

  async function guardSend(args) {
    const s = slot;

    if (!s) throw new GuardRefusal("No write is armed; the transaction was not sent.");
    if (s.forwarded) {
      throw new GuardRefusal(
        "A transaction was already sent to the wallet for this action; a second one is refused.",
      );
    }

    const tx = args?.params?.[0];

    if (!tx || typeof tx !== "object") throw new GuardRefusal("Missing transaction parameters.");

    const walletChain = Number.parseInt(await provider.request({ method: "eth_chainId" }), 16);

    if (walletChain !== chainId) {
      throw new GuardRefusal(`The wallet is on chain ${walletChain}, not ${chainId}; nothing was sent.`);
    }

    const accounts = await provider.request({ method: "eth_accounts" });

    if (!Array.isArray(accounts) || lower(accounts[0]) !== lower(s.account)) {
      throw new GuardRefusal("The wallet's account changed; nothing was sent.");
    }

    if (lower(tx.from) !== lower(s.account)) throw new GuardRefusal(`from ${tx.from} is not ${s.account}`);
    if (lower(tx.to) !== lower(consensus.address)) {
      throw new GuardRefusal(`to ${tx.to} is not the consensus contract ${consensus.address}`);
    }
    if (tx.chainId !== undefined && Number.parseInt(tx.chainId, 16) !== chainId) {
      throw new GuardRefusal(`chainId ${tx.chainId} is not ${chainId}`);
    }
    if (BigInt(tx.value ?? "0x0") !== BigInt(s.value ?? 0n)) {
      throw new GuardRefusal(`value ${tx.value} is not the expected ${s.value}`);
    }

    if (s.minGas !== undefined && s.minGas !== null) {
      const gas = tx.gas === undefined ? null : BigInt(tx.gas);

      if (gas === null || gas < BigInt(s.minGas)) {
        throw new GuardRefusal(
          `The SDK set gas ${gas ?? "none"}, below the read-only estimate ${s.minGas}; ` +
            "a transaction with too little gas would fail on-chain, so it was not sent.",
        );
      }

      if (s.maxGas && gas > BigInt(s.maxGas)) {
        throw new GuardRefusal(`gas ${gas} exceeds the per-transaction cap ${s.maxGas}; nothing was sent.`);
      }
    }

    const problems = checkAddTransaction(tx.data, {
      consensusAbi: consensus.abi,
      sender: s.account,
      expect: s.expect,
    });

    if (problems.length) throw new GuardRefusal(`Refused at the wallet boundary: ${problems.join("; ")}`);

    // Record, durably and before the wallet sees it, exactly what is being
    // handed over. If this cannot be recorded, nothing is forwarded: a later
    // page must be able to tell "never reached the wallet" from "possibly
    // sent", and to recognise this exact transaction on chain.
    try {
      s.onBeforeForward?.(tx);
    } catch (error) {
      throw new GuardRefusal(`Not sent: the transaction could not be recorded before opening the wallet (${error.message || error}).`);
    }

    s.forwarded = true;
    log("wallet_prompt", { functionName: s.expect.functionName || "deploy" });

    let hash;

    try {
      hash = await provider.request(args);
    } catch (error) {
      // The transaction has left this page. Only an explicit rejection proves
      // it was not sent; a disconnect, timeout or any other error after this
      // point may have happened after the wallet broadcast it.
      if (isUserRejection(error)) s.rejected = error;
      else s.ambiguous = error;

      throw error;
    }

    if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
      s.evmHash = hash;
      s.onSent?.(hash);
    } else {
      s.ambiguous = new Error(`The wallet answered with ${JSON.stringify(hash)?.slice(0, 80)} instead of a transaction hash.`);
    }

    return hash;
  }

  return {
    arm(next) {
      if (slot) throw new GuardRefusal("Another write is already waiting for the wallet.");
      slot = { ...next, forwarded: false };
      return slot;
    },
    disarm(current) {
      if (!current || slot === current) slot = null;
    },
    get armed() {
      return slot;
    },
    async request(args) {
      const method = args?.method;

      if (method === "eth_sendTransaction") {
        const s = slot;

        try {
          return await guardSend(args);
        } catch (error) {
          // The SDK rewraps errors; keep the real reason on the slot.
          if (s) {
            if (s.evmHash) s.lateRefusal = error;
            else if (s.forwarded) s.afterForward = s.afterForward || error; // classified above
            else s.refusal = error;
          }

          throw error;
        }
      }

      if (method === "eth_chainId" || method === "eth_accounts") return provider.request(args);

      throw new GuardRefusal(`Wallet method ${method} is not used by this page.`);
    },
  };
}
