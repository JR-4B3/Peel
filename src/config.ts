import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Preferences {
  order: string[];
  hidden: string[];
  // Every song in Favourite Songs is a favourite, so its rows show no heart unless this is true.
  heartsInFavourites: boolean;
}

export const configDir = process.env.PEEL_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "peel");
export const cacheDir = process.env.PEEL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "peel");
export const defaults: Preferences = { order: [], hidden: [], heartsInFavourites: false };

export async function readPreferences(dir = configDir): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(join(dir, "layout.json"), "utf8"));
    return {
      order: Array.isArray(value.order) ? value.order.filter((v: unknown) => typeof v === "string") : [],
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((v: unknown) => typeof v === "string") : [],
      heartsInFavourites: value.heartsInFavourites === true,
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

export async function readToken(): Promise<string> {
  if (process.env.CIDER_API_TOKEN) return process.env.CIDER_API_TOKEN;
  try {
    const data = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8"));
    if (typeof data.token === "string") return data.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read Peel's auth.json. Run bun run connect again.");
  }
  return "";
}

export interface AppleSignIn { userToken: string; storefront?: string }

// The Music User Token copied from Cider by bun run connect.
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
