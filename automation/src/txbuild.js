/**
 * Build and sign the service's own consensus transactions.
 *
 * The inner GenLayer call is encoded exactly as genlayer-js writeContract does
 * (the dapp's guard decodes and checks the same layout). Signing is
 * deterministic (RFC 6979): the same reserved fields always give the same raw
 * transaction and therefore the same hash, which is what lets a restart finish
 * a half-done signing step without creating a different transaction.
 */

import { abi } from "genlayer-js";
import { encodeFunctionData, keccak256, toHex } from "viem";

export function innerCallData(functionName, args) {
  const calldata = abi.calldata.encode(abi.calldata.makeCalldataObject(functionName, args, undefined));

  return abi.transactions.serialize([calldata, false]);
}

/** addTransaction(sender, recipient, validators, rotations, txData[, validUntil]) */
export function consensusCallData({ chain, sender, escrow, functionName, args, validUntil }) {
  const consensus = chain.consensusMainContract;
  const add = consensus.abi.filter((e) => e.type === "function" && e.name === "addTransaction");
  const inputs = add[0]?.inputs?.length ?? 0;
  const base = [
    sender,
    escrow,
    BigInt(chain.defaultNumberOfInitialValidators),
    BigInt(chain.defaultConsensusMaxRotations),
    innerCallData(functionName, args),
  ];

  return encodeFunctionData({ abi: add, functionName: "addTransaction", args: inputs >= 6 ? [...base, BigInt(validUntil)] : base });
}

/** Sign the reserved fields. Returns { raw, hash }; never logs either. */
export async function signReserved(account, { chainId, nonce, gas, gasPrice, to, data }) {
  const raw = await account.signTransaction({
    type: "legacy",
    chainId,
    nonce: Number(nonce),
    gas: BigInt(gas),
    gasPrice: BigInt(gasPrice),
    to,
    data,
    value: 0n,
  });

  return { raw, hash: keccak256(raw) };
}

export const toHexString = (value) => toHex(value);
