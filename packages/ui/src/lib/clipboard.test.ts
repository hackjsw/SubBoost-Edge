import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

function stubLegacyClipboard(result: boolean | Error) {
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const execCommand = result instanceof Error
    ? vi.fn(() => { throw result; })
    : vi.fn(() => result);
  const createElement = vi.fn((tagName: string) => {
    if (tagName !== "textarea") throw new Error(`Unexpected element: ${tagName}`);
    return textarea;
  });

  vi.stubGlobal("document", {
    createElement,
    body: { appendChild },
    execCommand,
  });

  return { textarea, appendChild, execCommand, createElement };
}

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the modern clipboard API when available", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", undefined);

    await expect(copyTextToClipboard("https://local.subboost.test/sub")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://local.subboost.test/sub");
  });

  it("uses a hidden textarea on non-secure origins", async () => {
    const dom = stubLegacyClipboard(true);
    vi.stubGlobal("navigator", {});

    await expect(copyTextToClipboard("http://local.subboost.test/sub")).resolves.toBe(true);
    expect(dom.createElement).toHaveBeenCalledWith("textarea");
    expect(dom.textarea.value).toBe("http://local.subboost.test/sub");
    expect(dom.textarea.setAttribute).toHaveBeenCalledWith("readonly", "");
    expect(dom.appendChild).toHaveBeenCalledWith(dom.textarea);
    expect(dom.textarea.select).toHaveBeenCalled();
    expect(dom.textarea.setSelectionRange).toHaveBeenCalledWith(0, dom.textarea.value.length);
    expect(dom.execCommand).toHaveBeenCalledWith("copy");
    expect(dom.textarea.remove).toHaveBeenCalled();
  });

  it("falls back after modern copy is rejected and cleans up failures", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    const dom = stubLegacyClipboard(new Error("copy blocked"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyTextToClipboard("http://local.subboost.test/sub")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalled();
    expect(dom.execCommand).toHaveBeenCalledWith("copy");
    expect(dom.textarea.remove).toHaveBeenCalled();
  });

  it("reports failure when no browser document is available", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    await expect(copyTextToClipboard("text")).resolves.toBe(false);
  });
});
