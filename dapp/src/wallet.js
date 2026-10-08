/**
 * Wallet connection.
 *
 * GenLayer is NOT an ordinary EVM wallet target: genlayer-js connects through
 * MetaMask plus the GenLayer Snap (client.connect() calls wallet_getSnaps and
 * wallet_requestSnaps). An ordinary injected EVM wallet is therefore not
 * enough, and this module says so rather than failing obscurely.
 *
 * No key or seed phrase is ever requested, read or stored. Signing stays in
 * the wallet.
 */

import { createClient } from "genlayer-js";
import * as chains from "genlayer-js/chains";

export function hasMetaMask(windowRef = globalThis.window) {
  return Boolean(windowRef && windowRef.ethereum);
}

export function chainFor(network) {
  const chain = chains[network];

  if (!chain) throw new Error(`Unsupported network "${network}".`);

  return chain;
}

/** Read-only client: no wallet, no account, used for viewing state. */
export function createReadClient(network) {
  return createClient({ chain: chainFor(network) });
}

/**
 * Connect through MetaMask and the GenLayer Snap.
 * @returns { client, account, network }
 */
export async function connectWallet(network, deps = {}) {
  const windowRef = deps.windowRef || globalThis.window;
  const make = deps.createClient || createClient;

  if (!hasMetaMask(windowRef)) {
    throw new Error(
      "MetaMask is not installed. GenLayer needs MetaMask with the GenLayer Snap.",
    );
  }

  const accounts = await windowRef.ethereum.request({
    method: "eth_requestAccounts",
  });

  if (!accounts || accounts.length === 0) {
    throw new Error("No account was authorized in the wallet.");
  }

  const client = make({
    chain: chainFor(network),
    account: accounts[0],
    provider: windowRef.ethereum,
  });

  // Installs/enables the GenLayer Snap and switches the wallet's chain.
  await client.connect(network);

  return { client, account: accounts[0], network };
}

/**
 * There is no "disconnect" in MetaMask: a site can only forget the account.
 * Saying that plainly is better than pretending we revoked something.
 */
export function disconnectWallet() {
  return {
    client: null,
    account: null,
    note:
      "Disconnected in this app. MetaMask still lists the site as connected; " +
      "remove it there to revoke access fully.",
  };
}
