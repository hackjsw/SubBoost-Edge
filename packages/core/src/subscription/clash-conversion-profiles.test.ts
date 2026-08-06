import { describe, expect, it } from "vitest";
import {
  CLASH_CONVERSION_PROFILES,
  DEFAULT_ACL4SSR_PROFILE_ID,
  DEFAULT_CLASH_CONVERSION_PROFILE_ID,
  getClashConversionProfile,
  isClashConversionProfileId,
  resolveClashConversionProfileId,
} from "./clash-conversion-profiles";

describe("Clash conversion profiles", () => {
  it("keeps one native default and seven allowlisted ACL4SSR profiles", () => {
    expect(DEFAULT_CLASH_CONVERSION_PROFILE_ID).toBe("native");
    expect(DEFAULT_ACL4SSR_PROFILE_ID).toBe("acl4ssr-online");
    expect(CLASH_CONVERSION_PROFILES).toHaveLength(8);
    expect(new Set(CLASH_CONVERSION_PROFILES.map((profile) => profile.id)).size).toBe(8);

    const remoteProfiles = CLASH_CONVERSION_PROFILES.filter((profile) => profile.configUrl);
    expect(remoteProfiles).toHaveLength(7);
    for (const profile of remoteProfiles) {
      expect(profile.configUrl).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/ACL4SSR\/ACL4SSR\/master\/Clash\/config\/ACL4SSR_Online.*\.ini$/
      );
    }
  });

  it("validates ids without accepting arbitrary config URLs", () => {
    expect(isClashConversionProfileId("acl4ssr-online-mini-ai")).toBe(true);
    expect(isClashConversionProfileId("https://example.com/config.ini")).toBe(false);
    expect(resolveClashConversionProfileId("unknown")).toBe("native");
    expect(getClashConversionProfile("acl4ssr-online").configUrl).toContain(
      "ACL4SSR_Online.ini"
    );
  });
});
