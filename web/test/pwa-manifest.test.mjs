import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(
  readFileSync(join(root, "public/manifest.webmanifest"), "utf8"),
);

test("manifest declares both 'any' and 'maskable' icon variants in each size", () => {
  // Issue #22: Android adaptive icons need purpose:maskable variants with a
  // safe-zone-aware render. We ship both purposes side-by-side so the OS can
  // pick the right one per context (`any` for non-adaptive surfaces like the
  // browser tab; `maskable` for the launcher / install prompt).
  const sizes = ["192x192", "512x512"];
  for (const size of sizes) {
    const variants = manifest.icons.filter((i) => i.sizes === size);
    const purposes = variants.map((i) => i.purpose).sort();
    assert.deepEqual(
      purposes,
      ["any", "maskable"],
      `expected both 'any' and 'maskable' for ${size}, got ${JSON.stringify(purposes)}`,
    );
  }
});

test("each manifest icon entry declares an explicit purpose (not the spec default)", () => {
  // Spec default is 'any' when omitted, but explicit beats implicit — and a
  // future audit tool flags omitted purpose fields. Guard against future
  // entries being added without one.
  for (const icon of manifest.icons) {
    assert.ok(
      typeof icon.purpose === "string" && icon.purpose.length > 0,
      `icon ${JSON.stringify(icon.src)} missing explicit 'purpose' field`,
    );
  }
});

test("every manifest icon entry points at a real file in web/public/", () => {
  for (const icon of manifest.icons) {
    // src is absolute-from-root in the manifest (e.g. "/icon-192.png"); strip
    // the leading slash to resolve against web/public/.
    const rel = icon.src.replace(/^\//, "");
    const path = join(root, "public", rel);
    assert.ok(existsSync(path), `manifest references ${icon.src} but ${path} does not exist`);
    // Sanity: nonempty PNG.
    const stat = statSync(path);
    assert.ok(stat.size > 0, `${path} is empty`);
  }
});

test("maskable icon files are valid PNGs at their declared dimensions", () => {
  // Read the PNG signature + IHDR chunk and verify the file is actually a
  // PNG at the size the manifest claims. Bytewise content check (corner
  // colors etc) needs an image decoder and is exercised by the render
  // script's manual visual smoke + the corner-sample script in scripts/.
  for (const { src, sizes } of manifest.icons) {
    if (src.indexOf("maskable") === -1) continue;
    const rel = src.replace(/^\//, "");
    const buf = readFileSync(join(root, "public", rel));
    // PNG signature: 8 bytes, 89 50 4E 47 0D 0A 1A 0A.
    assert.deepEqual(
      Array.from(buf.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${src}: missing PNG signature`,
    );
    // IHDR chunk starts at byte 8, format: [length:4][type:4]['IHDR'][width:4 BE][height:4 BE]
    assert.deepEqual(
      Array.from(buf.subarray(12, 16)),
      [0x49, 0x48, 0x44, 0x52], // 'IHDR'
      `${src}: missing IHDR chunk`,
    );
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const [expectedW, expectedH] = sizes.split("x").map(Number);
    assert.equal(width, expectedW, `${src}: IHDR width ${width} != manifest sizes ${sizes}`);
    assert.equal(height, expectedH, `${src}: IHDR height ${height} != manifest sizes ${sizes}`);
  }
});
