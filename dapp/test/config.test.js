import { describe, expect, it } from "vitest";

import { isValidAddress, resolveConfig } from "../src/config.js";

const GOOD = "0x" + "ab".repeat(20);

describe("configuration", () => {
  it("reports not configured when no escrow address is set", () => {
    const config = resolveConfig({});

    expect(config.ok).toBe(false);
    expect(config.escrowAddress).toBeNull();
    expect(config.problems.join(" ")).toMatch(/No escrow address configured/);
  });

  it("rejects a malformed address instead of using it", () => {
    const config = resolveConfig({ VITE_ESCROW_ADDRESS: "0x1234" });

    expect(config.ok).toBe(false);
    expect(config.escrowAddress).toBeNull();
    expect(config.problems.join(" ")).toMatch(/not a 20-byte hex address/);
  });

  it("accepts a well formed address on a known network", () => {
    const config = resolveConfig({
      VITE_ESCROW_ADDRESS: GOOD,
      VITE_GENLAYER_NETWORK: "testnetBradbury",
    });

    expect(config.ok).toBe(true);
    expect(config.escrowAddress).toBe(GOOD);
    expect(config.network).toBe("testnetBradbury");
  });

  it("rejects an unknown network", () => {
    const config = resolveConfig({
      VITE_ESCROW_ADDRESS: GOOD,
      VITE_GENLAYER_NETWORK: "mainnet-pretend",
    });

    expect(config.ok).toBe(false);
    expect(config.problems.join(" ")).toMatch(/Unknown network/);
  });

  it("treats a registry address as optional but still validates it", () => {
    expect(
      resolveConfig({ VITE_ESCROW_ADDRESS: GOOD, VITE_REGISTRY_ADDRESS: "" }).ok,
    ).toBe(true);

    const bad = resolveConfig({
      VITE_ESCROW_ADDRESS: GOOD,
      VITE_REGISTRY_ADDRESS: "nope",
    });

    expect(bad.ok).toBe(false);
  });

  it("validates address shape", () => {
    expect(isValidAddress(GOOD)).toBe(true);
    expect(isValidAddress("0x" + "ab".repeat(19))).toBe(false);
    expect(isValidAddress(null)).toBe(false);
  });
});
