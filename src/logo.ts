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

// The name in serif lowercase, drawn as outlines: the letters are filled from shapes, then
// only the pixels on their edges are kept.
function letters() {
  const height = 30, width = 69;
  const fill = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  const rect = (x: number, y: number, w: number, h: number) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) fill[j]![i] = true; };
  const each = (paint: (dx: number, dy: number) => boolean | undefined, cx: number, cy: number) => {
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) { const value = paint(i + 0.5 - cx, j + 0.5 - cy); if (value !== undefined) fill[j]![i] = value; }
  };
  const ring = (cx: number, cy: number, rx: number, ry: number, thickness: number) =>
    each((dx, dy) => (dx / rx) ** 2 + (dy / ry) ** 2 <= 1 && (dx / (rx - thickness)) ** 2 + (dy / (ry - thickness)) ** 2 > 1 || undefined, cx, cy);
  // x-height from row 9 to the baseline at 23, the ascender from row 1, the descender to 29.
  const top = 9, base = 23, middle = (top + base) / 2, radius = (base - top) / 2, stroke = 4;
  // p: a stem with a bowl, a serif at its top, and a foot below the descender.
  rect(3, top, stroke, 29 - top); ring(14, middle, 7, radius, stroke); rect(1, 27, 8, 2); rect(1, top, 3, 2);
  // e: a ring with a crossbar, open on the right between the crossbar and a stroke that ends at 50 degrees.
  for (const x of [23, 41]) {
    ring(x + 7.5, middle, 7.5, radius, stroke); rect(x + 1, Math.round(middle) - 1, 14, 2);
    each((dx, dy) => dx > 0 && dy > 1 && Math.atan2(dy, dx) < Math.PI * 50 / 180 ? false : undefined, x + 7.5, middle);
  }
  // l: a stem with a serif at its top and a foot on the baseline.
  rect(62, 1, stroke, base - 1); rect(59, 1, 3, 2); rect(59, base - 2, stroke + 6, 2);
  const edge = (i: number, j: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !fill[j + b!]?.[i + a!]);
  return fill.map((row, j) => row.map((on, i) => on && edge(i, j) ? "W" : ".").join(""));
}

export const wordmark = letters();

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
