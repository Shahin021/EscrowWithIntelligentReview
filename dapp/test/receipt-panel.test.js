import { describe, expect, it } from "vitest";
import { receiptVerdict, withReadTimeout } from "../src/receipt-panel.js";
import lifecycle from "../src/lifecycle-transactions.json";

const escrow = lifecycle.escrow;
const success = { recipient: escrow, status: 7, resultName: "AGREE", txExecutionResultName: "FINISHED_WITH_RETURN" };
describe("historical receipt verification", () => {
  it("binds seven distinct real transaction ids to the corrected escrow", () => {
    expect(new Set(lifecycle.transactions.map(x => x.hash)).size).toBe(7);
    lifecycle.transactions.forEach(x => expect(x.hash).toMatch(/^0x[0-9a-f]{64}$/));
  });
  it("accepts successful finalized SDK receipts", () => expect(receiptVerdict(success, escrow).ok).toBe(true));
  it("accepts snake_case read receipts", () => expect(receiptVerdict({ recipient: escrow.toLowerCase(), status: "7", result_name: "AGREE", tx_execution_result_name: "FINISHED_WITH_RETURN" }, escrow).ok).toBe(true));
  it("accepts majority agreement and numeric execution", () => expect(receiptVerdict({ ...success, resultName: "MAJORITY_AGREE", txExecutionResultName: undefined, txExecutionResult: 1 }, escrow).ok).toBe(true));
  it.each(["FINISHED_WITH_ERROR", 2])("rejects finalized execution failure %s", execution => expect(receiptVerdict({ ...success, txExecutionResultName: execution }, escrow).ok).toBe(false));
  it.each(["DISAGREE", undefined])("requires explicit successful consensus %s", result => expect(receiptVerdict({ ...success, resultName: result }, escrow).ok).toBe(false));
  it("does not treat accepted as finalized", () => expect(receiptVerdict({ ...success, status: 5 }, escrow).ok).toBe(false));
  it("requires execution evidence", () => expect(receiptVerdict({ ...success, txExecutionResultName: undefined }, escrow).ok).toBe(false));
  it("rejects receipts for another contract", () => expect(receiptVerdict({ ...success, recipient: "0x" + "a".repeat(40) }, escrow).ok).toBe(false));
  it("rejects missing receipts", () => expect(receiptVerdict(null, escrow).ok).toBe(false));
  it("bounds stalled reads", async () => await expect(withReadTimeout(() => new Promise(() => {}), 10)).rejects.toThrow("Read timeout"));
  it("preserves successful reads", async () => expect(await withReadTimeout(() => Promise.resolve(success), 100)).toEqual(success));
});
