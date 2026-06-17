import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const css = readFileSync(join(root, "src/index.css"), "utf8");

function parseVars(selector) {
  const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing ${selector} theme block`);
  return Object.fromEntries(
    [...match[1].matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]+\));/g)].map(([, name, value]) => [
      name,
      value,
    ])
  );
}

function parseOklch(value) {
  const match = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(match, `expected oklch() color, got ${value}`);
  return match.slice(1).map(Number);
}

function oklchToRgb(value) {
  const [l, c, hDegrees] = parseOklch(value);
  const h = (hDegrees * Math.PI) / 180;
  const a = Math.cos(h) * c;
  const b = Math.sin(h) * c;

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const lms = [lPrime ** 3, mPrime ** 3, sPrime ** 3];
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ].map((channel) => Math.min(1, Math.max(0, channel)));

  return linear.map((channel) =>
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
  );
}

function luminance(color) {
  const [r, g, b] = oklchToRgb(color).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const contrastPairs = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
];

for (const [selector, label] of [
  [":root", "light"],
  [".dark", "dark"],
]) {
  test(`${label} theme token pairs meet WCAG AA contrast`, () => {
    const vars = parseVars(selector);
    for (const [foreground, background] of contrastPairs) {
      assert.ok(vars[foreground], `${label} theme missing --${foreground}`);
      assert.ok(vars[background], `${label} theme missing --${background}`);
      assert.ok(
        contrast(vars[foreground], vars[background]) >= 4.5,
        `${label} ${foreground} on ${background} is below 4.5:1`
      );
    }
  });
}

test("warning rail has non-text contrast against sidebar", () => {
  for (const [selector, label] of [
    [":root", "light"],
    [".dark", "dark"],
  ]) {
    const vars = parseVars(selector);
    assert.ok(vars.warning, `${label} theme missing --warning`);
    assert.ok(vars.sidebar, `${label} theme missing --sidebar`);
    assert.ok(
      contrast(vars.warning, vars.sidebar) >= 3,
      `${label} warning on sidebar is below 3:1`
    );
  }
});

function appComponentFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (path.includes("/components/ui")) return [];
    if (statSync(path).isDirectory()) return appComponentFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

test("app components use semantic theme color utilities", () => {
  const rawPaletteClass =
    /\b(?:bg|text|border|ring|outline|hover:bg|hover:text|hover:border|focus:bg|focus:text)-(?:neutral|slate|zinc|gray|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?\b/g;
  const offenders = appComponentFiles(join(root, "src")).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(rawPaletteClass)].map((match) => `${file.replace(`${root}/`, "")}: ${match[0]}`);
  });

  assert.deepEqual(offenders, []);
});
