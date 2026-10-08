/**
 * Network and account watching.
 *
 * A successful connect() does not keep the wallet on the right chain: the
 * user can switch networks or accounts at any time, so the app reads the
 * provider's current chain and listens for changes, and disables writes on a
 * mismatch rather than letting a transaction go to the wrong chain.
 */

export function parseChainId(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return raw;

  const text = String(raw);

  return text.startsWith("0x") ? Number.parseInt(text, 16) : Number(text);
}

export async function readChainId(provider) {
  if (!provider || typeof provider.request !== "function") return null;

  return parseChainId(await provider.request({ method: "eth_chainId" }));
}

export function networkMatches(currentChainId, expectedChainId) {
  return (
    currentChainId !== null &&
    currentChainId !== undefined &&
    Number(currentChainId) === Number(expectedChainId)
  );
}

export function describeMismatch(currentChainId, expected) {
  if (currentChainId === null || currentChainId === undefined) {
    return "The wallet's network could not be read, so writes are disabled.";
  }

  return (
    `The wallet is on chain ${currentChainId}, but this app is configured for ` +
    `${expected.label} (chain ${expected.chainId}). Switch the network in your ` +
    "wallet to enable actions."
  );
}

/**
 * Subscribe to wallet changes. Returns an unsubscribe function.
 */
export function watchWallet(provider, { onAccountsChanged, onChainChanged }) {
  if (!provider || typeof provider.on !== "function") return () => {};

  const accountsHandler = (accounts) => {
    onAccountsChanged(Array.isArray(accounts) ? accounts[0] || null : null);
  };

  const chainHandler = (chainId) => {
    onChainChanged(parseChainId(chainId));
  };

  provider.on("accountsChanged", accountsHandler);
  provider.on("chainChanged", chainHandler);

  return () => {
    if (typeof provider.removeListener !== "function") return;

    provider.removeListener("accountsChanged", accountsHandler);
    provider.removeListener("chainChanged", chainHandler);
  };
}
