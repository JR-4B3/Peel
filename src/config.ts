import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Preferences {
  order: string[];
  hidden: string[];
  playbackBars: boolean;
}

export const configDir = process.env.PEEL_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "peel");
export const cacheDir = process.env.PEEL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "peel");
export const defaults: Preferences = { order: [], hidden: [], playbackBars: true };

export async function readPreferences(dir = configDir): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(join(dir, "layout.json"), "utf8"));
    return {
      order: Array.isArray(value.order) ? value.order.filter((v: unknown) => typeof v === "string") : [],
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((v: unknown) => typeof v === "string") : [],
      playbackBars: typeof value.playbackBars === "boolean" ? value.playbackBars : true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaults);
    throw new Error("Could not read Peel's layout.json. Fix or remove the file before starting.");
  }
}

export async function saveJson(name: string, value: unknown, dir = configDir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
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
