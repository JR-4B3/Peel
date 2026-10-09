import { NativeImage } from "@opentui/core";

// Peel's logo, drawn as pixel art: an apple with its lower half peeled, the peel curling away
// below it, and the name beside it. The interface and the SVG files in assets draw from these grids.
const palette: Record<string, string> = {
  B: "#7a4a36", // stem
  G: "#a6e3a1", // leaf
  g: "#5f9e6a", // leaf shade
  H: "#ff9eb0", // skin highlight
  R: "#e8475f", // skin
  D: "#a3304a", // skin shade
  C: "#fbe9c0", // flesh
  c: "#e2c48c", // flesh shade
  W: "#cdd6f4", // lettering
};

export const apple = [
  ".......B........",
  ".......BGGg.....",
  "...RRR.BGg......",
  "..RHHRRBRRRR....",
  ".RHHRRRRRRRRRD..",
  ".RHRRRRRRRRRRDD.",
  ".RRRRRRRRRRRRRD.",
  ".CCCCCCCCCCCCRRD",
  ".CCCCCCCCCCCcCRD",
  "..CCCCCCCCCccCcR",
  "..cCCCCCCCcc.RRD",
  "...ccccccc..RD..",
  "...........cC...",
  "..........RRD...",
  "...........RRD..",
  "............DD..",
];

// The name in slanted ASCII letters (figlet's "slant" face), set with a space between letters.
const glyphs: Record<string, string[]> = {
  p: ["          ", "    ____  ", "   / __ \\ ", "  / /_/ / ", " / .___/  ", "/_/       "],
  e: ["       ", "  ___  ", " / _ \\ ", "/  __/ ", "\\___/  ", "       "],
  l: ["    __", "   / /", "  / / ", " / /  ", "/_/   ", "      "],
};
export const wordmark = glyphs.p!.map((_, row) => [..."peel"].map(char => glyphs[char]![row]).join(" "));

// Each character becomes a line across its cell, as the terminal would draw it but joined up.
// Cells are twice as tall as they are wide.
type Line = [number, number, number, number];
function lines(rows: string[]) {
  const result: Line[] = [];
  rows.forEach((row, y) => [...row].forEach((char, x) => {
    if (char === "/") result.push([x, (y + 1) * 2, x + 1, y * 2]);
    else if (char === "\\") result.push([x, y * 2, x + 1, (y + 1) * 2]);
    else if (char === "_") result.push([x, (y + 1) * 2, x + 1, (y + 1) * 2]);
  }));
  return result;
}

// Draws the lines smoothly in the lettering colour, with four by four samples a pixel.
export function lineImage(rows: string[], cell = 6, stroke = 2.2) {
  const scale = cell, margin = stroke;
  const segments = lines(rows).map(([x1, y1, x2, y2]) => [x1 * scale + margin, y1 * scale + margin, x2 * scale + margin, y2 * scale + margin] as Line);
  const width = Math.ceil(rows[0]!.length * scale + margin * 2), height = Math.ceil(rows.length * 2 * scale + margin * 2);
  const pixels = new Uint8Array(width * height * 4), samples = 4;
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(palette.W!.slice(offset, offset + 2), 16));
  const near = (px: number, py: number) => segments.some(([x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - x1 - t * dx, py - y1 - t * dy) <= stroke / 2;
  });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let covered = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) if (near(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) covered++;
    if (covered) pixels.set([r!, g!, b!, Math.round(255 * covered / samples ** 2)], (y * width + x) * 4);
  }
  return NativeImage.fromRgba(pixels, width, height);
}

export function lineSvg(rows: string[], scale = 8) {
  const width = rows[0]!.length, height = rows.length * 2;
  const paths = lines(rows).map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 ${width + 1} ${height + 1}" width="${(width + 1) * scale}" height="${(height + 1) * scale}">\n<g stroke="${palette.W}" stroke-width="0.3" stroke-linecap="round">\n${paths.join("\n")}\n</g>\n</svg>\n`;
}

export function rgba(rows: string[]) {
  const width = rows[0]!.length, height = rows.length;
  const pixels = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((key, x) => {
    const hex = palette[key];
    if (!hex) return;
    pixels.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255], (y * width + x) * 4);
  }));
  return { pixels, width, height };
}

// Enlarged with hard edges before it reaches the terminal, so scaling it to the cells keeps the pixels square.
export function pixelImage(rows: string[], scale = 8) {
  const { pixels, width, height } = rgba(rows);
  const image = NativeImage.fromRgba(pixels, width, height);
  const large = image.resize({ width: width * scale, height: height * scale, kernel: "nearest" });
  image.dispose();
  return large;
}

export function svg(rows: string[], scale = 1) {
  const width = rows[0]!.length, height = rows.length;
  const rects = rows.flatMap((row, y) => [...row].flatMap((key, x) => palette[key] ? [`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[key]}"/>`] : []));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * scale}" height="${height * scale}" shape-rendering="crispEdges">\n${rects.join("\n")}\n</svg>\n`;
}
