import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { VibeflowIcon } from "@vibeflow-tools/ui";

function parseSvg(html: string): { rects: DOMRect[]; viewBox: string } {
  // Simple regex extraction — avoids JSDOM dependency
  const viewBoxMatch = html.match(/viewBox="([^"]+)"/);
  const viewBox = viewBoxMatch?.[1] ?? "";
  const rects: DOMRect[] = [];
  const rectRegex = /<rect\s+([^>]*?)(?:\/\s*>|>\s*<\/rect>)/g;
  let m: RegExpExecArray | null;
  while ((m = rectRegex.exec(html)) !== null) {
    const attrs = m[1];
    const get = (name: string): number => {
      const n = attrs.match(new RegExp(`${name}="([^"]+)"`));
      return n ? Number(n[1]) : 0;
    };
    rects.push({
      x: get("x"),
      y: get("y"),
      width: get("width"),
      height: get("height"),
      rx: get("rx"),
      opacity: Number(attrs.match(/opacity="([^"]+)"/)?.[1] ?? "1"),
    } as unknown as DOMRect);
  }
  return { rects, viewBox };
}

describe("VibeflowIcon", () => {
  it("renders viewBox 0 0 18 18", () => {
    const svg = renderToString(<VibeflowIcon />);
    const { viewBox } = parseSvg(svg);
    expect(viewBox).toBe("0 0 18 18");
  });

  it("has aria-label Vibeflow and role img", () => {
    const svg = renderToString(<VibeflowIcon />);
    expect(svg).toContain('aria-label="Vibeflow"');
    expect(svg).toContain('role="img"');
  });

  it("renders exactly 5 rects (bg + 4 bars)", () => {
    const svg = renderToString(<VibeflowIcon />);
    const { rects } = parseSvg(svg);
    expect(rects).toHaveLength(5);
  });

  it("bg rect is 18x18 rx=4 blue", () => {
    const svg = renderToString(<VibeflowIcon />);
    const { rects } = parseSvg(svg);
    const bg = rects[0];
    // React omits x/y when they are 0 (SVG defaults)
    expect(bg.width).toBe(18);
    expect(bg.height).toBe(18);
    expect(bg.rx).toBe(4);
    // Verify blue fill on the bg rect
    expect(svg).toContain('fill="#2563eb"');
  });

  it("4 bars have uniform width 2.5, centered on midline y+h/2=9", () => {
    const svg = renderToString(<VibeflowIcon />);
    const { rects } = parseSvg(svg);
    const bars = rects.slice(1);
    expect(bars).toHaveLength(4);

    // Uniform width
    for (const bar of bars) {
      expect(bar.width).toBe(2.5);
    }

    // Midline centered: y + height/2 = 9
    for (const bar of bars) {
      expect(bar.y + bar.height / 2).toBe(9);
    }
  });

  it("bars have correct heights and opacities (descending 10/12/8/6)", () => {
    const svg = renderToString(<VibeflowIcon />);
    const { rects } = parseSvg(svg);
    const bars = rects.slice(1);

    expect(bars[0].height).toBe(10);
    expect(bars[0].opacity).toBeCloseTo(0.9);

    expect(bars[1].height).toBe(12);
    expect(bars[1].opacity).toBe(1);

    expect(bars[2].height).toBe(8);
    expect(bars[2].opacity).toBeCloseTo(0.8);

    expect(bars[3].height).toBe(6);
    expect(bars[3].opacity).toBeCloseTo(0.6);
  });

  it("bars are evenly spaced (x = 2.5 / 6.5 / 10.5 / 14.5)", () => {
    const svg = renderToString(<VibeflowIcon />);
    const { rects } = parseSvg(svg);
    const bars = rects.slice(1);

    expect(bars[0].x).toBe(2.5);
    expect(bars[1].x).toBe(6.5);
    expect(bars[2].x).toBe(10.5);
    expect(bars[3].x).toBe(14.5);
  });

  it("snapshot of full SVG output", () => {
    const svg = renderToString(<VibeflowIcon />);
    expect(svg).toMatchSnapshot();
  });
});
