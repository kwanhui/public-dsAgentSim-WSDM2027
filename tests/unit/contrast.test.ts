// Muted text must clear 4.5:1 (WCAG AA for body text) on every surface it
// is set on, in both colour schemes. The tokens are read from globals.css,
// so a later change to a token is checked against the same surfaces.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");

type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance([r, g, b]: Rgb): number {
  const c = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
}

function tokens(block: string): Record<string, Rgb> {
  const out: Record<string, Rgb> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g)) {
    out[m[1]] = hslToRgb(Number(m[2]), Number(m[3]), Number(m[4]));
  }
  return out;
}

const light = tokens(css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")));
const dark = tokens(css.slice(css.indexOf("@media (prefers-color-scheme: dark)")));

describe.each([
  ["light", light],
  ["dark", dark],
])("muted text contrast (%s)", (_name, t) => {
  const bg = t.background;
  const surfaces: Record<string, Rgb> = {
    background: bg,
    muted: t.muted,
    "muted/40": mix(t.muted, bg, 0.4),
    "muted/50": mix(t.muted, bg, 0.5),
    "muted/60": mix(t.muted, bg, 0.6),
    "muted/40 on muted/40": mix(t.muted, mix(t.muted, bg, 0.4), 0.4),
    "primary/5": mix(t.primary, bg, 0.05),
    "primary/10": mix(t.primary, bg, 0.1),
    "primary/15": mix(t.primary, bg, 0.15),
    "flag/5": mix(t.flag, bg, 0.05),
  };
  it.each(Object.keys(surfaces))("clears 4.5:1 on %s", (surface) => {
    expect(ratio(t["muted-foreground"], surfaces[surface])).toBeGreaterThanOrEqual(4.5);
  });
});
