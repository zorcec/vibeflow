import { describe, it, expect } from "vitest";
import {
  presenceChipFill,
  presenceColor,
  presenceInitials,
  PRESENCE_CHIP_FILL_LIGHTNESS,
} from "../presence";

describe("presenceInitials (297e71fb)", () => {
  it("renders first+last initials for a multi-word name", () => {
    expect(presenceInitials("Tomislav Zorčec")).toBe("TZ");
  });

  it("renders the first two letters for a single-word name", () => {
    expect(presenceInitials("Ana")).toBe("AN");
  });

  it("trims extra whitespace before taking initials", () => {
    expect(presenceInitials("  ana   maria  ")).toBe("AM");
  });

  it("handles unicode names without splitting surrogate pairs", () => {
    expect(presenceInitials("Zoë François")).toBe("ZF");
    // Astral-plane first letter stays intact (Array.from, not [0]).
    expect(presenceInitials("\uD835\uDD18lga Smith")).toBe("\uD835\uDD18S");
  });

  it("falls back to a placeholder for an empty or unknown name", () => {
    expect(presenceInitials("")).toBe("?");
    expect(presenceInitials("   ")).toBe("?");
  });
});

/** Parse `hsl(h, s%, l%)` into [h, s, l] numbers. */
function parseHsl(hsl: string): [number, number, number] {
  const m = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(hsl);
  if (!m) throw new Error(`not an hsl() string: ${hsl}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(255 * v)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of the chip fill against white initials text. */
function contrastVsWhite(hsl: string): number {
  const [h, s, l] = parseHsl(hsl);
  const lum = luminance(hslToRgb(h, s, l));
  return (1.05) / (lum + 0.05);
}

describe("presenceChipFill (f84e68bd)", () => {
  it("keeps the same hue as presenceColor for the same user", () => {
    for (const userId of ["u-ana", "u-ben", "u-cid", "some-long-id-123"]) {
      const [hueColor] = parseHsl(presenceColor(userId));
      const [hueFill] = parseHsl(presenceChipFill(userId));
      expect(hueFill).toBe(hueColor);
    }
  });

  it("clears WCAG AA (4.5:1) against white text for every palette hue", () => {
    // Sweep user ids until every one of the 12 hashed hues is covered.
    const seen = new Map<number, string>();
    for (let i = 0; i < 500 && seen.size < 12; i++) {
      const id = `sweep-user-${i}`;
      const [hue] = parseHsl(presenceChipFill(id));
      if (!seen.has(hue)) seen.set(hue, id);
    }
    expect(seen.size).toBe(12);
    for (const [hue, id] of seen) {
      const ratio = contrastVsWhite(presenceChipFill(id));
      expect(ratio, `hue ${hue} (user ${id})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the documented 28% lightness floor", () => {
    expect(PRESENCE_CHIP_FILL_LIGHTNESS).toBe(28);
    const [, , l] = parseHsl(presenceChipFill("u-ana"));
    expect(l).toBe(28);
  });
});
