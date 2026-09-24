import { describe, expect, it } from "vitest";
import { buildSubscriptionFormatUrl, getSubscriptionFormat } from "./output-format";

describe("subscription output URL compatibility", () => {
  const original = "https://example.com/config/abcd?raw=1&token=a%2Bb#unchanged";
  it("keeps Clash links byte-for-byte unchanged", () => {
    expect(buildSubscriptionFormatUrl(original, "clash")).toBe(original);
    for (const query of ["", "?format=clash", "?format=old-client-value", "?raw=1"]) {
      expect(getSubscriptionFormat(`https://example.com/config/abcd${query}`)).toBe("clash");
    }
  });
  it("adds only an explicit format without replacing the path, token or other parameters", () => {
    const v2rayn = buildSubscriptionFormatUrl(original, "v2rayn");
    const parsed = new URL(v2rayn);
    expect(parsed.pathname).toBe("/config/abcd");
    expect(parsed.hash).toBe("#unchanged");
    expect(parsed.searchParams.get("raw")).toBe("1");
    expect(parsed.searchParams.get("token")).toBe("a+b");
    expect(getSubscriptionFormat(v2rayn)).toBe("v2rayn");
    expect(buildSubscriptionFormatUrl(v2rayn, "v2rayn")).toBe(v2rayn);
  });
});
