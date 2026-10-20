/**
 * Wallet session: explicit connect, silent restore, explicit disconnect.
 *
 * Restore after a refresh uses eth_accounts and eth_chainId only. It never
 * opens a wallet prompt, never switches networks, never touches the Snap and
 * never signs or sends anything. If the user disconnected explicitly in this
 * app, nothing is restored until they connect again.
 *
 * The SDK client is always built on the guarded provider, so every write it
 * makes passes the wallet boundary in guard.js.
 */

import { createClient } from "genlayer-js";

import { chainFor, connectWallet } from "../wallet.js";
import { parseChainId } from "../network.js";

const prefKey = (network) => `escrow-workspace:v2:disconnected:${network}`;

export function isExplicitlyDisconnected(prefs, network) {
  return prefs.getItem(prefKey(network)) === "1";
}

export async function restoreSession(network, { provider, prefs, guard, make = createClient }) {
  if (!provider || typeof provider.request !== "function") return { restored: false, reason: "no-wallet" };

  if (isExplicitlyDisconnected(prefs, network)) return { restored: false, reason: "explicitly-disconnected" };

  const accounts = await provider.request({ method: "eth_accounts" });

  if (!Array.isArray(accounts) || accounts.length === 0) return { restored: false, reason: "not-authorized" };

  const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
  const account = accounts[0];
  const client = make({ chain: chainFor(network), account, provider: guard });

  return { restored: true, account, chainId, client };
}

/** Explicit connect: may prompt (accounts, Snap, network switch). */
export async function connectSession(network, { windowRef = globalThis.window, prefs, guard, make = createClient }) {
  const result = await connectWallet(network, {
    windowRef,
    // The Snap/network handshake runs on a throwaway client; the client the
    // app keeps is built on the guarded provider.
    createClient: (options) => make(options),
  });

  prefs.removeItem(prefKey(network));

  const chainId = parseChainId(await windowRef.ethereum.request({ method: "eth_chainId" }));
  const client = make({ chain: chainFor(network), account: result.account, provider: guard });

  return { account: result.account, chainId, client };
}

export function disconnectSession(network, { prefs }) {
  prefs.setItem(prefKey(network), "1");

  return {
    note:
      "Disconnected in this app; it will not reconnect on refresh. MetaMask still " +
      "lists the site as connected — remove it there to revoke access fully.",
  };
}
