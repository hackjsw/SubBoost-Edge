import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_ATTRIBUTE,
  ACCENT_BOOT_SCRIPT,
  ACCENT_CSS_VAR,
  ACCENT_HEX_STORAGE_KEY,
  ACCENT_INK_CSS_VAR,
  ACCENT_INK_ON_DARK,
  ACCENT_INK_ON_LIGHT,
  ACCENT_INK_STORAGE_KEY,
  ACCENT_PRESETS,
  ACCENT_STORAGE_KEY,
  accentInk,
  applyAccent,
  customAccent,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_ID,
  parseAccentId,
  parseHex,
  readAccent,
  storeAccent,
  type Accent,
} from "./accent";

/** WCAG AA for normal text — the bar the ink and the preset ramps have to clear. */
const AA = 4.5;

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
const preset = (id: Accent["id"]) => ({ id, hex: null, ink: null }) as Accent;

afterEach(() => vi.unstubAllGlobals());

describe("parseAccentId", () => {
  it("accepts every preset and the custom marker", () => {
    for (const p of ACCENT_PRESETS) expect(parseAccentId(p.id)).toBe(p.id);
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

describe("accentInk", () => {
  it("never alters the color the user picked", () => {
    // The whole point of adapting the ink: the accent itself is passed through untouched.
    for (const hex of ["#ffc0cb", "#a7f3d0", "#ffee00", "#1e3a8a", "#000000", "#ffffff"]) {
      expect(customAccent(hex).hex).toBe(hex);
    }
  });

  it("gives any color an ink that clears AA", () => {
    // Sweep the whole space rather than a few samples: white covers luminance up to 0.183 and
    // near-black from 0.175, so the two ranges overlap and nothing can fall between them.
    const failures: string[] = [];
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const hex = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
          if (contrast(hex, accentInk(hex)) < AA) failures.push(hex);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("picks dark ink for light fills and white ink for dark fills", () => {
    for (const light of ["#ffc0cb", "#a7f3d0", "#fde68a", "#ffffff"]) {
      expect(accentInk(light)).toBe(ACCENT_INK_ON_LIGHT);
    }
    for (const dark of ["#1e3a8a", "#c2410c", "#4f46e5", "#000000"]) {
      expect(accentInk(dark)).toBe(ACCENT_INK_ON_DARK);
    }
  });

  it("always picks the better of the two inks", () => {
    for (const hex of ["#808080", "#767676", "#7a7a7a", "#ea580c", "#22c55e"]) {
      const chosen = contrast(hex, accentInk(hex));
      const other = contrast(hex, accentInk(hex) === ACCENT_INK_ON_DARK ? ACCENT_INK_ON_LIGHT : ACCENT_INK_ON_DARK);
      expect(chosen).toBeGreaterThanOrEqual(other);
    }
  });
});

describe("readAccent", () => {
  it("falls back to the default when nothing is stored", () => {
    installStorage({});
    expect(readAccent()).toEqual(DEFAULT_ACCENT);
  });

  it("reads a stored preset", () => {
    installStorage({ [ACCENT_STORAGE_KEY]: "blue" });
    expect(readAccent()).toEqual(preset("blue"));
  });

  it("reads a stored custom color and recomputes its ink", () => {
    installStorage({ [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#2B6CB0" });
    expect(readAccent()).toEqual({ id: "custom", hex: "#2b6cb0", ink: ACCENT_INK_ON_DARK });
  });

  it("ignores a stale stored ink in favour of the hex", () => {
    installStorage({
      [ACCENT_STORAGE_KEY]: "custom",
      [ACCENT_HEX_STORAGE_KEY]: "#ffc0cb",
      [ACCENT_INK_STORAGE_KEY]: ACCENT_INK_ON_DARK, // wrong for a pale pink
    });
    expect(readAccent().ink).toBe(ACCENT_INK_ON_LIGHT);
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
  it("drops the stale custom keys when switching to a preset", () => {
    const storage = installStorage({
      [ACCENT_STORAGE_KEY]: "custom",
      [ACCENT_HEX_STORAGE_KEY]: "#2b6cb0",
      [ACCENT_INK_STORAGE_KEY]: ACCENT_INK_ON_DARK,
    });
    storeAccent(preset("green"));
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("green");
    expect(storage.getItem(ACCENT_HEX_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(ACCENT_INK_STORAGE_KEY)).toBeNull();
  });

  it("writes hex and ink for a custom color", () => {
    const storage = installStorage({});
    storeAccent(customAccent("#ffc0cb"));
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("custom");
    expect(storage.getItem(ACCENT_HEX_STORAGE_KEY)).toBe("#ffc0cb");
    expect(storage.getItem(ACCENT_INK_STORAGE_KEY)).toBe(ACCENT_INK_ON_LIGHT);
  });

  it("does not throw when storage is blocked", () => {
    installStorage("throws");
    expect(() => storeAccent(customAccent("#2b6cb0"))).not.toThrow();
  });
});

describe("applyAccent", () => {
  it("sets only the attribute for a preset", () => {
    const root = installDom();
    applyAccent(preset("violet"));
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe("violet");
    expect(root.properties.has(ACCENT_CSS_VAR)).toBe(false);
    expect(root.properties.has(ACCENT_INK_CSS_VAR)).toBe(false);
  });

  it("sets the base color and its ink for a custom accent", () => {
    const root = installDom();
    applyAccent(customAccent("#ffc0cb"));
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe("custom");
    expect(root.properties.get(ACCENT_CSS_VAR)).toBe("#ffc0cb");
    expect(root.properties.get(ACCENT_INK_CSS_VAR)).toBe(ACCENT_INK_ON_LIGHT);
  });

  it("clears leftover custom properties when switching back to a preset", () => {
    const root = installDom();
    applyAccent(customAccent("#2b6cb0"));
    applyAccent(preset("rose"));
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe("rose");
    expect(root.properties.has(ACCENT_CSS_VAR)).toBe(false);
    expect(root.properties.has(ACCENT_INK_CSS_VAR)).toBe(false);
  });
});

describe("ACCENT_BOOT_SCRIPT", () => {
  // The script runs before paint and must land on exactly what applyAccent(readAccent()) would.
  const cases: Array<{ name: string; stored: Record<string, string> | "throws"; expected: Accent }> = [
    { name: "nothing stored", stored: {}, expected: DEFAULT_ACCENT },
    { name: "a preset", stored: { [ACCENT_STORAGE_KEY]: "cyan" }, expected: preset("cyan") },
    {
      name: "a custom color",
      stored: {
        [ACCENT_STORAGE_KEY]: "custom",
        [ACCENT_HEX_STORAGE_KEY]: "#2B6CB0",
        [ACCENT_INK_STORAGE_KEY]: ACCENT_INK_ON_DARK,
      },
      expected: customAccent("#2b6cb0"),
    },
    {
      name: "a pale custom color needing dark ink",
      stored: {
        [ACCENT_STORAGE_KEY]: "custom",
        [ACCENT_HEX_STORAGE_KEY]: "#ffc0cb",
        [ACCENT_INK_STORAGE_KEY]: ACCENT_INK_ON_LIGHT,
      },
      expected: customAccent("#ffc0cb"),
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
      expect(viaScript.properties.get(ACCENT_INK_CSS_VAR)).toBe(viaModule.properties.get(ACCENT_INK_CSS_VAR));
      expect(viaScript.getAttribute(ACCENT_ATTRIBUTE)).toBe(expected.id);
    });
  }

  it("applies the hex even when the stored ink is missing, so CSS can fall back", () => {
    installStorage({ [ACCENT_STORAGE_KEY]: "custom", [ACCENT_HEX_STORAGE_KEY]: "#2b6cb0" });
    const root = installDom();
    runBootScript();
    expect(root.properties.get(ACCENT_CSS_VAR)).toBe("#2b6cb0");
    expect(root.properties.has(ACCENT_INK_CSS_VAR)).toBe(false);
  });

  it("defaults to the shipped accent id", () => {
    installStorage({});
    const root = installDom();
    runBootScript();
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe(DEFAULT_ACCENT_ID);
  });
});

describe("preset ramps in edgesub.css", () => {
  const css = readFileSync(new URL("../styles/edgesub.css", import.meta.url), "utf8");
  const blocks = new Map<string, string>();
  for (const [, id, body] of css.matchAll(/html\[data-accent="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
    if (id !== "custom") blocks.set(id, body); // custom is derived at runtime, not a hex table
  }
  const ramp = (body: string) =>
    new Map([...body.matchAll(/--es-ramp-(\d+):\s*(#[0-9a-f]{6});/g)].map(([, s, hex]) => [s, hex]));

  const STOPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

  it("defines a complete ramp for every preset", () => {
    expect([...blocks.keys()].sort()).toEqual(ACCENT_PRESETS.map((p) => p.id).sort());
    for (const [id, body] of blocks) expect({ id, stops: [...ramp(body).keys()] }).toEqual({ id, stops: STOPS });
  });

  it("gives every preset an --es-accent, which the neutral tints derive from", () => {
    for (const [id, body] of blocks) {
      const accent = /--es-accent:\s*(#[0-9a-f]{6});/.exec(body)?.[1];
      expect({ id, accent }).toEqual({ id, accent: ramp(body).get("600") });
    }
  });

  it("keeps every light-theme button fill at WCAG AA against white label text", () => {
    // This is the invariant that makes the presets feel like one set rather than eight.
    for (const [id, body] of blocks) {
      const fill = ramp(body).get("600")!;
      expect({ id, ok: contrast(fill, "#ffffff") >= AA }).toEqual({ id, ok: true });
    }
  });

  it("matches each menu swatch to its ramp-500", () => {
    for (const p of ACCENT_PRESETS) expect(p.swatch).toBe(ramp(blocks.get(p.id)!).get("500"));
  });

  it("darkens monotonically from 50 to 950", () => {
    for (const [id, body] of blocks) {
      const stops = ramp(body);
      const contrasts = STOPS.map((stop) => contrast(stops.get(stop)!, "#ffffff"));
      const sorted = [...contrasts].sort((a, b) => a - b);
      expect({ id, monotonic: contrasts.every((v, i) => v === sorted[i]) }).toEqual({ id, monotonic: true });
    }
  });
});

/* ---------- helpers ---------- */

/** WCAG contrast, computed independently of the module under test. */
function contrast(a: string, b: string): number {
  const toLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const [r, g, bl] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map(toLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
