import { NativeImage } from "@opentui/core";

// Peel's logo, drawn as pixel art: an apple with its lower half peeled, the peel curling away
// below it. The interface and assets/peel.svg both draw from this grid.
const palette: Record<string, string> = {
  B: "#7a4a36", // stem
  G: "#a6e3a1", // leaf
  g: "#5f9e6a", // leaf shade
  H: "#ff9eb0", // skin highlight
  R: "#e8475f", // skin
  D: "#a3304a", // skin shade
  C: "#fbe9c0", // flesh
  c: "#e2c48c", // flesh shade
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

// The name in outline letters, three rows tall like the logo beside it.
// The name in figlet's "Small Slant" face. The l rises above the other letters and the p descends below them.
export const wordmark = [
  "                 __",
  "   ___  ___ ___ / /",
  "  / _ \\/ -_) -_) / ",
  " / .__/\\__/\\__/_/  ",
  "/_/                ",
].join("\n");

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
export function logoImage(scale = 8) {
  const { pixels, width, height } = rgba(apple);
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
