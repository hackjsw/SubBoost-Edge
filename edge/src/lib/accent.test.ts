import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_ATTRIBUTE,
  ACCENT_BOOT_SCRIPT,
  ACCENT_CSS_VAR,
  ACCENT_HEX_STORAGE_KEY,
  ACCENT_PRESETS,
  ACCENT_STORAGE_KEY,
  applyAccent,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_ID,
  MIN_ACCENT_CONTRAST,
  normalizeCustomHex,
  parseAccentId,
  parseHex,
  readAccent,
  storeAccent,
  type Accent,
} from "./accent";

type FakeRoot = {
  attributes: Map<string, string>;
  properties: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  style: { setProperty: (name: string, value: string) => void; removeProperty: (name: string) => void };
};

function installDom(): FakeRoot {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const root: FakeRoot = {
    attributes,
    properties,
    setAttribute: (name, value) => void attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) ?? null,
    style: {
      setProperty: (name, value) => void properties.set(name, value),
      removeProperty: (name) => void properties.delete(name),
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  return root;
}

function installStorage(entries: Record<string, string> | "throws") {
  const localStorage =
    entries === "throws"
      ? {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
          removeItem: () => {
            throw new Error("blocked");
          },
        }
      : {
          store: new Map(Object.entries(entries)),
          getItem(key: string) {
            return this.store.get(key) ?? null;
          },
          setItem(key: string, value: string) {
            this.store.set(key, value);
          },
          removeItem(key: string) {
            this.store.delete(key);
          },
        };
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { localStorage });
  return localStorage;
}

const runBootScript = () => new Function(ACCENT_BOOT_SCRIPT)();

afterEach(() => vi.unstubAllGlobals());

describe("parseAccentId", () => {
  it("accepts every preset and the custom marker", () => {
    for (const preset of ACCENT_PRESETS) expect(parseAccentId(preset.id)).toBe(preset.id);
    expect(parseAccentId("custom")).toBe("custom");
  });

  it("rejects unknown and non-string values", () => {
    expect(parseAccentId("fuchsia")).toBeNull();
    expect(parseAccentId("")).toBeNull();
    expect(parseAccentId(null)).toBeNull();
    expect(parseAccentId(42)).toBeNull();
  });
});

describe("parseHex", () => {
  it("accepts #rrggbb and lowercases it", () => {
    expect(parseHex("#AABBCC")).toBe("#aabbcc");
    expect(parseHex("#0f172a")).toBe("#0f172a");
  });

  it("rejects shorthand, missing hash and other junk", () => {
    expect(parseHex("#abc")).toBeNull();
    expect(parseHex("aabbcc")).toBeNull();
    expect(parseHex("#aabbccdd")).toBeNull();
    expect(parseHex("rgb(1,2,3)")).toBeNull();
    expect(parseHex(null)).toBeNull();
  });
});

describe("normalizeCustomHex", () => {
  it("leaves colors that already clear the contrast bar alone", () => {
    for (const dark of ["#c2410c", "#172554", "#2563eb", "#000000"]) {
      expect(contrastWithWhite(dark)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
      expect(normalizeCustomHex(dark)).toBe(dark);
    }
  });

  it("darkens brighter colors until white label text clears the bar", () => {
    for (const bright of ["#ffee00", "#ffffff", "#7dffb0", "#00ff00", "#ea580c"]) {
      const darkened = normalizeCustomHex(bright);
      expect(darkened).not.toBe(bright);
      expect(contrastWithWhite(darkened)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST - 0.02);
    }
  });

  it("does not darken further than it has to", () => {
    // Bisection should land just past the bar, not at an arbitrarily dark value.
    expect(contrastWithWhite(normalizeCustomHex("#ffee00"))).toBeLessThan(MIN_ACCENT_CONTRAST + 0.1);
  });

  it("keeps the hue when darkening", () => {
    // Bright yellow stays yellow: red and green channels stay well above blue.
    const [r, g, b] = channels(normalizeCustomHex("#ffee00"));
    expect(r).toBeGreaterThan(b + 40);
    expect(g).toBeGreaterThan(b + 40);
  });

  it("passes through values it cannot parse", () => {
    expect(normalizeCustomHex("nope")).toBe("nope");
  });
});

describe("readAccent", () => {
  it("falls back to the default when nothing is stored", () => {
    installStorage({});
    expect(readAccent()).toEqual(DEFAULT_ACCENT);
  });

  it("reads a stored preset", () => {
    installStorage({ [ACCENT_STORAGE_KEY]: "blue" });
    expect(readAccent()).toEqual({ id: "blue", hex: null });
  });

  it("reads a stored custom color", () => {
    installStorage({ [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#2B6CB0" });
    expect(readAccent()).toEqual({ id: "custom", hex: "#2b6cb0" });
  });

  it("falls back when custom is stored without a usable hex", () => {
    installStorage({ [ACCENT_STORAGE_KEY]: "custom" });
    expect(readAccent()).toEqual(DEFAULT_ACCENT);
    installStorage({ [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#abc" });
    expect(readAccent()).toEqual(DEFAULT_ACCENT);
  });

  it("falls back when storage throws", () => {
    installStorage("throws");
    expect(readAccent()).toEqual(DEFAULT_ACCENT);
  });
});

describe("storeAccent", () => {
  it("drops the stale custom hex when switching to a preset", () => {
    const storage = installStorage({ [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#2b6cb0" });
    storeAccent({ id: "green", hex: null });
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("green");
    expect(storage.getItem(ACCENT_HEX_STORAGE_KEY)).toBeNull();
  });

  it("writes both keys for a custom color", () => {
    const storage = installStorage({});
    storeAccent({ id: "custom", hex: "#2b6cb0" });
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("custom");
    expect(storage.getItem(ACCENT_HEX_STORAGE_KEY)).toBe("#2b6cb0");
  });

  it("does not throw when storage is blocked", () => {
    installStorage("throws");
    expect(() => storeAccent({ id: "custom", hex: "#2b6cb0" })).not.toThrow();
  });
});

describe("applyAccent", () => {
  it("sets only the attribute for a preset", () => {
    const root = installDom();
    applyAccent({ id: "violet", hex: null });
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe("violet");
    expect(root.properties.has(ACCENT_CSS_VAR)).toBe(false);
  });

  it("sets the base color for a custom accent", () => {
    const root = installDom();
    applyAccent({ id: "custom", hex: "#2b6cb0" });
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe("custom");
    expect(root.properties.get(ACCENT_CSS_VAR)).toBe("#2b6cb0");
  });

  it("clears a leftover custom color when switching back to a preset", () => {
    const root = installDom();
    applyAccent({ id: "custom", hex: "#2b6cb0" });
    applyAccent({ id: "rose", hex: null });
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe("rose");
    expect(root.properties.has(ACCENT_CSS_VAR)).toBe(false);
  });
});

describe("ACCENT_BOOT_SCRIPT", () => {
  // The script runs before paint and must land on exactly what applyAccent(readAccent()) would.
  const cases: Array<{ name: string; stored: Record<string, string> | "throws"; expected: Accent }> = [
    { name: "nothing stored", stored: {}, expected: DEFAULT_ACCENT },
    { name: "a preset", stored: { [ACCENT_STORAGE_KEY]: "cyan" }, expected: { id: "cyan", hex: null } },
    {
      name: "a custom color",
      stored: { [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#2B6CB0" },
      expected: { id: "custom", hex: "#2b6cb0" },
    },
    { name: "an unknown id", stored: { [ACCENT_STORAGE_KEY]: "fuchsia" }, expected: DEFAULT_ACCENT },
    { name: "custom without a hex", stored: { [ACCENT_STORAGE_KEY]: "custom" }, expected: DEFAULT_ACCENT },
    {
      name: "custom with a malformed hex",
      stored: { [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#abc" },
      expected: DEFAULT_ACCENT,
    },
    { name: "blocked storage", stored: "throws", expected: DEFAULT_ACCENT },
  ];

  for (const { name, stored, expected } of cases) {
    it(`matches applyAccent given ${name}`, () => {
      installStorage(stored);
      const viaScript = installDom();
      runBootScript();

      installStorage(stored);
      const viaModule = installDom();
      applyAccent(expected);

      expect(viaScript.getAttribute(ACCENT_ATTRIBUTE)).toBe(viaModule.getAttribute(ACCENT_ATTRIBUTE));
      expect(viaScript.properties.get(ACCENT_CSS_VAR)).toBe(viaModule.properties.get(ACCENT_CSS_VAR));
      expect(viaScript.getAttribute(ACCENT_ATTRIBUTE)).toBe(expected.id);
    });
  }

  it("defaults to the shipped accent id", () => {
    installStorage({});
    const root = installDom();
    runBootScript();
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe(DEFAULT_ACCENT_ID);
  });
});

describe("preset ramps in edgesub.css", () => {
  const css = readFileSync(new URL("../styles/edgesub.css", import.meta.url), "utf8");
  const ramps = new Map<string, Map<string, string>>();
  for (const [, id, body] of css.matchAll(/html\[data-accent="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
    if (id === "custom") continue; // derived from --es-accent at runtime, not a hex table
    ramps.set(id, new Map([...body.matchAll(/--es-ramp-(\d+):\s*(#[0-9a-f]{6});/g)].map(([, s, hex]) => [s, hex])));
  }

  const STOPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

  it("defines a complete ramp for every preset", () => {
    expect([...ramps.keys()].sort()).toEqual(ACCENT_PRESETS.map((p) => p.id).sort());
    for (const [id, ramp] of ramps) expect({ id, stops: [...ramp.keys()] }).toEqual({ id, stops: STOPS });
  });

  it("keeps every light-theme button fill at WCAG AA against white label text", () => {
    // This is the invariant that makes the presets feel like one set rather than eight.
    for (const [id, ramp] of ramps) {
      const fill = ramp.get("600")!;
      expect({ id, ok: contrastWithWhite(fill) >= MIN_ACCENT_CONTRAST }).toEqual({ id, ok: true });
    }
  });

  it("matches each menu swatch to its ramp-500", () => {
    for (const preset of ACCENT_PRESETS) expect(preset.swatch).toBe(ramps.get(preset.id)?.get("500"));
  });

  it("darkens monotonically from 50 to 950", () => {
    for (const [id, ramp] of ramps) {
      const luminances = STOPS.map((stop) => contrastWithWhite(ramp.get(stop)!));
      const sorted = [...luminances].sort((a, b) => a - b);
      expect({ id, monotonic: luminances.every((v, i) => v === sorted[i]) }).toEqual({ id, monotonic: true });
    }
  });
});

/* ---------- helpers ---------- */

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG contrast against white, computed independently of the module under test. */
function contrastWithWhite(hex: string): number {
  const toLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels(hex).map(toLinear);
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}
