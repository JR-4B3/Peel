// Release installs and updates. A release is one archive for every system: Peel runs on Bun, so
// each machine installs its own native packages with bun install after unpacking. An installed
// Peel lives in <root>/versions/<version>, and <root>/current names the version the launcher
// starts. Updates unpack beside it and switch current, so the running Peel is never changed.
// A source checkout has no version.json and updates through git instead.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir, readPreferences, saveJson, type Channel } from "./config";

export const repository = process.env.PEEL_REPOSITORY ?? "JR-4B3/Peel";
const api = process.env.PEEL_RELEASES_API ?? `https://api.github.com/repos/${repository}/releases`;
const appDir = fileURLToPath(new URL("..", import.meta.url));
// Checked at most this often, unless the channel changes.
const checkInterval = 6 * 60 * 60 * 1000;

export interface Build { version: string; channel: Channel; commit: string; date: string }
export interface Release extends Build { archive: string; sums: string }

// The build this Peel runs from, or undefined for a source checkout.
export async function currentBuild(dir = appDir): Promise<Build | undefined> {
  try { return JSON.parse(await readFile(join(dir, "version.json"), "utf8")); } catch { return undefined; }
}

// The install root when this Peel runs from <root>/versions/<version>.
export function installRoot(dir = appDir) {
  const versions = dirname(dir.replace(/[\\/]+$/, ""));
  return basename(versions) === "versions" ? dirname(versions) : undefined;
}

// Where `bun src/update.ts install` puts a new install.
export function defaultRoot() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Peel");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Peel");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "peel");
}

// The newest release on a channel. Stable is GitHub's latest release; nightly is the release
// tagged nightly, which the nightly workflow replaces each night that main changed.
export async function latestRelease(channel: Channel): Promise<Release> {
  const response = await fetch(channel === "nightly" ? `${api}/tags/nightly` : `${api}/latest`, {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) throw new Error(`There is no ${channel} release yet.`);
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
  const release = await response.json() as { assets: { name: string; browser_download_url: string }[] };
  const asset = (name: string) => release.assets.find(item => item.name === name)?.browser_download_url;
  const info = asset("version.json"), archive = asset("peel.tar.gz"), sums = asset("SHASUMS256.txt");
  if (!info || !archive || !sums) throw new Error(`The ${channel} release is missing files. It may still be uploading.`);
  const build = await (await fetch(info, { signal: AbortSignal.timeout(15000) })).json() as Build;
  if (typeof build.version !== "string" || !/^[\w.+-]+$/.test(build.version)) throw new Error(`The ${channel} release has no valid version.`);
  return { ...build, archive, sums };
}

async function run(args: string[], cwd?: string) {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${basename(args[0]!)} ${args[1] ?? ""} failed: ${(error || output).trim().split("\n").at(-1)}`);
}

// Downloads, checks, and unpacks a release into <root>/versions/<version>, installs its packages,
// and then points <root>/current at it. A release already there is reused.
export async function installRelease(release: Release, root: string, status: (text: string) => void = () => {}) {
  const versions = join(root, "versions"), target = join(versions, release.version);
  if (!existsSync(join(target, "version.json"))) {
    status(`Downloading Peel ${release.version}...`);
    const [archive, sums] = await Promise.all([fetch(release.archive), fetch(release.sums)]);
    if (!archive.ok || !sums.ok) throw new Error(`Could not download Peel ${release.version}: HTTP ${archive.ok ? sums.status : archive.status}.`);
    const bytes = await archive.arrayBuffer();
    const expected = (await sums.text()).split("\n").map(line => line.trim().split(/\s+/)).find(([, name]) => name === "peel.tar.gz")?.[0];
    if (!expected || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Peel ${release.version} did not match its published checksum.`);
    const partial = `${target}.${process.pid}.partial`, file = join(tmpdir(), `peel-${process.pid}.tar.gz`);
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    try {
      await writeFile(file, new Uint8Array(bytes));
      // tar ships with Linux, macOS, and Windows 10 and later.
      // On Windows the system's tar is named in full: Git's tar, often first on PATH, reads C: as a host.
      const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      await run([tar, "-xzf", file, "-C", partial]);
      const unpacked = await currentBuild(partial);
      if (unpacked?.version !== release.version) throw new Error(`The archive for Peel ${release.version} holds another version.`);
      status(`Installing Peel ${release.version}...`);
      await run([process.execPath, "install", "--frozen-lockfile", "--production"], partial);
      // Another Peel may have finished the same version first. Its copy is as good.
      await rename(partial, target).catch(error => { if (!existsSync(join(target, "version.json"))) throw error; });
    } finally {
      await rm(partial, { recursive: true, force: true });
      await rm(file, { force: true });
    }
  }
  const pointer = join(root, `current.${process.pid}.tmp`);
  await writeFile(pointer, release.version);
  await rename(pointer, join(root, "current"));
  await prune(versions, [release.version, (await currentBuild())?.version]);
}

// Keeps the new version and the one running now. Windows refuses to remove a version whose files
// are still open, so that one goes on a later update.
async function prune(versions: string, keep: (string | undefined)[]) {
  for (const name of await readdir(versions).catch(() => [])) {
    if (!keep.includes(name) && !name.endsWith(".partial")) await rm(join(versions, name), { recursive: true, force: true }).catch(() => {});
  }
}

export interface UpdateResult { build?: Build; message: string }

// Checks the channel and installs a newer build in the background. A source checkout only reports
// its version. force skips the six-hour wait, for a channel the listener just chose.
export async function checkForUpdate(channel: Channel, force = false, now = Date.now()): Promise<UpdateResult> {
  const build = await currentBuild(), root = installRoot();
  if (!build || !root) return { message: "Running from a source folder, which updates through git. bun src/update.ts install sets up a release that updates itself." };
  const label = `Peel ${build.version}`;
  const record = join(cacheDir, "update.json");
  const last = await readFile(record, "utf8").then(text => JSON.parse(text) as { checked: number; channel: Channel; message: string }).catch(() => undefined);
  if (!force && last && last.channel === channel && now - last.checked < checkInterval) return { build, message: last.message };
  let message: string;
  try {
    const release = await latestRelease(channel);
    if (release.version === build.version) message = `${label}, the newest ${channel} build.`;
    else {
      await installRelease(release, root);
      message = `Peel ${release.version} is installed. It starts the next time you open Peel.`;
    }
  } catch (error) {
    message = `${label}. Could not update: ${error instanceof Error ? error.message : String(error)} Peel tries again later.`;
  }
  await saveJson("update.json", { checked: now, channel, message }, cacheDir).catch(() => {});
  return { build, message };
}

// bun src/update.ts install [--channel nightly] [--root <folder>]: installs the newest release
// and a launcher that starts whichever version <root>/current names.
if (import.meta.main && process.argv[2] === "install") {
  const option = (name: string) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  const channel: Channel = option("--channel") === "nightly" ? "nightly" : "stable";
  const root = option("--root") ?? defaultRoot();
  const release = await latestRelease(channel);
  await installRelease(release, root, console.log);
  // The channel is a setting, so the installed Peel keeps updating from the same one.
  const preferences = await readPreferences();
  await saveJson("layout.json", { ...preferences, channel });
  const version = join(root, "versions", release.version);
  // The launcher scripts write peel, the desktop entry, and the app or Start menu entry.
  const script = process.platform === "win32"
    ? ["powershell", "-ExecutionPolicy", "Bypass", "-File", join(version, "scripts", "install-local.ps1")]
    : ["bash", join(version, "scripts", "install-local.sh")];
  const child = Bun.spawn(script, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, PEEL_RELEASE_ROOT: root } });
  process.exitCode = await child.exited;
}
