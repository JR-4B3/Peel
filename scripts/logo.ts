import { deflateSync } from "node:zlib";
import { apple, rgba, svg } from "../src/logo";

// Each logo pixel becomes a square block of the output size.
function scaled(size: number) {
  const { pixels, width } = rgba(apple);
  const scale = size / width, out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
    out.set(pixels.subarray(from, from + 4), (y * size + x) * 4);
  }
  return out;
}

function png(size: number) {
  const pixels = scaled(size), rows = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type)); body.set(data, 4);
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(body, 4); view.setUint32(8 + data.length, Bun.hash.crc32(body));
    return out;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, size); view.setUint32(4, size); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

// Windows icons hold one PNG per size. Explorer and the Start menu pick the closest.
function ico(sizes: number[]) {
  const images = sizes.map(png), header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + 16 * index;
    header[entry] = size % 256; header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index]!.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[index]!.length;
  });
  return Buffer.concat([header, ...images]);
}

// Writes the logo files from the pixel grid in src/logo.ts.
await Bun.write("assets/peel.svg", svg(apple, 16));
await Bun.write("assets/peel.png", png(1024));
await Bun.write("assets/peel.ico", ico([16, 32, 48, 256]));
console.log("Wrote assets/peel.svg, assets/peel.png, and assets/peel.ico.");
