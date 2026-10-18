import { NativeImage } from "@opentui/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./config";

const size = 240;
const capacity = 150;
const images = new Map<string, Promise<NativeImage | undefined>>();

// Apple artwork URLs are templates ({w}x{h}bb.{f}) or already sized library URLs.
export function artworkUrl(template: string, pixels = size) {
  return template.replace("{w}x{h}", `${pixels}x${pixels}`).replace("{f}", "jpg").replace(/\/\d+x\d+(\w*)\.(png|jpe?g|webp)$/, `/${pixels}x${pixels}$1.jpg`);
}

async function fetchCover(url: string, dir = join(cacheDir, "artwork")) {
  const file = join(dir, `${new Bun.CryptoHasher("sha1").update(url).digest("hex")}.jpg`);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(file)); }
  catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return undefined;
    bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(dir, { recursive: true }).then(() => writeFile(file, bytes)).catch(() => {});
  }
  return NativeImage.decode(bytes);
}

// Covers are shared between tiles and the player. Renderables retain their own reference.
export function cover(template?: string, dir = join(cacheDir, "artwork")): Promise<NativeImage | undefined> | undefined {
  if (!template) return undefined;
  const url = artworkUrl(template);
  let image = images.get(url);
  if (image) { images.delete(url); images.set(url, image); return image; }
  image = fetchCover(url, dir).catch(() => undefined);
  images.set(url, image);
  if (images.size > capacity) {
    const [oldest, evicted] = images.entries().next().value!;
    images.delete(oldest);
    void evicted.then(value => value?.dispose());
  }
  return image;
}

// Round up to whole hundreds so the disk cache keeps few copies of one cover.
export function largeCoverSize(pixels: number) {
  return Math.min(3000, Math.max(600, Math.ceil(pixels / 100) * 100));
}

// The enlarged cover skips the shared cache. Its caller owns and disposes the image.
export function largeCover(template: string, pixels: number, dir?: string) {
  const side = largeCoverSize(pixels);
  return fetchCover(artworkUrl(template, side), dir).catch(() => undefined);
}
