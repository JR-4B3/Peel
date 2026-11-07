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
import { readAppleSignIn, systemDir } from "./config";
import { Engine, systemdSession } from "./engine";
import type { Media, Playback } from "./types";

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

// Hi-res plays wherever the hi-res pipeline is installed, unless PEEL_PLAYER chooses another player.
export function hiresSelected() {
  const choice = process.env.PEEL_PLAYER;
  if (choice === "hires") return true;
  if (choice && choice !== "auto") return false;
  return !!hiresCommand();
}

// The web engine's client, pointed at the hi-res host.
export class Hires extends Engine {
  constructor() { super(hiresHome); }
  // The host has no Apple sign-in of its own. index.ts renews it through the web engine.
  async appleTokens(): Promise<{ userToken: string; storefront?: string }> { throw new Error("The hi-res player has no Apple sign-in."); }
}

// Starts the host when it is not running and waits until Android and Apple Music answer. The first
// start boots Android, which takes about ten seconds.
export async function ensureHires(engine: Engine, status: (text: string) => void = () => {}, signal?: AbortSignal) {
  const state = () => engine.state().catch(() => undefined);
  let current = await state();
  if (!current) {
    signal?.throwIfAborted();
    status("Starting hi-res playback...");
    await launchHost();
  }
  const until = Date.now() + 3 * 60 * 1000;
  while (!current?.ready && Date.now() < until) {
    if (current?.playback?.error) status(current.playback.error);
    await sleep(250, undefined, { signal });
    current = await state();
  }
  if (!current?.ready) throw new Error(current?.playback?.error ?? "Hi-res playback did not start. Run peel-hires status to see why.");
}

async function launchHost() {
  const args = [process.execPath, fileURLToPath(new URL("./index.ts", import.meta.url)), "--hires-host"];
  const environment: Record<string, string> = { PEEL_OWNER: String(process.pid) };
  if (systemdSession()) {
    const settings = Object.entries(environment).map(([name, value]) => `--setenv=${name}=${value}`);
    for (const name of ["PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "PEEL_CONFIG_DIR", "PEEL_CACHE_DIR", "PEEL_HIRES_HOME", "PEEL_HIRES_PORT", "PEEL_HIRES_COMMAND"]) if (process.env[name]) settings.push(`--setenv=${name}=${process.env[name]}`);
    const child = Bun.spawn(["systemd-run", "--user", "--collect", "--unit=peel-hires-host", ...settings, "--", ...args], { stdout: "ignore", stderr: "pipe" });
    if (await child.exited !== 0) {
      const active = Bun.spawn(["systemctl", "--user", "is-active", "--quiet", "peel-hires-host.service"]);
      if (await active.exited !== 0) throw new Error(`Could not start hi-res playback: ${(await new Response(child.stderr).text()).trim()}`);
    }
    return;
  }
  await mkdir(hiresHome, { recursive: true, mode: 0o700 });
  const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: "ignore", env: { ...process.env, ...environment } });
  child.unref();
}

// ---- The host ----------------------------------------------------------------------------------

// Apple Music's media session state codes.
const PLAYING = 3, BUFFERING = 6, CONNECTING = 8;
const repeats = ["none", "one", "all"] as const;

interface Control { state?: number; position?: number; item?: number; title?: string; artist?: string; album?: string; id?: string; duration?: number; error?: string }
interface Entry { queueId: number; song: Media; added: boolean }

// One line-based connection to the controller in Android. Requests go one at a time.
class Controller {
  private socket?: Awaited<ReturnType<typeof Bun.connect>>;
  private waiting: ((line: string) => void)[] = [];
  private buffer = "";
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
    this.socket = await Bun.connect({
      hostname: this.access!.host, port: this.access!.port,
      socket: {
        data: (_socket, data) => {
          this.buffer += data.toString();
          let end;
          while ((end = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); this.waiting.shift()?.(line); }
        },
        close: () => this.drop(),
        error: () => this.drop(),
      },
    });
  }

  private drop() {
    this.socket = undefined; this.buffer = "";
    for (const resolve of this.waiting.splice(0)) resolve('{"error":"closed"}');
  }

  // Sends one command and returns the controller's answer. A lost connection is made once more.
  request(command: string): Promise<any> {
    const run = async (retry: boolean): Promise<any> => {
      await this.connect();
      const answer = await new Promise<string>((resolve, reject) => {
        this.waiting.push(resolve);
        this.socket!.write(`${this.access!.key} ${command}\n`);
        setTimeout(() => reject(new Error("Apple Music did not answer.")), 10000).unref();
      }).catch(error => { this.socket?.end(); this.drop(); throw error; });
      const value = JSON.parse(answer);
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
  const version = "hires";
  let volume = (() => { try { return JSON.parse(readFileSync(join(hiresHome, "volume.json"), "utf8")).volume ?? 1; } catch { return 1; } })();
  let repeat = 0, shuffle = false;
  // The whole queue in Apple Music's order, history included, and Peel's song for each entry.
  let order: number[] = [];
  const entries = new Map<number, Entry>();
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
    if (!queue.length) return;
    const playing = queue[0]!.queueId, at = order.indexOf(playing);
    order = [...(at >= 0 ? order.slice(0, at) : []), ...queue.map(item => item.queueId)];
    for (const item of queue) if (!entries.has(item.queueId)) entries.set(item.queueId, { queueId: item.queueId, added: false, song: { id: item.id, type: "songs", name: item.title, artist: "", album: "", duration: 0, catalogId: item.id } });
  }

  // Reads what plays. When the playing entry changed, Apple's queue is read again.
  async function read() {
    const before = current.item;
    current = await control.request("state");
    if (current.item !== before) await sync();
    return current;
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

  // Waits until Apple Music plays an entry that was not playing before, after a new queue.
  async function settle(previous?: number) {
    if (!await until(state => state.item !== undefined && state.item !== previous, 8000)) throw new Error("Apple Music did not start the song.");
  }

  // Runs a command that changes the playing entry or position, and waits for it to show.
  async function step(command: string, done: (state: Control, before: Control) => boolean) {
    await read().catch(() => {});
    const before = { ...current };
    await control.request(command);
    await until(state => done(state, before));
  }

  // Replaces the queue with songs and plays the one at index.
  async function playList(songs: Media[], index: number, marks: Set<number> = new Set()) {
    const playable = songs.map((song, at) => ({ song, at, id: catalogOf(song) })).filter(entry => entry.id);
    if (!playable.length) throw new Error("These songs are only in your library, without a catalog version, so hi-res cannot play them.");
    let start = playable.findIndex(entry => entry.at >= index);
    if (start < 0) start = playable.length - 1;
    const previous = current.item;
    await control.request(`list ${start} ${playable.map(entry => entry.id).join(",")}`);
    await settle(previous);
    const base = current.item! - start;
    order = playable.map((_, at) => base + at);
    playable.forEach((entry, at) => entries.set(base + at, { queueId: base + at, song: entry.song, added: marks.has(entry.at) }));
    await sync();
  }

  // Adds songs after the playing one (next) or after the songs added before.
  async function insert(songs: Media[], next: boolean) {
    const playable = songs.filter(catalogOf);
    if (!playable.length) return;
    const known = new Set(order);
    let target: number | undefined;
    if (!next) {
      const at = order.indexOf(current.item!);
      let last = at;
      while (last + 1 < order.length && entries.get(order[last + 1]!)?.added) last++;
      if (last > at) target = order[last];
    }
    await control.request(`add next ${playable.map(catalogOf).join(",")}`);
    // Apple names the inserted entries in a new batch. They are found in its queue afterwards.
    let fresh: number[] = [];
    for (const until = Date.now() + 5000; Date.now() < until && fresh.length < playable.length; await sleep(100)) {
      await sync();
      fresh = order.filter(id => !known.has(id));
    }
    fresh.forEach((id, at) => entries.set(id, { queueId: id, song: playable[at]!, added: true }));
    // Play later: the new songs move behind the songs added before them, in order.
    if (target !== undefined) {
      let after = target;
      for (const id of fresh) { await control.request(`move ${id} ${after} 1`); after = id; }
      await sync();
    }
  }

  // Every entry in order has a song. One Apple added by itself and the host never saw gets a
  // placeholder until the next read of the queue.
  const songOf = (id: number): Media => entries.get(id)?.song ?? { id: "", type: "songs", name: "", artist: "", album: "", duration: 0 };
  const position = () => Math.max(0, order.indexOf(current.item ?? -1));
  const songAt = (index: number) => entries.get(order[index]!)?.song;
  const check = (index: number, expected?: string) => {
    if (expected && songAt(index)?.id !== expected) throw new Error("The queue changed on another controller. Try again.");
  };

  function revision() {
    let hash = 0x811c9dc5;
    const add = (text: string) => { for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); } };
    add(String(position()));
    for (const id of order) add(`|${id}${entries.get(id)?.added ? "+" : ""}`);
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
  async function checkRating() {
    const song = playingSong();
    if (!song) return;
    rated = { id: song.id, value: rated.id === song.id ? rated.value : undefined, checked: Date.now() };
    const value = await readRating(song);
    if (playingSong()?.id === song.id && value !== undefined) rated = { id: song.id, value, checked: Date.now() };
  }

  function playback(): Playback {
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

  const setVolume = async (value: number) => {
    volume = Math.min(1, Math.max(0, value));
    await control.request(`volume ${Math.round(volume * 15)}`);
    await writeJson("volume.json", { volume });
  };

  const methods: Record<string, (...args: any[]) => unknown> = {
    tokens: () => { throw new Error("The hi-res player has no Apple sign-in."); },
    failed: (text: string) => { notice = text; },
    quality: () => "lossless",
    pause: async () => { wanted = false; await step("pause", state => state.state !== PLAYING); },
    stop: async () => { wanted = false; await step("stop", state => state.state !== PLAYING); },
    resume: async () => { wanted = true; notice = undefined; await step("play", state => state.state === PLAYING || state.state === BUFFERING); },
    toggle: async () => {
      await read().catch(() => {});
      const playing = current.state === PLAYING || current.state === BUFFERING;
      wanted = !playing;
      await step(playing ? "pause" : "play", state => playing ? state.state !== PLAYING : state.state === PLAYING || state.state === BUFFERING);
    },
    next: () => step("next", (state, before) => state.item !== before.item),
    // Previous restarts a song that played for a few seconds, so a position back at the start counts too.
    previous: () => step("previous", (state, before) => state.item !== before.item || (state.position ?? 0) < 2000),
    seek: (time: number) => {
      const target = Math.max(0, Math.round(time * 1000));
      return step(`seek ${target}`, state => Math.abs((state.position ?? 0) - target) < 1500);
    },
    volume: setVolume,
    shuffle: async (enabled: boolean) => { shuffle = !!enabled; await control.request(`shuffle ${shuffle ? 1 : 0}`); await sync(); },
    toggleShuffle: async () => { shuffle = !shuffle; await control.request(`shuffle ${shuffle ? 1 : 0}`); await sync(); },
    toggleRepeat: async () => { repeat = (repeat + 1) % 3; await control.request(`repeat ${repeat}`); },
    // A song inside its collection. Songs added and not heard yet stay queued after it.
    play: async (items: Media[], index = 0) => {
      wanted = true; notice = undefined;
      const at = position(), waiting = order.slice(at + 1).map(id => entries.get(id)).filter(entry => entry?.added).map(entry => entry!.song);
      await playList(items, index);
      if (waiting.length) await insert(waiting, true);
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
      const at = position();
      if (Math.min(from, to) <= at) return;
      await control.request(`move ${order[from]} ${order[to]} ${to > from ? 1 : 2}`);
      await sync();
    },
    remove: async (index: number, expected?: string) => {
      check(index, expected);
      if (index <= position()) return;
      await control.request(`remove ${order[index]}`);
      await sync();
    },
    jump: async (index: number, expected?: string) => {
      check(index, expected);
      wanted = true;
      const target = order[index];
      await step(`skip ${target}`, state => state.item === target);
    },
    queue: () => ({ position: position(), items: order.map((id, index) => ({ ...describe(songOf(id)), added: index > position() && !!entries.get(id)?.added })) }),
    added: (offset = 0, limit = 100) => {
      const at = position(), list = order.map((id, index) => ({ id, index })).filter(({ id, index }) => index > at && entries.get(id)?.added);
      return { more: offset + limit < list.length, items: list.slice(offset, offset + limit).map(({ id, index }) => ({ ...describe(songOf(id)), queueIndex: index })) };
    },
    position: () => ({ position: position(), total: order.length }),
    exportPlayback: () => ({
      items: order.map(songOf), position: position(),
      added: order.map((id, index) => index > position() && entries.get(id)?.added ? index : -1).filter(index => index >= 0),
      time: (current.position ?? 0) / 1000, playing: current.state === PLAYING, repeatMode: repeats[repeat], shuffleMode: shuffle,
    }),
    // Takes over a queue from another device. A paused queue starts silent, seeks, and pauses.
    importPlayback: async ({ items = [], position: start = 0, added = [], time = 0, playing = false, repeatMode = "none", shuffleMode = false } = {}) => {
      wanted = false;
      if (!items.length) { await control.request("stop"); return; }
      if (!playing) await control.request("volume 0");
      try {
        await playList(items, start, new Set(added));
        if (time > 1) await step(`seek ${Math.round(time * 1000)}`, state => Math.abs((state.position ?? 0) - time * 1000) < 1500);
        if (!playing) await step("pause", state => state.state !== PLAYING);
        wanted = playing;
      } finally { if (!playing) await control.request(`volume ${Math.round(volume * 15)}`); }
      repeat = Math.max(0, repeats.indexOf(repeatMode)); await control.request(`repeat ${repeat}`);
      if (shuffleMode) { shuffle = true; await control.request("shuffle 1"); await sync(); }
    },
    rating: async () => await readRating(playingSong()) ?? -1,
    rate: async (value: number, expected?: string) => {
      const song = playingSong(), path = ratingPath(song);
      if (expected && song?.id !== expected) throw new Error("The playing song changed. Nothing was rated.");
      if (!path) throw new Error("This song cannot be rated.");
      await apple.request(path, value ? { method: "PUT", body: JSON.stringify({ type: "rating", attributes: { value } }) } : { method: "DELETE" });
      rated = { id: song!.id, value: value ? 1 : 0, checked: Date.now() };
    },
  };
  const playbackMethods = new Set(["pause", "stop", "resume", "toggle", "next", "previous", "seek", "play", "jump", "enqueue", "importPlayback"]);

  // Each Peel sends its process ID. Once every Peel that used the host has exited, the music
  // pauses and the host exits. Android keeps running for the next start.
  const owners = new Set<number>();
  const launcher = Number(process.env.PEEL_OWNER);
  if (Number.isInteger(launcher) && launcher > 0) owners.add(launcher);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
  const quit = async () => {
    await control.request("pause").catch(() => {});
    process.exit(0);
  };
  setInterval(() => {
    if (!owners.size) return;
    for (const pid of owners) if (!alive(pid)) owners.delete(pid);
    if (!owners.size) void quit();
  }, 1000).unref();

  // Calls run one at a time, as in the web engine.
  let calling: Promise<unknown> = Promise.resolve();
  const call = (method: string, args: unknown[] = []) => {
    const run = methods[method];
    if (!run) return Promise.reject(new Error(`Hi-res playback has no method ${method}.`));
    const result = calling.catch(() => {}).then(async () => { const value = await run(...args); if (playbackMethods.has(method)) await read().catch(() => {}); return value; });
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
        if (known) owners.delete(owner);
        if (!owners.size) setTimeout(() => void quit(), 10);
        return reply(200, null);
      }
      if (known) owners.add(owner);
      try {
        if (path === "/retain") return reply(200, null);
        if (path === "/state") {
          if (!ready) return reply(200, { ready: false, signIn: false, playback: control.error ? { error: control.error } : undefined, version, instance });
          await read().catch(error => { notice = error.message; });
          return reply(200, { ready: true, signIn: false, playback: playback(), version, instance });
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
      await control.request(`volume ${Math.round(volume * 15)}`);
      await read().catch(() => {});
      ready = true; control.error = undefined;
      break;
    } catch (error) {
      control.error = error instanceof Error ? error.message : String(error);
      await sleep(3000);
    }
  }
}
