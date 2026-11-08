import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Preferences {
  order: string[];
  hidden: string[];
  // Every song in Favourite Songs is a favourite, so its rows show no heart unless this is true.
  heartsInFavourites: boolean;
  // Which releases Peel updates to: tested releases, or each night's build of main.
  channel: Channel;
  // The engine's stream quality. Apple's web player offers AAC at 256 or 64 kbps.
  quality: Quality;
  // Ghostty's font size in points when Peel opens from its menu entry, or 0 for Ghostty's own.
  textSize: number;
  remote?: string;
  remotes?: string[];
}
export type Channel = "stable" | "nightly";
export type Quality = "high" | "standard";

// Each system keeps settings and caches in its own place: the XDG directories on Linux,
// ~/Library on macOS, and AppData on Windows.
export function systemDir(kind: "config" | "cache") {
  if (process.platform === "win32") return kind === "config" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming") : process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", kind === "config" ? "Application Support" : "Caches");
  return kind === "config" ? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config") : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

export const configDir = process.env.PEEL_CONFIG_DIR ?? join(systemDir("config"), "peel");
export const cacheDir = process.env.PEEL_CACHE_DIR ?? join(systemDir("cache"), "peel");
export const defaults: Preferences = { order: [], hidden: [], heartsInFavourites: false, channel: "stable", quality: "high", textSize: 0 };
export const textSizes = [0, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24];

export async function readPreferences(dir = configDir): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(join(dir, "layout.json"), "utf8"));
    return {
      order: Array.isArray(value.order) ? value.order.filter((v: unknown) => typeof v === "string") : [],
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((v: unknown) => typeof v === "string") : [],
      heartsInFavourites: value.heartsInFavourites === true,
      channel: value.channel === "nightly" ? "nightly" : "stable",
      quality: value.quality === "standard" ? "standard" : "high",
      textSize: textSizes.includes(value.textSize) ? value.textSize : 0,
      ...(typeof value.remote === "string" ? { remote: value.remote } : {}),
      ...(Array.isArray(value.remotes) ? { remotes: value.remotes.filter((host: unknown) => typeof host === "string") } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaults);
    throw new Error("Could not read Peel's layout.json. Fix or remove the file before starting.");
  }
}

// Saves to one file run one after another in the order they were called, so the last call's
// value is what stays on disk. Each save writes its own temporary file and renames it into place.
const saving = new Map<string, Promise<void>>();
let saves = 0;

export function saveJson(name: string, value: unknown, dir = configDir): Promise<void> {
  const path = join(dir, name);
  // The value is read now, so later changes to the object do not reach this save.
  const text = JSON.stringify(value, null, 2) + "\n";
  const save = (saving.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${++saves}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  });
  saving.set(path, save);
  void save.catch(() => {}).finally(() => { if (saving.get(path) === save) saving.delete(path); });
  return save;
}

export async function readCache<T>(name: string, dir = cacheDir): Promise<T | undefined> {
  try { return JSON.parse(await readFile(join(dir, name), "utf8")); } catch { return undefined; }
}

export interface AppleSignIn { userToken: string; storefront?: string }

// The Music User Token that bun run connect saved from the engine's Apple sign-in.
export async function readAppleSignIn(): Promise<AppleSignIn> {
  if (process.env.APPLE_MUSIC_USER_TOKEN) return { userToken: process.env.APPLE_MUSIC_USER_TOKEN };
  try {
    const data = JSON.parse(await readFile(join(configDir, "apple.json"), "utf8"));
    if (typeof data.userToken === "string") return { userToken: data.userToken, storefront: typeof data.storefront === "string" ? data.storefront : undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read Peel's apple.json. Run bun run connect again.");
  }
  return { userToken: "" };
}

// Peel's menu entry and app open Ghostty with this file as an extra config file
// (scripts/install-local.sh), so the Text size setting applies the next time Peel opens there.
export async function saveTerminalConfig(preferences: Preferences, dir = configDir) {
  const lines = ["# Written by Peel's Text size setting. Peel's menu entry loads it when it opens Ghostty."];
  if (preferences.textSize) lines.push(`font-size = ${preferences.textSize}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "ghostty.conf"), partial = `${path}.${process.pid}.tmp`;
  await writeFile(partial, lines.join("\n") + "\n");
  await rename(partial, path);
}
