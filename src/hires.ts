// Hi-res playback: Apple Music's Android app in Peel's slimmed Waydroid (hires/) plays the music,
// so Apple's ALAC reaches PipeWire unchanged, up to 24-bit/192 kHz. Peel controls it through a
// small host process that speaks the playback engine's protocol, so the interface, remote control
// and moving music between devices work as they do with the web engine.
//
// The host reaches Apple Music through the controller that `peel-hires controller` starts inside
// Android (hires/android/control/Control.java). Apple Music owns the queue. The host mirrors its
// order to tell the songs Peel added from the rest of the collection, as the web engine does.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppleMusic } from "./apple";
import { compareBuilds, hiresBuild, type HostBuild } from "./build";
import { cacheDir, configDir, readAppleSignIn, systemDir } from "./config";
import { Engine, ownerRole, systemdSession } from "./engine";
import { media, type Media, type Playback } from "./types";

export const hiresHome = process.env.PEEL_HIRES_HOME ?? join(systemDir("config"), "peel-hires-host");
const hiresPort = Number(process.env.PEEL_HIRES_PORT ?? 10769);

// Peel's own copy of peel-hires, so the controller always matches this version of Peel. The
// pipeline counts as installed once its root helper is (hires/install.sh).
const bundled = fileURLToPath(new URL("../hires/bin/peel-hires", import.meta.url));
export function hiresCommand(): string[] | undefined {
  if (process.env.PEEL_HIRES_COMMAND) return [process.env.PEEL_HIRES_COMMAND];
  if (process.platform !== "linux" || !existsSync("/usr/local/libexec/peel-hires/peel-hires-root")) return undefined;
  if (existsSync(bundled)) return ["bash", bundled];
  const installed = Bun.which("peel-hires") ?? join(homedir(), ".local/bin/peel-hires");
  return existsSync(installed) ? [installed] : undefined;
}

// Setup is complete once a release has passed the full tests: `peel-hires update` then records it
// in its state folder. Until then the pipeline may be installed but cannot play yet.
export function hiresSetUp() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
  return existsSync(join(state, "peel-hires", "seen"));
}

// Hi-res plays wherever the hi-res pipeline is installed and set up, unless PEEL_PLAYER chooses
// another player.
export function hiresSelected() {
  const choice = process.env.PEEL_PLAYER;
  if (choice === "hires") return true;
  if (choice && choice !== "auto") return false;
  return !!hiresCommand() && hiresSetUp();
}

// The web engine's client, pointed at the hi-res host.
export class Hires extends Engine {
  constructor() { super(hiresHome); }
  // The host has no Apple sign-in of its own. index.ts renews it through the web engine.
  async appleTokens(): Promise<{ userToken: string; storefront?: string }> { throw new Error("The hi-res player has no Apple sign-in."); }
}

// How ensureHires treats a host of another build. The SSH helper passes remote. Tests also pass
// the caller's build, a stand-in for starting a host, and one for telling whether a host runs.
export interface HiresStart {
  remote?: boolean;
  build?: HostBuild;
  launch?: () => Promise<void>;
  watch?: () => Promise<() => Promise<boolean>>;
}

// How many times one call restarts an older host. A host that another Peel starts meanwhile
// can run older code again, which is restarted too, up to this many times.
const maxRestarts = 3;

// Starts the host when it is not running and waits until Android and Apple Music answer. Android
// runs only while a Peel uses it, so this usually boots it, which takes about 7 seconds.
export async function ensureHires(engine: Engine, status: (text: string) => void = () => {}, signal?: AbortSignal, start: HiresStart = {}) {
  const mine = start.build ?? hostBuild(), remote = !!start.remote;
  const state = () => engine.state().catch(() => undefined);
  // The hosts this call asked to quit. One may still answer once while it exits, and only a host
  // that runs now counts.
  const replaced = new Set<string>();
  const live = (value: Awaited<ReturnType<typeof state>>) => value && !(value.instance && replaced.has(value.instance)) ? value : undefined;
  let current = await state();
  for (let restarts = 0; ; restarts++) {
    // A host started before Peel updated itself keeps running the old code, while the interface
    // runs the new one. Restarting it also restarts Android, as when the last Peel closes.
    if (current && outdated(current, mine, remote)) {
      if (restarts >= maxRestarts) throw new Error(`Hi-res playback still runs code older than this Peel after ${maxRestarts} restarts. A Peel window of an older version starts it again. Close that window or restart it into the update.`);
      signal?.throwIfAborted();
      status("Restarting hi-res playback to load an update...");
      const running = await (start.watch ?? watchHost)();
      if (current.instance) replaced.add(current.instance);
      await engine.quit().catch(() => {});
      // The old host pauses and stops Android before it exits, which can take a while. Its /state
      // waits for Android meanwhile, so its port and key tell whether it still runs.
      for (const until = Date.now() + 3 * 60 * 1000; await running();) {
        if (Date.now() >= until) throw new Error("The hi-res player from before the update did not stop. Run peel-hires status to see why.");
        await sleep(250, undefined, { signal });
      }
      // Another Peel may have started a host meanwhile.
      current = await state();
    }
    current = live(current);
    if (!current) {
      signal?.throwIfAborted();
      status("Starting hi-res playback...");
      // When another Peel started a host meanwhile, this returns once that host answers.
      await (start.launch ?? launchHost)();
    }
    const until = Date.now() + 3 * 60 * 1000;
    // The host that answers may be one that another Peel started from older code, while this
    // Peel restarted or started the host. It is restarted as well.
    const older = () => !!current && outdated(current, mine, remote);
    while (!current?.ready && !older() && Date.now() < until) {
      if (current?.playback?.error) status(current.playback.error);
      await sleep(250, undefined, { signal });
      current = live(await state());
    }
    if (older()) continue;
    if (!current?.ready) throw new Error(current?.playback?.error ?? "Hi-res playback did not start. Run peel-hires status to see why.");
    return;
  }
}

// Whether a Peel of build mine restarts the host it found. A host is restarted only when it is
// older than the Peel, so a window that still runs an older version after an update leaves the
// newer host alone, and two windows of different versions restart it at most once between them.
// A host from before hosts reported their build is older than any build that compares.
// The SSH helper runs the newest installed version, which a window on this computer may not have
// restarted into yet, so it never restarts a host that another Peel uses or that is playing.
// A host that does not say how many Peels use it counts as used.
export function outdated(host: { build?: HostBuild; others?: number; playback?: { state?: string } }, mine: HostBuild, remote = false) {
  if (host.build?.hash === mine.hash) return false;
  if (host.build && compareBuilds(host.build, mine) >= 0) return false;
  if (remote && (host.others !== 0 || host.playback?.state === "playing")) return false;
  return true;
}

// The build of the code this Peel would start a host from, read once.
let ownBuild: HostBuild | undefined;
export function hostBuild(): HostBuild {
  if (!ownBuild) {
    const { hash, version, time } = hiresBuild(fileURLToPath(new URL("..", import.meta.url)));
    ownBuild = { hash, version, time };
  }
  return ownBuild;
}

// A TCP connection reaches a running host even while its requests wait for Android.
async function listening(port: number) {
  try {
    const socket = await Promise.race([
      Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }),
      sleep(2000).then(() => { throw new Error("timeout"); }),
    ]);
    socket.end();
    return true;
  } catch { return false; }
}

// Returns a test for whether the host that runs now still runs: its port answers and key.json
// still holds its key. A host that another Peel starts afterwards writes a new key. The port is
// the one in key.json, where the host wrote the port it listens on. Without a key file it is the
// port this Peel uses. Tests pass another folder and port.
export async function watchHost(home = hiresHome, port = hiresPort) {
  const hostKey = async () => { try { return JSON.parse(await Bun.file(join(home, "key.json")).text()) as { port?: number; key?: string }; } catch { return undefined; } };
  const before = await hostKey(), at = Number(before?.port) || port;
  return async () => (!before || (await hostKey())?.key === before.key) && await listening(at);
}

// How long Peel waits for systemd to remove the unit of a host that exited.
const unitWait = Number(process.env.PEEL_HIRES_UNIT_WAIT) || 15000;
const unitLoaded = async () => {
  const show = Bun.spawn(["systemctl", "--user", "show", "--property=LoadState", "--value", "peel-hires-host.service"], { stdout: "pipe", stderr: "ignore" });
  const [output] = await Promise.all([new Response(show.stdout).text(), show.exited]);
  return output.trim() === "loaded";
};

async function launchHost() {
  // The host runs this file alone, without the interface's modules, in Bun's low-memory mode.
  const args = [process.execPath, "--smol", fileURLToPath(import.meta.url), "--hires-host"];
  // The host uses the folders this Peel resolved, so it writes its key where this Peel reads it.
  // systemd's user manager has its own environment and would otherwise use its defaults.
  const environment: Record<string, string> = { PEEL_OWNER: String(process.pid), ...ownerRole(), PEEL_HIRES_HOME: hiresHome, PEEL_CONFIG_DIR: configDir, PEEL_CACHE_DIR: cacheDir };
  if (systemdSession()) {
    const settings = Object.entries(environment).map(([name, value]) => `--setenv=${name}=${value}`);
    // peel-hires reads the XDG folders for its own cache, state and settings.
    for (const name of ["PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "PEEL_HIRES_PORT", "PEEL_HIRES_COMMAND", "APPLE_MUSIC_API_BASE"]) if (process.env[name]) settings.push(`--setenv=${name}=${process.env[name]}`);
    // systemd-run fails while a unit of the same name exists. That is a host another Peel just
    // started, which answers on the port soon, or one that exited and that systemd has not
    // removed yet, which goes away within moments. A unit that stays without a host answering
    // is an error, so Peel does not wait minutes for a host that never starts.
    for (let until = Date.now() + unitWait, retried = false; ;) {
      const child = Bun.spawn(["systemd-run", "--user", "--collect", "--unit=peel-hires-host", "--slice=app-peel.slice", ...settings, "--", ...args], { stdout: "ignore", stderr: "pipe" });
      if (await child.exited === 0) return;
      const failure = (await new Response(child.stderr).text()).trim();
      if (!await unitLoaded()) {
        // The unit may have gone between the attempt and the check. Another failure has another cause.
        if (retried) throw new Error(`Could not start hi-res playback: ${failure}`);
        retried = true;
        continue;
      }
      if (await listening(hiresPort)) return;
      if (Date.now() >= until) throw new Error(`Could not start hi-res playback: the service peel-hires-host from an earlier hi-res player is still there and no player answers. Run systemctl --user status peel-hires-host to see why. ${failure}`);
      await sleep(500);
    }
  }
  await mkdir(hiresHome, { recursive: true, mode: 0o700 });
  const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: "ignore", env: { ...process.env, ...environment } });
  child.unref();
}

// ---- The host ----------------------------------------------------------------------------------

// Apple Music's media session state codes.
const STOPPED = 1, PAUSED = 2, PLAYING = 3, BUFFERING = 6, CONNECTING = 8;
// Paused, stopped, or with nothing to play (0).
const stopped = (state: { state?: number }) => state.state === PAUSED || state.state === STOPPED || state.state === 0;
const repeats = ["none", "one", "all"] as const;

interface Control { state?: number; position?: number; item?: number; title?: string; artist?: string; album?: string; id?: string; duration?: number; error?: string }
interface Entry { queueId: number; song: Media; added: boolean; unknown?: boolean }
interface Listed { song: Media; added: boolean; at: number }

// Apple Music's Android app ignores a new queue of more than about 500 songs (#96), and its queue
// answer lists only the playing entry and the next 100. A longer list goes to Apple as a window
// around the chosen song, with windowBefore songs before it, and the host adds the rest at the end
// of Apple's queue in parts of partSize once fewer than partAt songs are left.
const windowSize = Number(process.env.PEEL_HIRES_WINDOW) || 500;
const windowBefore = Math.floor(windowSize / 5), partSize = windowSize - windowBefore, partAt = Math.ceil(windowSize / 8);
// Apple numbers each batch of songs it queues. An entry's ID is its batch times 2^32 plus its index.
const batchOf = (id: number) => Math.floor(id / 2 ** 32);

// A command that changes the queue or the playing song, sent when the connection closed or the
// controller did not answer. Android may or may not have applied it, so it is not sent again: the
// caller reads Apple Music's state to see whether it took effect.
export class Uncertain extends Error {}
// Commands that set a value, or only read, have the same effect when Android receives them twice.
const repeatable = new Set(["ping", "state", "queue", "volume", "repeat", "shuffle", "autoplay", "seek", "pause", "stop", "play", "skip", "restart"]);

// One line-based connection to the controller in Android. Requests go one at a time.
class Controller {
  private socket?: Awaited<ReturnType<typeof Bun.connect>>;
  private waiting: ((line: string) => void)[] = [];
  // Bytes become text only as whole lines, so a character split between packets stays whole.
  private buffer = Buffer.alloc(0);
  // Each connection's events count only while it is the current one.
  private generation = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private access?: { host: string; port: number; key: string };
  error?: string;

  // Starts Android and the controller through peel-hires when the controller does not answer.
  private async connect() {
    if (this.socket) return;
    const command = hiresCommand();
    if (!command) throw new Error("peel-hires is not installed.");
    const run = Bun.spawn([...command, "controller"], { stdout: "pipe", stderr: "pipe" });
    const [output, failure, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(failure.trim().split("\n").pop()?.replace(/^peel-hires: /, "") || "peel-hires controller failed.");
    this.access = JSON.parse(output.trim().split("\n").pop()!);
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.buffer = Buffer.alloc(0);
    this.socket = await Bun.connect({
      hostname: this.access!.host, port: this.access!.port,
      socket: {
        data: (_socket, data) => {
          if (!current()) return;
          this.buffer = Buffer.concat([this.buffer, data]);
          let end;
          while ((end = this.buffer.indexOf(10)) >= 0) {
            const line = this.buffer.subarray(0, end).toString("utf8");
            this.buffer = this.buffer.subarray(end + 1);
            this.waiting.shift()?.(line);
          }
        },
        close: () => { if (current()) this.drop(); },
        error: () => { if (current()) this.drop(); },
      },
    });
  }

  private drop() {
    this.socket = undefined; this.buffer = Buffer.alloc(0); this.generation++;
    for (const resolve of this.waiting.splice(0)) resolve('{"error":"closed"}');
  }

  // Sends one command and returns the controller's answer. A lost connection is made once more
  // for a command that is safe to repeat. Any other command throws Uncertain instead.
  request(command: string): Promise<any> {
    const safe = repeatable.has(command.split(" ")[0]!);
    const uncertain = () => new Uncertain(`Apple Music may not have received "${command.split(" ")[0]}".`);
    const run = async (retry: boolean): Promise<any> => {
      await this.connect();
      const answer = await new Promise<string>((resolve, reject) => {
        this.waiting.push(resolve);
        this.socket!.write(`${this.access!.key} ${command}\n`);
        setTimeout(() => reject(safe ? new Error("Apple Music did not answer.") : uncertain()), 10000).unref();
      }).catch(error => { this.socket?.end(); this.drop(); throw error; });
      const value = JSON.parse(answer);
      if (value?.error === "closed" && !safe) throw uncertain();
      if (value?.error === "closed" && retry) return run(false);
      if (value?.error === "no-session" && retry) {
        // Apple Music's playback service is not running. A pause key starts it without playing.
        Bun.spawnSync(["adb", "-s", `${this.access!.host}:5555`, "shell", "cmd", "media_session", "dispatch", "pause"], { stdout: "ignore", stderr: "ignore" });
        await sleep(1500);
        return run(false);
      }
      if (value?.error) throw new Error(value.error === "no-session" ? "Apple Music's player is not running." : value.error);
      return value;
    };
    const result = this.chain.catch(() => {}).then(() => run(true));
    this.chain = result;
    return result;
  }

  // Runs task between requests: after those sent before it, and before any sent while it runs.
  // The task may stop Android, so the connection is dropped after it and the next request starts
  // Android again.
  exclusive(task: () => Promise<void>): Promise<void> {
    const result = this.chain.catch(() => {}).then(task).finally(() => { this.socket?.end(); this.drop(); });
    this.chain = result;
    return result;
  }
}

function catalogOf(song: Media) {
  return song.catalogId ?? (/^\d+$/.test(song.id) ? song.id : undefined);
}

// What the host shows for a queued entry, in the shape the web engine uses.
const describe = (song: Media) => ({ id: song.id, type: song.type, attributes: { name: song.name, artistName: song.artist, albumName: song.album, durationInMillis: Math.round(song.duration * 1000) } });

export async function runHiresHost() {
  const control = new Controller();
  const signIn = await readAppleSignIn();
  // A rejected sign-in is read again from Peel's settings, which the interface renews.
  const apple = new AppleMusic(signIn.userToken, { storefront: signIn.storefront, renewUser: async () => (await readAppleSignIn()).userToken || undefined });
  const instance = crypto.randomUUID();
  // version says this is the hi-res host. build says which code it runs (src/build.ts).
  const version = "hires", build = hostBuild();
  let volume = (() => { try { return JSON.parse(readFileSync(join(hiresHome, "volume.json"), "utf8")).volume ?? 1; } catch { return 1; } })();
  let repeat = 0, shuffle = false;
  // The whole queue in Apple Music's order, history included, and Peel's song for each entry.
  let order: number[] = [];
  const entries = new Map<number, Entry>();
  // The batches the host queued as a list or as a later part, by batch number, so entries Apple
  // does not list still have their song. removed holds the sent entries the listener took out.
  const sent = new Map<number, { song: Media; added: boolean }[]>();
  const removed = new Set<number>();
  // The songs of a long list that Apple has not been sent yet, in play order.
  let rest: Listed[] = [];
  let current: Control = {};
  let wanted = false;
  let rated = { id: "", value: undefined as number | undefined, checked: 0 };
  let notice: string | undefined;
  let ready = false;

  async function writeJson(name: string, value: unknown) {
    await mkdir(hiresHome, { recursive: true, mode: 0o700 });
    const file = join(hiresHome, name), temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  }

  // Reads Apple's upcoming queue, and keeps the history before the playing entry.
  async function sync() {
    const queue: { queueId: number; id: string; title: string }[] = (await control.request("queue")).queue ?? [];
    // An empty queue means Apple has nothing queued any more, so Peel's mirror empties too. Songs
    // of a long list not sent yet stay, so the list continues.
    if (!queue.length) { order = []; entries.clear(); sent.clear(); removed.clear(); synced = Date.now(); return; }
    // The entries before the playing one are history, also those Apple skipped before listing them.
    for (const item of queue) align(item);
    const before = [...order, ...hidden()], playing = queue[0]!.queueId, at = before.indexOf(playing);
    order = [...(at >= 0 ? before.slice(0, at) : []), ...queue.map(item => item.queueId)];
    for (const item of queue) {
      if (entries.has(item.queueId)) continue;
      const queued = sent.get(batchOf(item.queueId))?.[item.queueId % 2 ** 32];
      entries.set(item.queueId, queued ? { queueId: item.queueId, ...queued }
        : { queueId: item.queueId, added: false, unknown: true, song: { id: item.id, type: "songs", name: item.title, artist: "", album: "", duration: 0, catalogId: item.id } });
    }
    // Songs of queues that were replaced are forgotten.
    const kept = new Set(order);
    for (const id of entries.keys()) if (!kept.has(id)) entries.delete(id);
    synced = Date.now();
  }
  let synced = 0;

  // Apple's entry holds another song than the host sent at its place when Apple dropped songs it
  // cannot play, which moves the later ones up. The dropped songs come out of the sent batch up to
  // the next one with Apple's song, so later places match again. Their entries are made anew.
  function align(item: { queueId: number; id: string }) {
    const batch = batchOf(item.queueId), index = item.queueId % 2 ** 32, songs = sent.get(batch);
    if (!songs || !item.id || index >= songs.length || catalogOf(songs[index]!.song) === item.id) return;
    const found = songs.findIndex((entry, at) => at > index && catalogOf(entry.song) === item.id);
    if (found < 0) return;
    const dropped = found - index;
    songs.splice(index, dropped);
    for (const key of [...entries.keys()]) if (batchOf(key) === batch && key % 2 ** 32 >= index) entries.delete(key);
    for (const key of [...removed]) {
      if (batchOf(key) !== batch || key % 2 ** 32 < index) continue;
      removed.delete(key);
      if (key % 2 ** 32 >= found) removed.add(key - dropped);
    }
  }

  // Reads Apple's queue until it shows a change, after an edit Apple applies a moment later.
  async function syncUntil(done: () => boolean, failure: string) {
    for (const end = Date.now() + 3000; ; await sleep(40)) {
      await sync();
      if (done()) return;
      if (Date.now() > end) throw new Error(failure);
    }
  }

  // Reads what plays. When the playing entry changed, Apple's queue is read again. A command that
  // runs keeps the queue to itself: the state Peel polls meanwhile does not read it.
  async function read(resync = true) {
    const before = current.item;
    current = await control.request("state");
    // A changed queue Peel did not ask for, such as shuffle, shows within two seconds.
    if (resync && (current.item !== before || Date.now() - synced > 2000)) await sync();
    watchStall();
    watchSilence();
    if (rest.length && !extending && Date.now() >= extendAfter && upcoming() < partAt) {
      extending = true;
      void call("extend").catch(() => {}).finally(() => { extending = false; });
    }
    return current;
  }
  let busy = 0;

  // Apple Music sometimes stops renewing its stream lease. The song then stays buffering at one
  // place and never plays (#60). After stallLimit there, the host restarts Apple Music and
  // continues at the same song and position. If that stalls too, it pauses and says so. A song
  // that plays again allows the next recovery.
  const stallLimit = Number(process.env.PEEL_HIRES_STALL_MS) || 10000;
  let stall: { item?: number; position?: number; since: number } | undefined, recovered = false, recovering = false;
  function watchStall() {
    if (current.state === PLAYING) recovered = false;
    if (!wanted || recovering || current.state !== BUFFERING) { stall = undefined; return; }
    if (!stall || stall.item !== current.item || stall.position !== current.position) { stall = { item: current.item, position: current.position, since: Date.now() }; return; }
    if (Date.now() - stall.since < stallLimit) return;
    stall = undefined; recovering = true;
    const again = recovered;
    recovered = true;
    void call("recover", [again]).catch(() => {}).finally(() => { recovering = false; });
  }

  // Apple Music can report playing, with its position advancing, while every sample it sends is
  // zero (#94). Restarting Apple Music brings the sound back. While a song plays, the host records
  // half a second of Android's stream from PipeWire every few seconds. When every sample stays zero
  // for silenceLimit, the host restarts Apple Music and continues, as after a stall. A second
  // silence within a minute only says so, since a song can also be silent on purpose, and the host
  // checks that song no more. It never checks at volume 0, or near the start or end of a song.
  // Android's own mixer underrun count is no sign: it climbs by about 40 a second in normal playback.
  const silenceLimit = Number(process.env.PEEL_HIRES_SILENCE_MS) || 10000;
  const checkEvery = Math.min(5000, silenceLimit / 2);
  let silentSince: number | undefined, listened = 0, listening = false, silenced = 0, quiet: number | undefined;
  function watchSilence() {
    const duration = current.duration ?? 0, at = current.position ?? 0;
    const playing = wanted && !recovering && current.state === PLAYING && volume > 0 && !muted && current.item !== quiet && at >= 3000 && (!duration || at <= duration - 3000);
    if (!playing) { silentSince = undefined; return; }
    if (listening || Date.now() - listened < checkEvery) return;
    listening = true;
    const item = current.item;
    void allZero().then(zero => {
      listened = Date.now();
      if (zero !== true || current.item !== item || current.state !== PLAYING || !wanted || recovering) { silentSince = undefined; return; }
      silentSince ??= listened;
      if (listened - silentSince < silenceLimit) return;
      silentSince = undefined;
      if (listened - silenced < 60000) {
        quiet = item;
        notice = "Android's audio is silent, also after a restart of Apple Music. Quit Peel and open it again to restart Android.";
        return;
      }
      silenced = listened; recovering = true;
      void call("recover", [false]).catch(() => {}).finally(() => { recovering = false; });
    }).catch(() => {}).finally(() => { listening = false; });
  }
  // Records half a second of each of Android's playing streams at its own rate, so the recording
  // doesn't change PipeWire's rate. Answers whether every sample was zero, or undefined when it
  // can't tell, for example without PulseAudio's tools or with a stream muted on the computer.
  async function allZero(): Promise<boolean | undefined> {
    if (!Bun.which("pactl") || !Bun.which("pacat")) return undefined;
    const list = Bun.spawn(["pactl", "-f", "json", "list", "sink-inputs"], { stdout: "pipe", stderr: "ignore" });
    let streams: { index: number; corked?: boolean; mute?: boolean; volume?: Record<string, { value?: number }>; sample_specification?: string; properties?: Record<string, string> }[];
    try { streams = JSON.parse(await new Response(list.stdout).text()); } catch { return undefined; }
    streams = streams.filter(stream => stream.properties?.["application.name"] === "Waydroid" && !stream.corked);
    if (!streams.length) return undefined;
    for (const stream of streams) {
      const levels = Object.values(stream.volume ?? {}).map(channel => channel.value ?? 1);
      if (stream.mute || levels.length && levels.every(level => level === 0)) return undefined;
      const rate = Number(/(\d+)Hz/.exec(stream.sample_specification ?? "")?.[1]) || 48000;
      // pacat's usual latency holds back the first second or two, so it would record nothing.
      const record = Bun.spawn(["pacat", "--record", "--raw", `--monitor-stream=${stream.index}`, "--latency-msec=50", "--format=float32le", `--rate=${rate}`, "--channels=2"], { stdout: "pipe", stderr: "ignore" });
      setTimeout(() => record.kill(), 600).unref();
      const bytes = await new Response(record.stdout).arrayBuffer();
      const samples = new Float32Array(bytes, 0, Math.floor(bytes.byteLength / 4));
      if (samples.length < rate / 10) return undefined;
      if (samples.some(sample => sample !== 0)) return false;
    }
    return true;
  }

  // Apple Music applies commands a moment later. Waits until its state shows the change, for up
  // to `within` milliseconds, so the state Peel reads next is already the new one.
  async function until(done: (state: Control) => boolean, within = 3000) {
    for (const end = Date.now() + within; ; await sleep(40)) {
      await read();
      if (done(current)) return true;
      if (Date.now() > end) return false;
    }
  }

  // Waits until Apple Music plays the first song of a new queue: a new, valid entry at the start
  // index of its batch, or the requested song. Android reports -1 while it has no entry.
  async function settle(previous: number | undefined, start: number, id: string) {
    const started = (state: Control) => state.item !== undefined && state.item >= 0 && state.item !== previous && (state.id === id || state.item % 2 ** 32 === start);
    if (!await until(started, 8000)) throw new Error("Apple Music did not start the song.");
  }

  // Runs a command that changes the playing entry or position, and waits for it to show. A
  // change Apple never makes is an error, so a device that moves the music away knows.
  async function step(command: string, done: (state: Control, before: Control) => boolean, failure = "Apple Music did not respond. Try again.") {
    await read().catch(() => {});
    const before = { ...current };
    await control.request(command).catch(unless);
    if (!await until(state => done(state, before))) throw new Error(failure);
  }
  // A command whose answer was lost may still have worked. The check that follows it decides.
  function unless(error: unknown) { if (!(error instanceof Uncertain)) throw error; }

  // A song only in the listener's library, such as one Apple took out of its catalog, has no
  // catalog ID, and Apple Music's Android app plays catalog songs. The catalog often still has
  // the same recording under another ID. A match needs the same title and artist, a length within
  // two seconds, and, when several remain, the same album; otherwise the song is left out. Found
  // and confirmed-missing answers are kept for the host's life. A failed search, such as one
  // Apple refused for too many requests, is asked again next time. At most four run at once.
  const matches = new Map<string, string | null>();
  const normal = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s*[([](feat|with|remaster|bonus)[^)\]]*[)\]]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const sameArtist = (library: string, catalog: string) => {
    const a = normal(library), b = normal(catalog);
    return a.length >= 2 && b.length >= 2 && (a === b || ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `));
  };
  let searching = 0, searchAfter = 0;
  const waiting: (() => void)[] = [];
  async function match(song: Media): Promise<string | undefined> {
    if (matches.has(song.id)) return matches.get(song.id) ?? undefined;
    if (!normal(song.name) || !normal(song.artist)) return undefined;
    if (Date.now() < searchAfter) return undefined;
    while (searching >= 4) await new Promise<void>(resolve => waiting.push(resolve));
    searching++;
    try {
      const response = await apple.request(`v1/catalog/$STOREFRONT/search?types=songs&limit=25&term=${encodeURIComponent(`${song.name} ${song.artist}`.slice(0, 200))}`);
      // More results than one page means a match or a second candidate may be on the next one,
      // so the answer is neither kept nor trusted.
      if (response.results?.songs?.next) return undefined;
      let found: any[] = (response.results?.songs?.data ?? []).filter((item: any) => normal(item.attributes?.name ?? "") === normal(song.name)
        && sameArtist(song.artist, item.attributes?.artistName ?? "")
        && (!song.duration || Math.abs((item.attributes?.durationInMillis ?? 0) / 1000 - song.duration) <= 2));
      if (found.length > 1 && song.album) found = found.filter(item => normal(item.attributes?.albumName ?? "") === normal(song.album));
      const id = found.length === 1 ? String(found[0].id) : null;
      matches.set(song.id, id);
      return id ?? undefined;
    } catch {
      // Apple refuses searches for a while after many, so the host asks none for 30 seconds.
      searchAfter = Date.now() + 30000;
      return undefined;
    }
    finally { searching--; waiting.shift()?.(); }
  }
  // Songs to match while nothing waits on them, one every half second, so a later list has them.
  const unmatched: Media[] = [];
  let matching = false;
  function matchLater(songs: Media[]) {
    for (const song of songs) if (!matches.has(song.id) && !unmatched.some(other => other.id === song.id)) unmatched.push(song);
    if (matching || !unmatched.length) return;
    matching = true;
    void (async () => {
      try {
        while (unmatched.length) {
          if (Date.now() < searchAfter) { await sleep(searchAfter - Date.now()); continue; }
          await match(unmatched.shift()!);
          await sleep(500);
        }
      } finally { matching = false; }
    })();
  }
  // A library song can keep a catalog ID that Apple's catalog no longer has. Apple Music's Android
  // app then drops the song from a queue without a word, and every later song moves up one place,
  // so the host asks the catalog first, 300 IDs at a time, and keeps the answers for its life. A
  // song the catalog lost is matched like one that never had an ID. A failed request trusts the IDs.
  const inCatalog = new Map<string, boolean>();
  async function checkCatalog(ids: string[]) {
    const unknown = [...new Set(ids.filter(id => !inCatalog.has(id)))];
    await Promise.all(Array.from({ length: Math.ceil(unknown.length / 300) }, async (_, part) => {
      const asked = unknown.slice(part * 300, part * 300 + 300);
      try {
        const response = await apple.request(`v1/catalog/$STOREFRONT/songs?ids=${asked.join(",")}`);
        const found = new Set((response.data ?? []).filter((item: any) => item.attributes?.playParams).map((item: any) => String(item.id)));
        // The catalog has nearly every library song, so an answer with none of ten or more is a
        // refusal, which would leave a whole list out. It is trusted like a failed request.
        if (!found.size && asked.length >= 10) return;
        for (const id of asked) inCatalog.set(id, found.has(id));
      } catch {}
    }));
  }
  // A song that needs a match and that now says nothing waits on is left out this time and matched
  // later, so a long list starts without a search for each such song. A library song whose catalog
  // ID is gone often still plays under its second ID, which needs no search.
  async function playableSongs(songs: Media[], now: (at: number) => boolean = () => true) {
    await checkCatalog(songs.flatMap(song => [catalogOf(song), song.reportingId]).filter((id): id is string => !!id));
    const later: Media[] = [];
    const playable = await Promise.all(songs.map(async (song, at) => {
      const id = catalogOf(song);
      if (id && inCatalog.get(id) !== false) return song;
      if (song.reportingId && inCatalog.get(song.reportingId)) return { ...song, catalogId: song.reportingId };
      // An empty catalog ID marks a song with no playable match, so catalogOf leaves it out.
      if (!now(at) && !matches.has(song.id)) { later.push(song); return { ...song, catalogId: "" }; }
      return { ...song, catalogId: await match(song) ?? "" };
    }));
    matchLater(later);
    return playable;
  }

  // Replaces the queue with songs and plays the one at index. A song Apple's catalog lacks is left
  // out, and the next one plays instead. Returns the index in listed of the song that plays. Apple
  // gets at most windowSize songs, and the rest of a longer list waits in rest. Songs before the
  // window are left out, as if they had played before this queue.
  async function playList(listed: Media[], index: number, marks: Set<number> = new Set()) {
    const from = Math.max(0, Math.min(index - windowBefore, listed.length - windowSize)), to = from + windowSize;
    const songs = await playableSongs(listed.slice(from, to), at => from + at === index);
    let playable = songs.map((song, at) => ({ song, at: from + at, id: catalogOf(song) })).filter(entry => entry.id);
    if (!playable.length) {
      if (to < listed.length) return playList(listed, to, marks);
      throw new Error("Apple's catalog no longer has these songs, so hi-res cannot play them.");
    }
    let start = playable.findIndex(entry => entry.at >= index);
    if (start < 0) start = playable.length - 1;
    let previous = current.item;
    await control.request(`list ${start} ${playable.map(entry => entry.id).join(",")}`).catch(unless);
    await settle(previous, start, playable[start]!.id!);
    // Apple dropped a song before the chosen one that the catalog check let through, so its entry
    // at start is a later song. The list starts again at the chosen song, without the songs before.
    if (current.id && current.id !== playable[start]!.id) {
      playable = playable.slice(start); start = 0; previous = current.item;
      await control.request(`list 0 ${playable.map(entry => entry.id).join(",")}`).catch(unless);
      await settle(previous, 0, playable[0]!.id!);
    }
    // A new queue usually starts by itself, but not always after a pause.
    const running = (state: Control) => state.state === PLAYING || state.state === BUFFERING || state.state === CONNECTING;
    if (!running(current)) await step("play", running, "Apple Music did not start the song.");
    const base = current.item! - start;
    order = playable.map((_, at) => base + at);
    playable.forEach((entry, at) => entries.set(base + at, { queueId: base + at, song: entry.song, added: marks.has(entry.at) }));
    sent.clear(); removed.clear();
    sent.set(batchOf(base), playable.map(entry => ({ song: entry.song, added: marks.has(entry.at) })));
    rest = listed.slice(to).map((song, at) => ({ song, added: marks.has(to + at), at: to + at }));
    if (shuffle) mix(rest);
    extendAfter = 0; part = undefined;
    await sync();
    return playable[start]!.at;
  }

  // The songs Apple has queued after the playing one, also those its answer does not list yet.
  const upcoming = () => order.length - position() - 1 + hidden().length;
  // Entries the host sent that Apple's answer does not list, in the order they were sent: those
  // beyond its 101 entries, also ones an added song pushed back out of them.
  function hidden() {
    const listed = new Set(order), ids: number[] = [];
    for (const [batch, songs] of sent) songs.forEach((_, index) => { const id = batch * 2 ** 32 + index; if (!listed.has(id) && !removed.has(id)) ids.push(id); });
    return ids;
  }
  const mix = (list: Listed[]) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j]!, list[i]!]; } };

  // Sends the next part of rest to the end of Apple's queue. Apple names the part in a new batch,
  // found in its queue afterwards by its songs. A part Apple ignored is sent again after a while,
  // unless it shows up then. Apple's queue that ended meanwhile starts again with the rest.
  let extending = false, extendAfter = 0;
  let part: { after: number; songs: Listed[] } | undefined;
  async function extend() {
    if (!rest.length || upcoming() >= partAt || !order.length && !wanted) return;
    if (wanted && (!order.length || upcoming() === 0 && stopped(current))) {
      const list = rest;
      rest = [];
      await playList(list.map(entry => entry.song), 0, new Set(list.flatMap((entry, at) => entry.added ? [at] : [])));
      return;
    }
    const adopt = () => {
      if (!part) return false;
      const ids = part.songs.map(entry => catalogOf(entry.song));
      const batch = [...new Set(order.map(batchOf))].find(batch => batch > part!.after && !sent.has(batch) && (() => {
        const listed = order.filter(id => batchOf(id) === batch);
        const same = listed.filter(id => entries.get(id)?.song.catalogId === ids[id % 2 ** 32]).length;
        return same * 2 >= listed.length;
      })());
      if (batch === undefined) return false;
      sent.set(batch, part.songs.map(entry => ({ song: entry.song, added: entry.added })));
      for (const id of order) if (batchOf(id) === batch) entries.set(id, { queueId: id, ...sent.get(batch)![id % 2 ** 32]! });
      rest = rest.filter(entry => !part!.songs.includes(entry));
      part = undefined;
      return true;
    };
    await sync();
    if (adopt()) return;
    if (!part) {
      const next = rest.slice(0, partSize), songs = await playableSongs(next.map(entry => entry.song));
      const playable = next.map((entry, at) => ({ ...entry, song: songs[at]! })).filter(entry => catalogOf(entry.song));
      if (!playable.length) { rest = rest.slice(next.length); return; }
      // Songs left out of a part are gone from rest with it.
      rest = [...playable, ...rest.slice(next.length)];
      part = { after: Math.max(...sent.keys(), ...order.map(batchOf)), songs: playable };
    }
    await control.request(`add end ${part.songs.map(entry => catalogOf(entry.song)).join(",")}`).catch(unless);
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) {
      await sync();
      if (adopt()) return;
    }
    extendAfter = Date.now() + 30000;
  }

  // Adds songs after the playing one (next) or after the songs added before. Succeeds only once
  // Apple's queue shows every song, each matched to its own new entry.
  async function insert(songs: Media[], next: boolean) {
    const playable = (await playableSongs(songs)).filter(catalogOf);
    if (!playable.length) throw new Error(`Apple's catalog no longer has ${songs.length === 1 ? "this song" : "these songs"}, so hi-res cannot queue ${songs.length === 1 ? "it" : "them"}.`);
    const known = new Set(order);
    let target: number | undefined;
    if (!next) {
      const at = order.indexOf(current.item!);
      let last = at;
      while (last + 1 < order.length && entries.get(order[last + 1]!)?.added) last++;
      if (last > at) target = order[last];
    }
    await control.request(`add next ${playable.map(catalogOf).join(",")}`).catch(unless);
    // Apple names the inserted entries in a new batch. They are found in its queue afterwards.
    let fresh: number[] = [];
    for (const until = Date.now() + 5000; ; await sleep(100)) {
      await sync();
      // A song of the list that Apple lists only now, because the playing song changed, is not new.
      fresh = order.filter(id => !known.has(id) && !sent.has(batchOf(id)));
      if (fresh.length >= playable.length || Date.now() > until) break;
    }
    // Apple may name a song by an equivalent catalog ID. Exactly as many new entries as songs
    // pair in order. Otherwise each song needs a new entry with its own ID, and the rest of the
    // new entries, which another Peel may have added, keep the queue's own names.
    const reported = (id: number) => entries.get(id)?.song.catalogId;
    let pairs: [number, Media][] = [];
    if (fresh.length === playable.length) pairs = fresh.map((id, at) => [id, playable[at]!]);
    else {
      const free = [...fresh];
      for (const song of playable) {
        const at = free.findIndex(id => reported(id) === catalogOf(song));
        if (at >= 0) pairs.push([free.splice(at, 1)[0]!, song]);
      }
    }
    for (const [id, song] of pairs) entries.set(id, { queueId: id, song, added: true });
    if (pairs.length < playable.length) {
      throw new Error(pairs.length ? `Apple Music queued ${pairs.length} of ${playable.length} songs. Try again for the rest.`
        : `Apple Music did not queue ${playable.length === 1 ? "the song" : "the songs"}. Try again.`);
    }
    // Play later: the new songs move behind the songs added before them, in order.
    if (target !== undefined) {
      let after = target;
      for (const [id] of pairs) {
        const behind = after;
        await control.request(`move ${id} ${behind} 1`).catch(unless);
        await syncUntil(() => order.indexOf(id) === order.indexOf(behind) + 1, "Apple Music did not move the added songs.");
        after = id;
      }
    }
  }

  // Every entry in order has a song. One Apple added by itself and the host never saw gets a
  // placeholder until the next read of the queue.
  const known = (id: number) => entries.get(id) ?? sent.get(batchOf(id))?.[id % 2 ** 32];
  const songOf = (id: number): Media => known(id)?.song ?? { id: "", type: "songs", name: "", artist: "", album: "", duration: 0 };
  const position = () => Math.max(0, order.indexOf(current.item ?? -1));
  // The whole queue: Apple's entries the host knows, the sent entries Apple does not list yet,
  // and the songs not sent yet. Queue indexes count in this list.
  function whole() {
    const ids = [...order, ...hidden()];
    return [...ids.map(id => ({ id, song: songOf(id), added: !!known(id)?.added })), ...rest.map(entry => ({ id: undefined, song: entry.song, added: entry.added }))];
  }
  const songAt = (index: number) => index < order.length ? entries.get(order[index]!)?.song : whole()[index]?.song;
  const check = (index: number, expected?: string) => {
    if (expected && songAt(index)?.id !== expected) throw new Error("The queue changed in another Peel. Try again.");
  };

  function revision() {
    let hash = 0x811c9dc5;
    const add = (text: string) => { for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); } };
    add(String(position()));
    for (const id of order) add(`|${id}${entries.get(id)?.added ? "+" : ""}`);
    add(`|${hidden().length}|${rest.length}`);
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  // A library song is rated by its library ID, a catalog song by its catalog ID.
  const ratingPath = (song?: Media) => song?.id.startsWith("i.") ? `v1/me/ratings/library-songs/${song.id}` : song && catalogOf(song) ? `v1/me/ratings/songs/${catalogOf(song)}` : "";
  async function readRating(song?: Media) {
    const path = ratingPath(song);
    if (!path) return 0;
    const at = path.lastIndexOf("/");
    try { return (await apple.request(`${path.slice(0, at)}?ids=${path.slice(at + 1)}`)).data?.[0]?.attributes?.value ?? 0; }
    catch { return undefined; }
  }
  const playingSong = () => entries.get(current.item ?? -1)?.song;
  // Apple Music can play a song Peel did not queue, such as one a host before this one queued
  // before it restarted. sync knows only its title. Each such song is looked up in the catalog
  // once, for its cover and heart, and the result fills every placeholder of it, also later ones.
  // A failed lookup of a song is tried again after 30 seconds.
  const looked = new Map<string, { song?: Media; pending?: boolean; failed?: number }>();
  const fill = (id: string, song: Media) => {
    for (const known of entries.values()) if (known.unknown && known.song.id === id) { known.song = song; known.unknown = false; }
  };
  function lookUp() {
    const entry = entries.get(current.item ?? -1), id = entry?.song.id;
    if (!entry?.unknown || !id || !/^\d+$/.test(id)) return;
    const known = looked.get(id);
    if (known?.song) return fill(id, known.song);
    if (known?.pending || known?.failed && Date.now() - known.failed < 30000) return;
    const lookup: { song?: Media; pending?: boolean; failed?: number } = { pending: true };
    looked.delete(id); looked.set(id, lookup);
    // Keeps the newest 200 songs.
    for (const old of looked.keys()) { if (looked.size <= 200) break; looked.delete(old); }
    void apple.request(`v1/catalog/$STOREFRONT/songs/${encodeURIComponent(id)}`)
      .then(response => {
        const item = response.data?.[0];
        if (!item) { lookup.failed = Date.now(); return; }
        lookup.song = media(item);
        fill(id, lookup.song);
      })
      .catch(() => { lookup.failed = Date.now(); })
      .finally(() => { lookup.pending = false; });
  }
  async function checkRating() {
    const song = playingSong();
    if (!song) return;
    rated = { id: song.id, value: rated.id === song.id ? rated.value : undefined, checked: Date.now() };
    const value = await readRating(song);
    if (playingSong()?.id === song.id && value !== undefined) rated = { id: song.id, value, checked: Date.now() };
  }

  function playback(): Playback {
    if (current.title) lookUp();
    const song = playingSong();
    const playing = current.state === PLAYING || wanted && (current.state === BUFFERING || current.state === CONNECTING);
    if (song && Date.now() - rated.checked > (rated.id !== song.id || rated.value === undefined ? 3000 : 30000)) void checkRating();
    return {
      state: playing ? "playing" : current.item !== undefined && current.title ? "paused" : "stopped",
      nowPlaying: current.title ? {
        name: current.title, artistName: current.artist, albumName: current.album,
        artwork: { url: song?.artwork }, playParams: { id: song?.id ?? current.id, catalogId: current.id },
        inFavorites: song && rated.id === song.id && rated.value !== undefined ? rated.value === 1 : undefined,
      } : null,
      time: { currentTime: (current.position ?? 0) / 1000, duration: (current.duration ?? 0) / 1000 },
      volume, repeatMode: repeats[repeat] ?? "none", shuffleMode: shuffle, queueRevision: revision(),
      ...(notice ? { error: notice } : current.error ? { error: current.error } : {}),
    };
  }

  // Apple mixes the songs after the playing one when shuffle turns on, and restores their order
  // when it turns off. The new order shows in its queue a moment later.
  // Songs of a long list not sent yet are mixed and put back here, in the same way.
  async function setShuffle(enabled: boolean) {
    if (enabled !== shuffle) { if (enabled) mix(rest); else rest.sort((a, b) => a.at - b.at); }
    shuffle = enabled;
    const before = order.join();
    await control.request(`shuffle ${enabled ? 1 : 0}`);
    if (order.length - position() > 2) await syncUntil(() => order.join() !== before, "Apple Music did not change shuffle.").catch(() => {});
  }

  const setVolume = async (value: number) => {
    volume = Math.min(1, Math.max(0, value));
    await control.request(`volume ${volume}`);
    muted = false;
    await writeJson("volume.json", { volume });
  };

  // Android's volume is at 0 while muted, and volume keeps the listener's own level for later.
  let muted = false;
  async function unmute() { await control.request(`volume ${volume}`); muted = false; }
  // Stops what plays after a failed command. Without a confirmed pause or stop, Android stays
  // muted until the next playback command succeeds.
  async function silence() {
    wanted = false;
    for (const command of ["pause", "stop"]) {
      try {
        await step(command, stopped);
        if (muted) await unmute().catch(() => {});
        return;
      } catch {}
    }
    muted = true;
    await control.request("volume 0").catch(() => {});
    notice = "Hi-res playback could not confirm that it stopped, so its volume is off until you play again.";
  }

  const methods: Record<string, (...args: any[]) => unknown> = {
    tokens: () => { throw new Error("The hi-res player has no Apple sign-in."); },
    failed: (text: string) => { notice = text; },
    quality: () => "lossless",
    // Only a confirmed pause counts, not a song that is still buffering, so a device that moves
    // the music away never resumes while this one starts after all.
    pause: async () => { wanted = false; await step("pause", stopped); },
    stop: async () => { wanted = false; await step("stop", stopped); },
    resume: async () => { wanted = true; notice = undefined; await step("play", state => state.state === PLAYING || state.state === BUFFERING); },
    toggle: async () => {
      await read().catch(() => {});
      const playing = current.state === PLAYING || current.state === BUFFERING;
      wanted = !playing;
      await step(playing ? "pause" : "play", state => playing ? stopped(state) : state.state === PLAYING || state.state === BUFFERING);
    },
    next: () => step("next", (state, before) => state.item !== before.item),
    // Previous restarts a song that played for a few seconds, so a position back at the start counts too.
    previous: () => step("previous", (state, before) => state.item !== before.item || (state.position ?? 0) < 2000),
    seek: (time: number) => {
      const target = Math.max(0, Math.round(time * 1000));
      return step(`seek ${target}`, state => Math.abs((state.position ?? 0) - target) < 1500);
    },
    volume: setVolume,
    shuffle: (enabled: boolean) => setShuffle(!!enabled),
    toggleShuffle: () => setShuffle(!shuffle),
    toggleRepeat: async () => { repeat = (repeat + 1) % 3; await control.request(`repeat ${repeat}`); },
    // A song inside its collection. Songs added and not heard yet stay queued after it.
    play: async (items: Media[], index = 0) => {
      wanted = true; notice = undefined;
      const at = position(), waiting = order.slice(at + 1).map(id => entries.get(id)).filter(entry => entry?.added).map(entry => entry!.song);
      const playing = await playList(items, index);
      if (playing !== index && items[index]) notice = `Hi-res cannot play "${items[index]!.name}", because Apple's catalog no longer has it or did not answer. The next song plays.`;
      // The new songs play either way, so a song that could not be queued again is only reported.
      if (waiting.length) await insert(waiting, true).catch(error => { notice = error instanceof Error ? error.message : String(error); });
    },
    enqueue: async (items: Media[], next: boolean) => {
      if (!order.length || current.item === undefined) {
        wanted = true;
        await playList(items, 0, new Set(items.map((_, at) => at).slice(1)));
        return;
      }
      await insert(items, next);
    },
    move: async (from: number, to: number, expected?: string, target?: string) => {
      check(from, expected); check(to, target);
      if (Math.max(from, to) >= order.length) throw new Error("Only the songs Apple Music lists next can be moved.");
      const at = position();
      if (Math.min(from, to) <= at) return;
      const id = order[from]!, beside = order[to]!, after = to > from;
      await control.request(`move ${id} ${beside} ${after ? 1 : 2}`).catch(unless);
      await syncUntil(() => order.indexOf(id) === order.indexOf(beside) + (after ? 1 : -1), "Apple Music did not move the song.");
    },
    remove: async (index: number, expected?: string) => {
      check(index, expected);
      if (index <= position()) return;
      const list = whole(), id = list[index]?.id;
      if (id === undefined) { rest.splice(index - (list.length - rest.length), 1); return; }
      await control.request(`remove ${id}`).catch(unless);
      await syncUntil(() => !order.includes(id), "Apple Music did not remove the song.");
      removed.add(id);
    },
    // A song Apple has queued plays from its queue. One not sent yet starts a new window there.
    jump: async (index: number, expected?: string) => {
      check(index, expected);
      wanted = true;
      const list = whole(), target = list[index]?.id;
      if (target === undefined) {
        const from = position();
        await playList(list.slice(from).map(entry => entry.song), index - from, new Set(list.slice(from).flatMap((entry, at) => entry.added ? [at] : [])));
        return;
      }
      await step(`skip ${target}`, state => state.item === target);
    },
    queue: () => ({ position: position(), items: whole().map((entry, index) => ({ ...describe(entry.song), added: index > position() && entry.added })) }),
    added: (offset = 0, limit = 100) => {
      const at = position(), list = order.map((id, index) => ({ id, index })).filter(({ id, index }) => index > at && entries.get(id)?.added);
      return { more: offset + limit < list.length, items: list.slice(offset, offset + limit).map(({ id, index }) => ({ ...describe(songOf(id)), queueIndex: index })) };
    },
    position: () => ({ position: position(), total: order.length + hidden().length + rest.length }),
    exportPlayback: () => ({
      items: whole().map(entry => entry.song), position: position(),
      added: whole().map((entry, index) => index > position() && entry.added ? index : -1).filter(index => index >= 0),
      time: (current.position ?? 0) / 1000, playing: current.state === PLAYING, repeatMode: repeats[repeat], shuffleMode: shuffle,
    }),
    // Takes over a queue from another device. A paused queue starts silent, seeks, and pauses, and
    // its volume returns only once Android confirms the pause. A failed import leaves this device
    // silent: paused, or muted when even the pause can't be confirmed.
    importPlayback: async ({ items = [], position: start = 0, added = [], time = 0, playing = false, repeatMode = "none", shuffleMode = false } = {}) => {
      wanted = false;
      if (!items.length) { await control.request("stop"); return; }
      try {
        if (!playing) { muted = true; await control.request("volume 0"); }
        // The queue arrives in its played order. Shuffle is applied afterwards, as it was there.
        if (shuffle) { shuffle = false; await control.request("shuffle 0"); }
        const selected = await playList(items, start, new Set(added));
        // The saved time belongs to the song that played there. A song played in its place starts at 0.
        if (time > 1 && selected === start) await step(`seek ${Math.round(time * 1000)}`, state => Math.abs((state.position ?? 0) - time * 1000) < 1500);
        repeat = Math.max(0, repeats.indexOf(repeatMode)); await control.request(`repeat ${repeat}`);
        if (shuffleMode) await setShuffle(true);
        if (!playing) await step("pause", stopped);
        if (muted) await unmute();
        wanted = playing;
      } catch (error) {
        await silence();
        throw error;
      }
    },
    // Restarts Apple Music and continues the queue where it stalled or went silent, or pauses
    // after a second stall. watchStall and watchSilence run it. A listener who paused meanwhile
    // keeps the pause.
    recover: async (again: boolean) => {
      if (!wanted) return;
      if (again) {
        wanted = false;
        await step("pause", stopped).catch(() => {});
        notice = "Apple Music stopped streaming, also after a restart. Check the network, or try another song.";
        return;
      }
      const saved = methods.exportPlayback!() as Parameters<typeof methods.importPlayback>[0];
      await control.request("restart");
      // Apple Music starts again with the next command, and its session can take a few seconds.
      // A queue sent before it is there is lost.
      for (const end = Date.now() + 15000; ; await sleep(500)) {
        try { await control.request("state"); break; } catch (error) { if (Date.now() > end) throw error; }
      }
      await methods.importPlayback!({ ...saved, playing: true });
    },
    extend,
    rating: async () => await readRating(playingSong()) ?? -1,
    rate: async (value: number, expected?: string) => {
      const song = playingSong(), path = ratingPath(song);
      if (expected && song?.id !== expected) throw new Error("The playing song changed. Nothing was rated.");
      if (!path) throw new Error("This song cannot be rated.");
      await apple.request(path, value ? { method: "PUT", body: JSON.stringify({ type: "rating", attributes: { value } }) } : { method: "DELETE" });
      rated = { id: song!.id, value: value ? 1 : 0, checked: Date.now() };
    },
  };
  const playbackMethods = new Set(["pause", "stop", "resume", "toggle", "next", "previous", "seek", "play", "jump", "enqueue", "importPlayback", "recover"]);

  // Each Peel sends its process ID. Once every Peel that used the host has exited, the music
  // pauses, Android stops and the host exits. Android holds about 1.6 GB while it runs, and the
  // next Peel boots it again in about 7 seconds while the listener browses.
  // An SSH helper marks itself remote. When the last Peel on this computer closes while only Peels
  // controlling it over SSH remain, the music pauses, as it does when that Peel is the last one.
  // Android keeps running for those remote Peels, which can read the state and start the music.
  const owners = new Map<number, boolean>();
  const launcher = Number(process.env.PEEL_OWNER);
  if (Number.isInteger(launcher) && launcher > 0) owners.set(launcher, process.env.PEEL_OWNER_REMOTE === "1");
  // Removes owners, and pauses when the last Peel on this computer left and only remote Peels
  // remain. With no owner left, quitUnowned pauses and stops Android instead.
  const leave = (pids: number[]) => {
    let local = false;
    for (const pid of pids) if (owners.has(pid)) { local ||= !owners.get(pid); owners.delete(pid); }
    if (owners.size && local && ![...owners.values()].includes(false)) void call("pause").catch(() => {});
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
  // `peel-hires session idle` leaves Android running while an update or a sign-in uses it. It runs
  // between controller requests, so a Peel that attaches meanwhile waits and its first request
  // starts Android again, instead of playing into an Android that is stopping.
  const stopAndroid = () => control.exclusive(async () => {
    const command = hiresCommand();
    if (!command) return;
    const run = Bun.spawn([...command, "session", "idle"], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => run.kill(), 150000);
    await run.exited;
    clearTimeout(timer);
  });
  const quit = async () => {
    await control.request("pause").catch(() => {});
    await stopAndroid();
    process.exit(0);
  };
  // A Peel that attaches while the last one leaves keeps the host: ownership is checked again
  // before the pause, before Android stops, and once more before exiting. A Peel that attached
  // while Android stopped starts it again through the controller.
  let leaving = false;
  const quitUnowned = async () => {
    if (owners.size || leaving) return;
    leaving = true;
    try {
      await control.request("pause").catch(() => {});
      if (owners.size) return;
      await stopAndroid();
      if (!owners.size) process.exit(0);
    } finally { leaving = false; }
  };
  setInterval(() => {
    if (!owners.size) return;
    leave([...owners.keys()].filter(pid => !alive(pid)));
    if (!owners.size) void quitUnowned();
  }, 1000).unref();

  // Calls run one at a time, as in the web engine.
  let calling: Promise<unknown> = Promise.resolve();
  const call = (method: string, args: unknown[] = []) => {
    const run = methods[method];
    if (!run) return Promise.reject(new Error(`Hi-res playback has no method ${method}.`));
    const result = calling.catch(() => {}).then(async () => {
      busy++;
      try {
        const value = await run(...args);
        if (playbackMethods.has(method)) await read().catch(() => {});
        // A playback command that worked hands control back to the listener, so a volume muted
        // after a failure returns.
        if (muted && playbackMethods.has(method) && method !== "importPlayback") await unmute().catch(() => {});
        return value;
      } finally { busy--; }
    });
    calling = result;
    return result;
  };

  const key = crypto.getRandomValues(new Uint8Array(24)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");
  Bun.serve({
    hostname: "127.0.0.1", port: hiresPort,
    async fetch(request) {
      const reply = (status: number, value: unknown) => Response.json(value ?? null, { status });
      if (request.headers.get("x-peel-key") !== key) return reply(403, { error: "Wrong engine key" });
      const owner = Number(request.headers.get("x-peel-owner"));
      const known = Number.isInteger(owner) && owner > 0;
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/release") {
        if (known) leave([owner]);
        if (!owners.size) setTimeout(() => void quitUnowned(), 10);
        return reply(200, null);
      }
      if (known && !owners.has(owner)) owners.set(owner, request.headers.get("x-peel-remote") === "1");
      try {
        if (path === "/retain") return reply(200, null);
        if (path === "/state") {
          // others counts the Peels besides the one asking, so the SSH helper can tell whether
          // restarting this host for an update would interrupt someone.
          const others = [...owners.keys()].filter(pid => pid !== owner).length;
          if (!ready) return reply(200, { ready: false, signIn: false, playback: control.error ? { error: control.error } : undefined, version, build, instance, others });
          await read(!busy).catch(error => { notice = error.message; });
          return reply(200, { ready: true, signIn: false, playback: playback(), version, build, instance, others });
        }
        if (path === "/quit" && request.method === "POST") { setTimeout(() => void quit(), 10); return reply(200, null); }
        if (path === "/call" && request.method === "POST") {
          const { method, args } = await request.json() as { method: string; args?: unknown[] };
          return reply(200, await call(method, args) ?? null);
        }
        return reply(404, { error: "Not found" });
      } catch (error) { return reply(500, { error: error instanceof Error ? error.message : String(error) }); }
    },
  });
  await writeJson("key.json", { port: hiresPort, key });

  // Android and the controller start in the background, so Peel's interface can say so.
  for (;;) {
    try {
      await control.request("ping");
      // Peel plays only what was queued: Apple's autoplay would add similar songs at the end.
      await control.request("autoplay false");
      await control.request("repeat 0");
      await control.request("shuffle 0");
      await control.request(`volume ${volume}`);
      await read().catch(() => {});
      ready = true; control.error = undefined;
      break;
    } catch (error) {
      control.error = error instanceof Error ? error.message : String(error);
      await sleep(3000);
    }
  }
}

if (import.meta.main && process.argv.includes("--hires-host")) await runHiresHost();
