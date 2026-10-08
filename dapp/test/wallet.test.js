import { describe, expect, it, vi } from "vitest";

import { connectWallet, disconnectWallet, hasMetaMask } from "../src/wallet.js";

const ACCOUNT = "0x" + "a1".repeat(20);

function fakeWindow(accounts = [ACCOUNT]) {
  return {
    ethereum: {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_requestAccounts") return accounts;

        return null;
      }),
    },
  };
}

describe("wallet detection", () => {
  it("reports whether an injected provider exists", () => {
    expect(hasMetaMask(fakeWindow())).toBe(true);
    expect(hasMetaMask({})).toBe(false);
    expect(hasMetaMask(undefined)).toBe(false);
  });

  it("explains that GenLayer needs MetaMask with the Snap", async () => {
    await expect(
      connectWallet("testnetBradbury", { windowRef: {} }),
    ).rejects.toThrow(/MetaMask is not installed/);
  });
});

describe("connecting", () => {
  it("asks for accounts and then enables the GenLayer Snap", async () => {
    const windowRef = fakeWindow();
    const connect = vi.fn(async () => undefined);
    const createClient = vi.fn(() => ({ connect }));

    const result = await connectWallet("testnetBradbury", {
      windowRef,
      createClient,
    });

    expect(result.account).toBe(ACCOUNT);
    expect(windowRef.ethereum.request).toHaveBeenCalledWith({
      method: "eth_requestAccounts",
    });

    // client.connect() is what installs/enables the Snap and switches chain.
    expect(connect).toHaveBeenCalledWith("testnetBradbury");

    const config = createClient.mock.calls[0][0];

    expect(config.account).toBe(ACCOUNT);
    expect(config.provider).toBe(windowRef.ethereum);
    expect(config.chain.id).toBe(4221);
  });

  it("fails clearly when the wallet authorizes no account", async () => {
    await expect(
      connectWallet("testnetBradbury", {
        windowRef: fakeWindow([]),
        createClient: () => ({ connect: async () => {} }),
      }),
    ).rejects.toThrow(/No account was authorized/);
  });

  it("refuses an unsupported network instead of guessing", async () => {
    await expect(
      connectWallet("not-a-network", {
        windowRef: fakeWindow(),
        createClient: () => ({ connect: async () => {} }),
      }),
    ).rejects.toThrow(/Unsupported network/);
  });

  it("never requests a key or seed phrase", async () => {
    const windowRef = fakeWindow();

    await connectWallet("testnetBradbury", {
      windowRef,
      createClient: () => ({ connect: async () => {} }),
    });

    const methods = windowRef.ethereum.request.mock.calls.map(
      ([args]) => args.method,
    );

    for (const method of methods) {
      expect(method).not.toMatch(/private|seed|mnemonic|export/i);
    }
  });
});

describe("disconnecting", () => {
  it("clears local state and says what it cannot revoke", () => {
    const result = disconnectWallet();

    expect(result.client).toBeNull();
    expect(result.account).toBeNull();
    expect(result.note).toMatch(/MetaMask still lists the site/i);
  });
});
