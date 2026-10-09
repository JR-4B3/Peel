import { NativeImage } from "@opentui/core";

// Peel's logo: an apple peel in pixel art, a red spiral still in the shape of the apple.
// The interface and assets/peel.svg both draw from this grid.
const palette: Record<string, string> = {
  B: "#7a4a36", // stem
  H: "#ff9eb0", // highlight on the front of a turn
  R: "#e8475f", // the front of a turn
  D: "#a3304a", // the back of a turn
};

// The peel winds down around the apple's outline. Seen from slightly above, the front of each
// turn sits lower than its back, and the front is drawn over the back.
function coil(size = 32, turns = 4.5, tilt = 2.4) {
  const grid = Array.from({ length: size }, () => Array<string>(size).fill("."));
  const depth = Array.from({ length: size }, () => Array<number>(size).fill(-Infinity));
  const top = tilt + 4, bottom = size - tilt - 1.5;
  // The outline's half-width at height v, from 0 at the top to 1 at the bottom: broad shoulders, a narrower base.
  const radius = (v: number) => (size / 2 - 1.5) * Math.pow(Math.sin(Math.PI * (0.14 + v * 0.8)), 0.5) * (1.04 - 0.22 * v);
  const steps = 6000;
  for (let i = 0; i <= steps; i++) {
    const v = i / steps, angle = v * turns * Math.PI * 2;
    const x = size / 2 + radius(v) * Math.sin(angle), z = Math.cos(angle);
    const y = top + v * (bottom - top) + z * tilt;
    // The back of a turn is thinner and darker, which leaves gaps between the turns.
    const front = z > -0.35;
    for (let dy = 0; dy < (front ? 2 : 1); dy++) {
      const px = Math.floor(x), py = Math.floor(y + dy);
      if (px < 0 || py < 0 || px >= size || py >= size || z <= depth[py]![px]!) continue;
      depth[py]![px] = z;
      grid[py]![px] = !front ? "D" : dy === 0 && z > 0.8 ? "H" : "R";
    }
  }
  // A short stem rises from the top turn.
  for (let y = 1; y < top - tilt + 2; y++) grid[y]![Math.floor(size / 2) + (y < 3 ? 1 : 0)] = "B";
  return grid.map(row => row.join(""));
}

export const peel = coil();

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
export function logoImage(scale = 4) {
  const { pixels, width, height } = rgba(peel);
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
