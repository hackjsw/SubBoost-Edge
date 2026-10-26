import { describe, expect, it } from "vitest";
import { parseVLESS } from "./vless";

const uri = `vless://11111111-1111-4111-8111-111111111111@local.subboost.test:443?security=reality&pbk=${"A".repeat(43)}`;

describe("VLESS Reality key exchange support", () => {
  it.each(["support-x25519mlkem768", "support_x25519mlkem768", "supportX25519MLKEM768"])("imports explicit %s and preserves false", (key) => {
    expect(parseVLESS(`${uri}&${key}=true`)["reality-opts"]?.["support-x25519mlkem768"]).toBe(true);
    expect(parseVLESS(`${uri}&${key}=0`)["reality-opts"]?.["support-x25519mlkem768"]).toBe(false);
  });

  it.each(["", "&support-x25519mlkem768=", "&support-x25519mlkem768=invalid"])("keeps absent, empty or invalid flags unset: %s", (suffix) => {
    expect(parseVLESS(`${uri}${suffix}`)["reality-opts"]).not.toHaveProperty("support-x25519mlkem768");
  });

  it("does not infer Reality from a support flag alone", () => {
    const plain = "vless://11111111-1111-4111-8111-111111111111@local.subboost.test:443";
    expect(parseVLESS(`${plain}?support-x25519mlkem768=1`)).not.toHaveProperty("reality-opts");
    expect(parseVLESS(`${plain}?security=reality&support-x25519mlkem768=1`)).not.toHaveProperty("reality-opts");
  });
});
