// Builds every icon from the logo mark below: `npm run icons`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(import.meta.dirname, "../..");
const assets = path.join(root, "assets");
const site = path.join(root, "site");

/** The mark is drawn on a 225 × 160 grid: an outlined L with a price tag tied to it. */
const MARK_WIDTH = 225;
const MARK_HEIGHT = 160;
const L_SHAPE = "M0 0H35V115L57 137H119L142 160H0Z";
const TAG = "M119 45H179L225 92L179 137H119L72 92Z";
const HOLE = { x: 105, y: 92, r: 8 };
const STRING = "M35 92H97";

type MarkOptions = { stroke: number; color: string; simple?: boolean };

/** `simple` is for favicon sizes, where outlines blur together: a solid L, a bold tag, no string. */
function mark({ stroke, color, simple = false }: MarkOptions): string {
  if (simple) {
    return `<g>
    <path d="${L_SHAPE}" fill="${color}"/>
    <path d="${TAG}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="miter" stroke-miterlimit="8"/>
    <circle cx="${HOLE.x + 4}" cy="${HOLE.y}" r="${HOLE.r + 5}" fill="${color}"/>
  </g>`;
  }
  return `<g fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="miter" stroke-miterlimit="8">
    <path d="${L_SHAPE}"/>
    <path d="${TAG}"/>
    <path d="${STRING}" stroke-linecap="butt"/>
    <circle cx="${HOLE.x}" cy="${HOLE.y}" r="${HOLE.r}"/>
  </g>`;
}

/** In mark units, so the straight string, whose bounding box has no height, still gets the gradient. */
const METAL = `<linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${MARK_WIDTH}" y2="${MARK_HEIGHT}">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="0.45" stop-color="#d4d4da"/>
    <stop offset="0.72" stop-color="#9a9aa2"/>
    <stop offset="1" stop-color="#ececf0"/>
  </linearGradient>`;

/**
 * The app icon: the mark on a dark rounded plate. macOS expects the plate inset 100px on a 1024 canvas;
 * `bleed` drops that inset for favicons, where every pixel counts.
 */
function iconSvg({ stroke, bleed = false, simple = false }: { stroke: number; bleed?: boolean; simple?: boolean }): string {
  const size = 1024;
  const inset = bleed ? 0 : 100;
  const plate = size - inset * 2;
  const radius = plate * 0.225;
  const markWidth = plate * (simple ? 0.8 : 0.66);
  const scale = markWidth / MARK_WIDTH;
  const x = (size - MARK_WIDTH * scale) / 2;
  const y = (size - MARK_HEIGHT * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs>
    ${METAL}
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2b2b"/>
      <stop offset="1" stop-color="#0b0b0b"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0" r="0.9">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}" fill="url(#plate)"${bleed ? "" : ' filter="url(#shadow)"'}/>
  <rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}" fill="url(#glow)"/>
  <rect x="${inset + 2}" y="${inset + 2}" width="${plate - 4}" height="${plate - 4}" rx="${radius - 2}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="4"/>
  <g transform="translate(${x} ${y}) scale(${scale})">${mark({ stroke, color: simple ? "#ececf0" : "url(#metal)", simple })}</g>
</svg>
`;
}

function png(svg: string, size: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** An .ico file holding PNG images, which every Windows version since Vista reads. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

/** The icon tuned for one pixel size: tiny sizes get the simple mark and lose the macOS inset. */
function sized(size: number, { bleed = false } = {}): Buffer {
  if (size <= 32) return png(iconSvg({ stroke: 26, simple: true, bleed: true }), size);
  return png(iconSvg({ stroke: size <= 64 ? 12 : 8, bleed }), size);
}

await mkdir(assets, { recursive: true });
const appIcon = iconSvg({ stroke: 8 });
await writeFile(path.join(assets, "icon.svg"), appIcon);
await writeFile(path.join(assets, "icon.png"), png(appIcon, 1024));

const winSizes = [16, 24, 32, 48, 64, 128, 256];
await writeFile(path.join(assets, "icon.ico"), ico(winSizes.map((size) => ({ size, data: sized(size) }))));

if (process.platform === "darwin") {
  const work = await mkdtemp(path.join(tmpdir(), "laya-icon-"));
  const iconset = path.join(work, "icon.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(path.join(iconset, `icon_${size}x${size}.png`), sized(size));
    await writeFile(path.join(iconset, `icon_${size}x${size}@2x.png`), sized(size * 2));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(assets, "icon.icns")]);
  await rm(work, { recursive: true, force: true });
} else {
  console.warn("Skipped icon.icns: iconutil only runs on macOS.");
}

await writeFile(path.join(site, "favicon.svg"), iconSvg({ stroke: 26, simple: true, bleed: true }));
await writeFile(path.join(site, "favicon.ico"), ico([16, 32, 48].map((size) => ({ size, data: sized(size, { bleed: true }) }))));
await writeFile(path.join(site, "apple-touch-icon.png"), sized(180, { bleed: true }));
console.log("Icons written to assets/ and site/.");
