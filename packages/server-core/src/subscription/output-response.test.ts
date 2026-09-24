import { describe, expect, it } from "vitest";
import { buildV2rayNResponse } from "./output-response";

describe("v2rayN response", () => {
  const yaml = "proxies: [{name: keep, type: trojan, server: example.com, port: 443, password: secret}, {name: skip, type: snell}]\nproxy-providers: {remote: {url: 'https://example.com/source'}}";
  it("exposes omissions and retains client metadata without changing caller headers", async () => {
    const headers = new Headers({ "Content-Type": "text/yaml", "Content-Length": "123", "Subscription-Userinfo": "total=1024", "Profile-Update-Interval": "24" });
    const response = buildV2rayNResponse(yaml, headers);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("X-SubBoost-Skipped-Nodes")).toBe("1");
    expect(response.headers.get("X-SubBoost-Skipped-Providers")).toBe("1");
    expect(response.headers.get("X-SubBoost-Node-Count")).toBe("1");
    expect(response.headers.get("Subscription-Userinfo")).toBe("total=1024");
    expect(response.headers.get("Profile-Update-Interval")).toBe("24");
    expect(headers.get("Content-Type")).toBe("text/yaml");
    expect(response.headers.get("Content-Length")).toBe(String((await response.text()).length));
  });
  it("does not send bodies on HEAD, including errors", async () => {
    const head = buildV2rayNResponse(yaml, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const invalid = buildV2rayNResponse("proxies: []", { "Content-Length": "123" }, "HEAD");
    expect(invalid.status).toBe(422);
    expect(invalid.headers.has("Content-Length")).toBe(false);
    expect(await invalid.text()).toBe("");
  });
});
