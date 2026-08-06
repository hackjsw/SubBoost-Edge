import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLASH_CONVERSION_PROFILES } from "@subboost/core/subscription/clash-conversion-profiles";

const captures = vi.hoisted(() => ({ buttons: [] as any[] }));

vi.mock("lucide-react", () => ({
  Check: () => React.createElement("span", null, "check-icon"),
  Cloud: () => React.createElement("span", null, "cloud-icon"),
  Sparkles: () => React.createElement("span", null, "sparkles-icon"),
}));

vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: (props: any) => {
    captures.buttons.push(props);
    return React.createElement("button", props, props.children);
  },
}));

vi.mock("@subboost/ui/components/ui/dialog", () => ({
  Dialog: (props: any) => React.createElement("div", { "data-open": String(props.open) }, props.children),
  DialogContent: (props: any) => React.createElement("div", props, props.children),
  DialogDescription: (props: any) => React.createElement("p", props, props.children),
  DialogFooter: (props: any) => React.createElement("footer", props, props.children),
  DialogHeader: (props: any) => React.createElement("header", props, props.children),
  DialogTitle: (props: any) => React.createElement("h2", props, props.children),
}));

import { ClashConversionProfileDialog } from "./clash-conversion-profile-dialog";

const expectedAcl4ssrProfileIds = [
  "acl4ssr-online",
  "acl4ssr-online-mini",
  "acl4ssr-online-full",
  "acl4ssr-online-mini-ai",
  "acl4ssr-online-multi-country",
  "acl4ssr-online-no-auto",
  "acl4ssr-online-no-reject",
];

describe("ClashConversionProfileDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captures.buttons = [];
  });

  it("renders one accessible radio for every allowlisted profile", () => {
    const html = renderToStaticMarkup(
      React.createElement(ClashConversionProfileDialog, {
        open: true,
        onOpenChange: vi.fn(),
        profiles: CLASH_CONVERSION_PROFILES,
        value: "acl4ssr-online-full",
        onValueChange: vi.fn(),
      })
    );

    expect((html.match(/type="radio"/g) || [])).toHaveLength(8);
    expect((html.match(/checked=""/g) || [])).toHaveLength(1);
    expect(html).toContain("EdgeSub 原生");
    expect(html).toContain("ACL4SSR 标准版");
    expect(html).toContain("ACL4SSR 多地区版");
    expect(html).toContain("跟随官方 master 更新");
    expect(html).toContain("subconverter");
    expect(html).toContain("max-h-[88vh]");
    expect(html).toContain("overflow-y-auto");
  });

  it("renders the quick-mode ACL4SSR catalog with exactly seven official profiles", () => {
    const remoteProfiles = CLASH_CONVERSION_PROFILES.filter((profile) => profile.configUrl);
    const html = renderToStaticMarkup(
      React.createElement(ClashConversionProfileDialog, {
        open: true,
        onOpenChange: vi.fn(),
        profiles: remoteProfiles,
        value: "native",
        onValueChange: vi.fn(),
      })
    );

    expect((html.match(/type="radio"/g) || [])).toHaveLength(7);
    expect((html.match(/checked=""/g) || [])).toHaveLength(0);
    expectedAcl4ssrProfileIds.forEach((profileId) => {
      expect(html).toContain(`value="${profileId}"`);
    });
    expect(html).toContain("ACL4SSR 模板");
    expect(html).toContain("用于保存订阅和定时更新");
    expect(html).toContain("当前：<span");
    expect(html).toContain("未选择");
    expect(html).not.toContain("EdgeSub 原生");
  });

  it("closes from the persistent footer action", () => {
    const onOpenChange = vi.fn();
    renderToStaticMarkup(
      React.createElement(ClashConversionProfileDialog, {
        open: true,
        onOpenChange,
        profiles: CLASH_CONVERSION_PROFILES,
        value: "native",
        onValueChange: vi.fn(),
      })
    );

    captures.buttons.at(-1).onClick();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
