import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("preserves order without exceeding the active-work limit", async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const results = await mapWithConcurrency(items, 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});
