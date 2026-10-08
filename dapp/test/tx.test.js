import { describe, expect, it } from "vitest";

import {
  explainError,
  isSettled,
  isSuccess,
  labelFor,
  stateFromReceipt,
  TX_ACCEPTED,
  TX_FAILED,
  TX_FINALIZED,
  TX_SUBMITTED,
} from "../src/tx.js";

describe("transaction lifecycle", () => {
  it("treats a missing receipt as still submitted", () => {
    expect(stateFromReceipt(null)).toBe(TX_SUBMITTED);
  });

  it("does not call an accepted transaction finished", () => {
    expect(stateFromReceipt({ status_name: "ACCEPTED" })).toBe(TX_ACCEPTED);
    expect(isSettled(TX_ACCEPTED)).toBe(false);
    expect(isSuccess(TX_ACCEPTED)).toBe(false);
  });

  it("reports finalized only when the network says so", () => {
    expect(stateFromReceipt({ status_name: "FINALIZED" })).toBe(TX_FINALIZED);
    expect(isSuccess(TX_FINALIZED)).toBe(true);
  });

  it("treats a finalized but failed execution as failed", () => {
    // Probe L9 observed exactly this shape on Bradbury.
    const receipt = {
      status_name: "FINALIZED",
      txExecutionResultName: "FINISHED_WITH_ERROR",
    };

    expect(stateFromReceipt(receipt)).toBe(TX_FAILED);
    expect(isSuccess(stateFromReceipt(receipt))).toBe(false);
  });

  it("handles numeric status and execution codes", () => {
    expect(stateFromReceipt({ status: 7 })).toBe(TX_FINALIZED);
    expect(stateFromReceipt({ status: 5 })).toBe(TX_ACCEPTED);
    expect(stateFromReceipt({ status: 7, txExecutionResult: 2 })).toBe(TX_FAILED);
  });

  it("treats a cancelled transaction as failed", () => {
    expect(stateFromReceipt({ status_name: "CANCELED" })).toBe(TX_FAILED);
  });

  it("labels every state in plain words", () => {
    expect(labelFor(TX_SUBMITTED)).toMatch(/waiting/i);
    expect(labelFor(TX_ACCEPTED)).toMatch(/not final/i);
    expect(labelFor(TX_FINALIZED)).toBe("Finalized");
  });
});

describe("error explanations", () => {
  it("names a wallet rejection as such", () => {
    expect(explainError(new Error("User rejected the request"))).toMatch(
      /rejected the request in your wallet/i,
    );
  });

  it("explains a missing MetaMask", () => {
    expect(explainError(new Error("MetaMask is not installed."))).toMatch(
      /GenLayer Snap/,
    );
  });

  it("surfaces the contract's own message", () => {
    const error = new Error(
      "UserError(message='milestone is not approved for payment')",
    );

    expect(explainError(error)).toBe(
      "The contract rejected this: milestone is not approved for payment",
    );
  });

  it("falls back to the raw message rather than inventing one", () => {
    expect(explainError(new Error("socket hang up"))).toBe("socket hang up");
  });
});
