import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cacheDir, systemDir } from "./config";
import type { Media, Page, Playback, Player } from "./types";

// Peel's own playback engine in engine/: MusicKit JS in castlabs' Electron. It writes its
// port and a private key to key.json in this folder each time it starts. Windows keeps the
// engine's browser profile in the local AppData folder, which does not roam between PCs.
export const engineHome = process.env.PEEL_ENGINE_HOME ?? join(systemDir(process.platform === "win32" ? "cache" : "config"), "peel-engine");
const engineDir = fileURLToPath(new URL("../engine/", import.meta.url));
// A release install shares one Electron download between its versions, so an update does not
// download it again. A source checkout keeps it in engine/.electron.
const electronDir = process.env.PEEL_ELECTRON_DIR ?? join(engineDir, ".electron");
export const electronVersion = "v44.5.1+wvcus";
const electronPath = join(electronDir, process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
// Widevine on Windows and macOS rejects players without a VMP signature from castlabs' EVS service.
// Peel's maintainer signs castlabs' Electron once per version with scripts/sign-engine.ts and
// publishes it as a release, so listeners need no EVS account. Linux uses castlabs' build directly.
const needsSignature = process.platform === "win32" || process.platform === "darwin";
const engineRepository = "JR-4B3/Peel";
const engineReleases = process.env.PEEL_ENGINE_RELEASES ?? `https://github.com/${engineRepository}/releases/download`;
export const engineTag = `engine-${electronVersion}`;
export const signedName = (platform: string, arch: string) => `peel-engine-${electronVersion}-${platform}-${arch}.zip`;
const signedMarker = join(electronDir, ".vmp-signed");

export async function command(args: string[], interactive = false) {
  const child = Bun.spawn(args, interactive ? { stdio: ["inherit", "inherit", "inherit"] } : { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    interactive ? "" : new Response(child.stdout as ReadableStream).text(), interactive ? "" : new Response(child.stderr as ReadableStream).text(), child.exited,
  ]);
  return { output, error, code };
}

const unsafe = (name: string) => new Error(`The playback engine's archive contains an unsafe path: ${name}`);

// Creates the folders down to an entry. Each one must be a real folder, not a symlink, so no
// entry can be written outside target through a link an earlier entry created.
async function folders(target: string, parts: string[], name: string) {
  let current = target;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) await mkdir(current);
    else if (!info.isDirectory()) throw unsafe(name);
  }
}

// Unpacks a zip file. Linux distributions do not all include unzip, and Electron's Linux
// archive needs only files, folders, symlinks, and their permissions. ZIP64 is not supported.
// Symlinks may only point down into their own folder, and no entry replaces an existing one.
export async function unzip(archive: Uint8Array<ArrayBuffer>, target: string) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("The playback engine's archive is damaged.");
  const count = view.getUint16(end + 10, true);
  let entry = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index++) {
    if (view.getUint32(entry, true) !== 0x02014b50) throw new Error("The playback engine's archive is damaged.");
    const method = view.getUint16(entry + 10, true), size = view.getUint32(entry + 20, true);
    const nameLength = view.getUint16(entry + 28, true), mode = view.getUint32(entry + 38, true) >>> 16;
    const name = new TextDecoder().decode(archive.subarray(entry + 46, entry + 46 + nameLength));
    const local = view.getUint32(entry + 42, true);
    entry += 46 + nameLength + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
    const parts = name.split("/").filter(part => part && part !== ".");
    if (name.startsWith("/") || !parts.length || parts.includes("..")) throw unsafe(name);
    if (name.endsWith("/")) { await folders(target, parts, name); continue; }
    const path = join(target, ...parts);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const stored = archive.subarray(start, start + size);
    const data = method === 0 ? stored : method === 8 ? Bun.inflateSync(stored) : undefined;
    if (!data) throw new Error(`The playback engine's archive uses an unsupported compression for ${name}.`);
    await folders(target, parts.slice(0, -1), name);
    if ((mode & 0o170000) === 0o120000) {
      const link = new TextDecoder().decode(data);
      // A Windows path such as C:\ or \\server counts as absolute too.
      if (!link || /^([\\/]|[A-Za-z]:)/.test(link) || link.split(/[\\/]/).includes("..")) throw unsafe(`${name} -> ${link}`);
      await symlink(link, path);
    }
    else await writeFile(path, data, { mode: mode & 0o777 || 0o644, flag: "wx" });
  }
}

// Windows 10 and later include bsdtar, which reads zip files. ditto keeps the symlinks in
// macOS's app bundle.
async function extract(archive: Uint8Array<ArrayBuffer>, file: string, target: string) {
  if (process.platform === "linux") return unzip(archive, target);
  await writeFile(file, archive);
  // The system's tar is named in full: Git's GNU tar, often first on PATH, cannot read zip files.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const result = await command(process.platform === "win32" ? [tar, "-xf", file, "-C", target] : ["ditto", "-x", "-k", file, target]);
  await rm(file, { force: true });
  if (result.code) throw new Error(`Could not unpack the playback engine: ${result.error.trim()}`);
}

// While Peel's repository is private, its releases answer 404 without a GitHub sign-in. The gh
// CLI, when signed in with access, downloads them instead.
async function fetchAsset(release: string, name: string, signed: boolean, signal?: AbortSignal) {
  const response = await fetch(`${release}/${name}`, { signal });
  if (response.ok || !signed || process.env.PEEL_ENGINE_RELEASES || !Bun.which("gh")) return response;
  const file = join(tmpdir(), `peel-${process.pid}-${name}`);
  try {
    const result = await command(["gh", "release", "download", engineTag, "-R", engineRepository, "-p", name, "-O", file, "--clobber"]);
    return result.code ? response : new Response(await readFile(file));
  } finally { await rm(file, { force: true }); }
}

// Downloads castlabs' Electron, or on Windows and macOS the copy Peel's maintainer signed, and
// checks it against the published checksums. scripts/sign-engine.ts passes signed = false.
export async function download(status: (text: string) => void, target = electronDir, platform: string = process.platform, arch: string = process.arch, signed = needsSignature) {
  if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error(`Peel's playback engine has no build for ${platform} on ${arch}.`);
  status("Downloading the playback engine. This happens once...");
  const name = signed ? signedName(platform, arch) : `electron-${electronVersion}-${platform}-${arch}.zip`;
  const release = signed ? `${engineReleases}/${engineTag}` : `https://github.com/castlabs/electron-releases/releases/download/${electronVersion}`;
  const [archive, sums] = await Promise.all([fetchAsset(release, name, signed), fetchAsset(release, "SHASUMS256.txt", signed)]);
  if (!archive.ok || !sums.ok) throw new Error(`Could not download the playback engine from ${release}: HTTP ${archive.ok ? sums.status : archive.status}.`);
  const bytes = await archive.arrayBuffer();
  const expected = checksum(await sums.text(), name);
  if (!expected || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected) throw new Error("The downloaded playback engine did not match its published checksum. Open Peel again to retry.");
  // Unpack beside the final folder and rename it into place, so an interrupted unpack is never
  // used. The copy it replaces is moved aside first and put back if the switch fails.
  const partial = `${target}.${process.pid}.tmp`, previous = `${target}.${process.pid}.old`;
  await rm(partial, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  try {
    await extract(new Uint8Array(bytes), `${partial}.zip`, partial);
    // The signed archive's checksum tells a renewed signature for the same version apart.
    if (signed) await writeFile(join(partial, ".vmp-signed"), `${electronVersion}\n${expected}\n`);
    const replacing = existsSync(target);
    if (replacing) await rename(target, previous);
    try { await rename(partial, target); } catch (error) { if (replacing) await rename(previous, target); throw error; }
  } finally {
    await rm(partial, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
}

// The checksum SHASUMS256.txt lists for a file, from lines of "<sha256>  <name>".
function checksum(sums: string, name: string) {
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file?.replace(/^\*/, "") === name && /^[0-9a-f]{64}$/.test(hash ?? "")) return hash;
  }
}

// castlabs' VMP signatures run out, so Peel's maintainer signs the same Electron version again
// and replaces the release's archives and checksums. At most once a day Peel compares the
// release's checksum with the one its signed copy came from and downloads the renewed copy when
// they differ. A failed check or download keeps the copy Peel has, and is tried again a day later.
const renewalInterval = 24 * 60 * 60 * 1000;
const renewalChecked = (target: string) => join(target, ".vmp-checked");

async function renewalDue(target: string, now: number) {
  const last = (await stat(renewalChecked(target)).catch(() => undefined))?.mtimeMs ?? 0;
  return now - last >= renewalInterval;
}

export async function renewSignature(status: (text: string) => void, target = electronDir, platform: string = process.platform, arch: string = process.arch, now = Date.now()) {
  if (!await renewalDue(target, now)) return false;
  let renewed = false;
  try {
    const name = signedName(platform, arch);
    const sums = await fetchAsset(`${engineReleases}/${engineTag}`, "SHASUMS256.txt", true, AbortSignal.timeout(15000));
    const published = sums.ok ? checksum(await sums.text(), name) : undefined;
    const current = (await readFile(join(target, ".vmp-signed"), "utf8").catch(() => "")).split("\n")[1]?.trim();
    if (published && published !== current) {
      status("Downloading the playback engine's renewed signature...");
      await download(() => {}, target, platform, arch, true);
      renewed = true;
    }
  } catch {}
  const checked = renewalChecked(target), time = new Date(now);
  await writeFile(checked, "").then(() => utimes(checked, time, time)).catch(() => {});
  return renewed;
}

// Electron's archive includes a version file. A different version, from an older Peel, is replaced.
async function downloaded() {
  return existsSync(electronPath) && (await readFile(join(electronDir, "version"), "utf8").catch(() => "")).trim() === electronVersion.slice(1);
}

// The marker's first line is the Electron version. Its second, the signed archive's checksum.
async function installed() {
  return await downloaded() && (!needsSignature || (await readFile(signedMarker, "utf8").catch(() => "")).split("\n")[0]?.trim() === electronVersion);
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// Two Peels starting at once would otherwise replace each other's engine mid-install. The lock
// is a folder, which only one process can create, holding the installer's process ID. A lock
// whose installer has exited, for example because its terminal closed, is taken over at once.
// A lock without an ID for more than ten seconds is from an installer that died while creating it.
async function withInstallLock(status: (text: string) => void, work: () => Promise<void>) {
  const lock = `${electronDir}.lock`, owner = join(lock, "pid");
  for (let waiting = false; ; waiting = true) {
    try { await mkdir(lock); await writeFile(owner, String(process.pid)); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(owner, "utf8").catch(() => ""));
      const since = (await stat(lock).catch(() => undefined))?.mtimeMs;
      if (pid > 0 ? !alive(pid) : since !== undefined && Date.now() - since > 10000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (!waiting) status("Waiting for another Peel to finish installing the playback engine...");
      await sleep(500);
    }
  }
  try { await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}

// Downloads the playback engine for this system once. An unsigned copy on Windows or macOS,
// from an earlier Peel, is replaced by the signed one.
export async function installEngine(status: (text: string) => void = () => {}) {
  if (await installed()) {
    if (needsSignature && await renewalDue(electronDir, Date.now())) await withInstallLock(status, async () => { await renewSignature(status); });
    return;
  }
  await withInstallLock(status, async () => { if (!await installed()) await download(status); });
}

// Electron started with ELECTRON_RUN_AS_NODE runs as plain Node and cannot load the engine.
// Terminals inside Electron apps, such as T3 Code's, set it for their own child processes.
function engineEnvironment() {
  const environment: Record<string, string | undefined> = { ...process.env, PEEL_ENGINE_HOME: engineHome, PEEL_CACHE_DIR: cacheDir, PEEL_OWNER: String(process.pid), ...ownerRole() };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function electronArgs() {
  // Electron cannot always detect Wayland on its own, for example when started outside the desktop session.
  if (process.platform !== "linux") return [];
  return [process.env.WAYLAND_DISPLAY ? "--ozone-platform=wayland" : "--ozone-platform-hint=auto"];
}

// On a Linux desktop with systemd, the user manager owns the engine, so closing Peel's terminal
// does not take it down mid-song. Elsewhere the engine runs as a detached process.
export function systemdSession() {
  return process.platform === "linux" && !!Bun.which("systemd-run") && existsSync("/run/systemd/system")
    && !!process.env.XDG_RUNTIME_DIR && existsSync(join(process.env.XDG_RUNTIME_DIR, "systemd"));
}

// The same hash engine/main.js reports, from the engine's files on disk.
export async function engineVersion() {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const name of ["engine.js", "main.js"]) hasher.update(await Bun.file(new URL(`../engine/${name}`, import.meta.url)).arrayBuffer());
  return hasher.digest("hex");
}

interface State { ready: boolean; signIn: boolean; playback?: Playback; version?: string }
interface Queue { position: number; items: { id: string; type: string; added: boolean; attributes: { name?: string; artistName?: string; albumName?: string; durationInMillis?: number } }[] }

// The SSH helper sets PEEL_REMOTE_HOST. Its requests, and an engine it starts, mark it as a remote
// controller, so the engine pauses when the last Peel on this computer closes.
export const remoteOwner = (): Record<string, string> => process.env.PEEL_REMOTE_HOST === "1" ? { "x-peel-remote": "1" } : {};
export const ownerRole = (): Record<string, string> => process.env.PEEL_REMOTE_HOST === "1" ? { PEEL_OWNER_REMOTE: "1" } : {};

export type EngineTransport = (path: string, body?: unknown) => Promise<any>;

export class Engine implements Player {
  private access?: { port: number; key: string };

  constructor(private home = engineHome, private transport?: EngineTransport) {}

  private async read() {
    try { this.access = JSON.parse(await readFile(join(this.home, "key.json"), "utf8")); } catch { this.access = undefined; }
    return this.access;
  }

  // A restarted engine has a new key, so a rejected key is read again once.
  async send(path: string, body?: unknown, retry = true): Promise<any> {
    if (this.transport) return this.transport(path, body);
    const access = this.access ?? await this.read();
    if (!access) throw new Error("Peel's playback engine is not running.");
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${access.port}${path}`, {
        method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "x-peel-key": access.key, "x-peel-owner": String(process.pid), ...remoteOwner(), "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
      });
    } catch { this.access = undefined; throw new Error("Peel's playback engine is not running."); }
    if (response.status === 403 && retry) { await this.read(); return this.send(path, body, false); }
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error ?? `The playback engine returned HTTP ${response.status}.`);
    return value;
  }

  private call(method: string, ...args: unknown[]) { return this.send("/call", { method, args }); }
  // Whether the player that answered last plays Apple's lossless stream. The hi-res host says so
  // in its state, whether it runs on this computer, a paired device, or an SSH host. Apple Music's
  // Android app then chooses the quality, and Peel's AAC setting does not apply.
  lossless = false;
  async state(): Promise<State> {
    const state: State = await this.send("/state");
    this.lossless = state?.version === "hires";
    return state;
  }
  async quit() { await this.send("/quit", {}, false); }
  async release() { await this.send("/release", {}, false); }

  async snapshot(): Promise<Playback> {
    const state = await this.state();
    if (state.playback && state.ready) return state.playback;
    throw new Error(state.signIn ? "Sign in to Apple Music in the window that opened." : "The playback engine is starting.");
  }

  appleTokens(): Promise<{ userToken: string; storefront?: string }> { return this.call("tokens"); }
  async setQuality(quality: "high" | "standard") { if (!this.lossless) await this.call("quality", quality); }
  async rating(): Promise<number> { return await this.call("rating") ?? 0; }

  // The songs the listener added that have not played yet. The rest of the playing collection is not listed.
  async queue(offset = 0): Promise<Page> {
    // Engines from before the added method answer with the whole queue instead.
    const page = await this.call("added", offset, 100).catch(() => undefined);
    if (page?.items) return {
      more: !!page.more, items: page.items.map((item: Queue["items"][number] & { queueIndex: number }) => ({
        id: item.id, type: item.type, name: item.attributes.name ?? "Untitled", artist: item.attributes.artistName ?? "",
        album: item.attributes.albumName ?? "", duration: (item.attributes.durationInMillis ?? 0) / 1000, queueIndex: item.queueIndex,
      })),
    };
    const queue: Queue = await this.call("queue");
    const added = queue.items.map((item, index) => ({ item, index })).filter(({ item }) => item.added);
    const items = added.slice(offset, offset + 100).map(({ item, index }) => ({
      id: item.id, type: item.type, name: item.attributes.name ?? "Untitled", artist: item.attributes.artistName ?? "",
      album: item.attributes.albumName ?? "", duration: (item.attributes.durationInMillis ?? 0) / 1000, queueIndex: index,
    }));
    return { items, more: offset + 100 < added.length };
  }
  async queuePosition() {
    const place = await this.call("position").catch(() => undefined);
    if (Number.isInteger(place?.position) && Number.isInteger(place?.total)) return place as { position: number; total: number };
    const queue: Queue = await this.call("queue");
    return { position: queue.position, total: queue.items.length };
  }

  async playItem(item: Media) { await this.call("play", [item], 0); }
  // The engine queues the whole collection as loaded, so Next and Previous follow the displayed order.
  async playCollectionTrack(_collection: { id: string; type: string }, items: Media[], index: number) {
    await this.call("play", items.filter(item => !/albums|artists|playlists/.test(item.type)), index);
  }

  async enqueue(items: Media[], next: boolean) {
    await this.call("enqueue", items.filter(item => !/albums|artists|playlists/.test(item.type)), next);
  }

  // Peel's controls send these command paths. The engine has a method for each.
  async command(path: string, body: any = {}, method = "POST") {
    const commands: Record<string, () => Promise<unknown>> = {
      "/playback/pause": () => this.call("pause"),
      "/playback/play": () => this.call("resume"),
      "/playback/toggle": () => this.call("toggle"),
      "/playback/next": () => this.call("next"),
      "/playback/previous": () => this.call("previous"),
      "/playback/seek": () => this.call("seek", body.position),
      "/audio/volume": () => this.call("volume", body.volume),
      "/playback/shuffle": () => this.call("shuffle", body.enabled),
      "/playback/shuffle/toggle": () => this.call("toggleShuffle"),
      "/playback/repeat/toggle": () => this.call("toggleRepeat"),
      "/queue/jump": () => this.call("jump", body.index, ...(body.id ? [body.id] : [])),
      "/queue/move": () => this.call("move", body.from, body.to, ...(body.id ? [body.id, body.targetId] : [])),
      "/library/now-playing/rating": () => this.call("rate", method === "DELETE" ? 0 : body.rating, ...(body.id ? [body.id] : [])),
    };
    const removed = method === "DELETE" && path.match(/^\/queue\/items\/(\d+)$/);
    const run = removed ? () => this.call("remove", Number(removed[1]), ...(body.id ? [body.id] : [])) : commands[path];
    if (!run) throw new Error(`The playback engine has no command for ${path}.`);
    await run();
  }
}

// Asks a running engine to quit and waits until it has.
async function quitEngine(engine: Engine) {
  if (systemdSession()) {
    Bun.spawnSync(["systemctl", "--user", "stop", "peel-engine.service"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  await engine.quit().catch(() => {});
  const until = Date.now() + 10000;
  while (Date.now() < until && await engine.state().then(() => true, () => false)) await sleep(250);
}

// For a detached engine, failed settles with a message if it fails to start or exits.
async function launchEngine(): Promise<{ failed: Promise<string> } | undefined> {
  const environment: Record<string, string> = { PEEL_ENGINE_HOME: engineHome, PEEL_CACHE_DIR: cacheDir, PEEL_OWNER: String(process.pid), ...ownerRole() };
  const args = [electronPath, engineDir, ...electronArgs()];
  if (systemdSession()) {
    const settings = Object.entries(environment).map(([name, value]) => `--setenv=${name}=${value}`);
    for (const name of ["WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[name]) settings.push(`--setenv=${name}=${process.env[name]}`);
    // KillMode=mixed sends SIGTERM to Electron's main process only. When Chromium's helper
    // processes get it too, they exit first and Electron crashes with a core dump.
    const child = Bun.spawn(["systemd-run", "--user", "--collect", "--unit=peel-engine", "--slice=app-peel.slice", "--property=KillMode=mixed", ...settings, "--", ...args], { stdout: "ignore", stderr: "pipe" });
    if (await child.exited !== 0) {
      const active = Bun.spawn(["systemctl", "--user", "is-active", "--quiet", "peel-engine.service"]);
      if (await active.exited !== 0) throw new Error(`Could not start the playback engine: ${(await new Response(child.stderr).text()).trim()}`);
    }
    return;
  }
  await mkdir(engineHome, { recursive: true, mode: 0o700 });
  const logPath = join(engineHome, "engine.log");
  const log = openSync(logPath, "a");
  try {
    // A detached process gets its own session on Linux and macOS, and no console window on Windows.
    const child = spawn(args[0]!, args.slice(1), { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: engineEnvironment() });
    child.unref();
    return { failed: new Promise(resolve => {
      child.once("error", error => resolve(`Could not start the playback engine: ${error.message}`));
      child.once("exit", code => resolve(`The playback engine exited with code ${code} while starting. Its log is ${logPath}.`));
    }) };
  } finally { closeSync(log); }
}

// Starts the engine in the background when it is not running. Peel's first launch also
// downloads castlabs' Electron, and a first sign-in waits for the listener.
export async function ensureEngine(engine: Engine, status: (text: string) => void = () => {}, signal?: AbortSignal) {
  const state = () => engine.state().catch(() => undefined);
  let current = await state();
  // An engine started before Peel's files were updated keeps running the old code until it restarts.
  if (current && current.version !== await engineVersion()) {
    status("Restarting the playback engine to load an update...");
    await quitEngine(engine);
    current = await state();
  }
  let failure: string | undefined;
  if (!current) {
    signal?.throwIfAborted();
    await installEngine(status);
    signal?.throwIfAborted();
    status("Starting the playback engine...");
    void (await launchEngine())?.failed.then(message => { failure = message; });
  }
  // A first sign-in can take a few minutes.
  const until = Date.now() + 5 * 60 * 1000;
  while (!current?.ready && Date.now() < until) {
    if (current?.signIn) status("Sign in to Apple Music in the window that opened.");
    await sleep(250, undefined, { signal });
    if (failure) throw new Error(failure);
    current = await state();
  }
  if (!current?.ready) throw new Error(`The playback engine did not become ready. Run bun run engine in ${fileURLToPath(new URL("..", import.meta.url))} to see why.`);
}

// Releases the engine when Peel closes. The engine quits, and the music stops, once no other
// Peel still uses it. It also quits within a second once every Peel that used it has exited,
// which covers a terminal closed before the release arrives. Stopping the systemd unit here
// would stop the music for every other Peel too.
export function stopEngine(engine: Engine) {
  void engine.release().catch(() => {});
}

// bun run engine installs the engine and runs it in this terminal, with its log visible.
if (import.meta.main) {
  await installEngine(console.log);
  const child = Bun.spawn([electronPath, engineDir, ...electronArgs(), ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"], env: engineEnvironment(),
  });
  process.exitCode = await child.exited;
}
