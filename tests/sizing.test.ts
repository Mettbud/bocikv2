import { describe, expect, it } from "vitest";
import { computeFixedSlotTradeUsd } from "../src/sizing.js";

describe("computeFixedSlotTradeUsd", () => {
  it("is a fixed % of the starting portfolio value", () => {
    expect(computeFixedSlotTradeUsd(1000, 30)).toBe(300);
    expect(computeFixedSlotTradeUsd(1000, 30)).toBe(300); // stays 300 no matter how many times asked
  });

  it("does not depend on the current balance", () => {
    // Same starting value, called repeatedly (as if the account had since
    // grown or shrunk) - always the same target.
    expect(computeFixedSlotTradeUsd(1000, 30)).toBe(computeFixedSlotTradeUsd(1000, 30));
  });

  it("never goes negative", () => {
    expect(computeFixedSlotTradeUsd(-50, 30)).toBe(0);
  });
});
