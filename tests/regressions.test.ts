// Regression tests for the bugs found in the review of 6 November 2026 (GitHub issues #6 to #11).
import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { saveJson } from "../src/config";
import { stopEngine, type Engine } from "../src/engine";
import { Model } from "../src/model";
import { stopped, type Library, type Media, type Page, type Playback } from "../src/types";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const song = (id: string): Media => ({ id, catalogId: id, type: "songs", name: id, artist: "Artist", album: "Album", duration: 100 });
const empty = async (): Promise<Page> => ({ items: [], more: false });

function library(): Library {
  return {
    recent: async () => [], releases: async () => [], playlists: async () => [], search: async () => [],
    songs: empty, playlist: empty, album: empty, albums: empty, artists: empty,
    artistId: async () => "artist", artist: async () => ({ artist: { ...song("artist"), type: "artists" }, top: [], shelves: [] }),
    ratings: async () => new Set<string>(), albumFavourite: async () => false, favouriteAlbum: async () => {},
  } as unknown as Library;
}

// A player whose queue has five songs and which plays song "1" in repeat-one mode.
function setup() {
  let position = 0;
  const playing = (id: string): Playback => ({ ...structuredClone(stopped), state: "playing", repeatMode: "one", nowPlaying: { name: id, artistName: "Artist", inFavorites: false, playParams: { id, catalogId: id } } });
  let state = playing("1");
  const jumps: number[] = [];
  const ratings: Record<string, number> = {};
  const player: any = {
    queuesItems: true,
    snapshot: async () => structuredClone(state),
    queue: empty,
    queuePosition: async () => ({ position, total: 5 }),
    rating: async () => ratings[state.nowPlaying!.playParams!.id!] ?? 0,
    playItem: async (item: Media) => { await Bun.sleep(5); state = playing(item.id); },
    playCollectionTrack: async () => {}, enqueue: async () => {},
    command: async (path: string, body: any, method: string) => {
      if (path === "/queue/jump") { await Bun.sleep(5); position = body.index; jumps.push(position); }
      if (path === "/library/now-playing/rating") ratings[state.nowPlaying!.playParams!.id!] = method === "DELETE" ? 0 : body.rating;
    },
  };
  const api = library();
  const model = new Model(api, player);
  model.connected = true; model.playback = structuredClone(state);
  return { model, api, jumps, ratings };
}

test("#6 simultaneous saves of one file all succeed, keep the last value, and leave no temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-save-")); cleanup.push(() => rm(dir, { recursive: true }));
  const values = Array.from({ length: 20 }, (_, index) => ({ recent: [`song ${index}`], releases: [] }));
  const results = await Promise.allSettled(values.map(value => saveJson("home.json", value, dir)));
  expect(results.every(result => result.status === "fulfilled")).toBe(true);
  expect(JSON.parse(await readFile(join(dir, "home.json"), "utf8"))).toEqual(values.at(-1)!);
  expect(await readdir(dir)).toEqual(["home.json"]);
});

test("#6 a failed save does not stop the next save of the same file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-save-")); cleanup.push(() => rm(dir, { recursive: true }));
  const circular: any = {}; circular.self = circular;
  expect(() => saveJson("layout.json", circular, dir)).toThrow();
  await saveJson("layout.json", { order: ["a"] }, dir);
  expect(JSON.parse(await readFile(join(dir, "layout.json"), "utf8"))).toEqual({ order: ["a"] });
});

test("#7 rapid Next and Previous in repeat-one mode add up from where the queue is", async () => {
  const { model, jumps } = setup();
  await Promise.all([model.skip(1), model.skip(1), model.skip(1)]);
  expect(jumps).toEqual([3]);
  await Promise.all([model.skip(-1), model.skip(1), model.skip(-1), model.skip(-1)]);
  expect(jumps.slice(1)).toEqual([1]);
  expect(model.playback.repeatMode).toBe("one");
});

test("#8 a favourite queued behind another song's start rates neither song", async () => {
  const { model, ratings } = setup();
  await Promise.all([model.activate(song("2")), model.toggleFavourite()]);
  expect(ratings).toEqual({});
  expect(model.status).toContain("song changed");
});

test("#8 a favourite with nothing queued before it rates the shown song", async () => {
  const { model, ratings } = setup();
  await model.toggleFavourite();
  expect(ratings).toEqual({ "1": 1 });
  expect(model.favourite).toBe(true);
});

test("#9 a list left before its first page arrived loads again on Back", async () => {
  const { model, api } = setup();
  const answers: ((page: Page) => void)[] = [];
  api.songs = () => new Promise(resolve => { answers.push(resolve); });
  const opening = model.open("songs");
  await model.openArtist(song("1"));
  model.back();
  // The first request was abandoned when the artist opened. Back asked again.
  expect(answers.length).toBe(2);
  answers[0]!({ items: [song("stale")], more: false });
  answers[1]!({ items: [song("1")], more: false });
  await Bun.sleep(10);
  expect({ view: model.view, items: model.items.map(item => item.id), loading: model.loading }).toEqual({ view: "songs", items: ["1"], loading: false });
  void opening;
});

// Runs engine/main.js up to its startup with a stand-in for Electron, as the review did.
function engineMain(env: Record<string, string>) {
  const require = createRequire(import.meta.url);
  const engineDir = fileURLToPath(new URL("../engine/", import.meta.url));
  const source = readFileSync(join(engineDir, "main.js"), "utf8");
  let server: http.Server | undefined;
  const quits: number[] = [];
  const app = { setPath() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => true, exit() {}, quit: () => { quits.push(Date.now()); } };
  const context = vm.createContext({
    require(name: string) {
      if (name === "electron") return { app };
      if (name === "node:os") return { homedir: () => "/nonexistent-peel-home" };
      if (name === "node:http") return { createServer(handler: http.RequestListener) {
        server = http.createServer(handler);
        return { listen(_port: number, host: string, callback: () => void) { server!.listen(0, host, callback); } };
      } };
      return require(name);
    },
    process: { env }, __dirname: engineDir, __filename: join(engineDir, "main.js"), console: { log() {} }, Buffer,
    setInterval: () => ({ unref() {} }), setTimeout, clearTimeout, queueMicrotask,
  });
  vm.runInContext(source.slice(0, source.indexOf("app.whenReady()")), context);
  return { context, server: () => server!, quits };
}

test("#11 the engine uses the profile and cache folders Peel passes", () => {
  const { context } = engineMain({ PEEL_ENGINE_HOME: "/tmp/peel-custom-profile", PEEL_CACHE_DIR: "/tmp/peel-custom-cache" });
  expect(vm.runInContext("home", context)).toBe("/tmp/peel-custom-profile");
  expect(vm.runInContext("cacheDir", context)).toBe("/tmp/peel-custom-cache");
});

test("#10 a request cut off mid-body does not crash the engine, and the next request still works", async () => {
  const { context, server } = engineMain({});
  let unhandled: unknown;
  const observe = (error: unknown) => { unhandled = error; };
  process.on("unhandledRejection", observe);
  cleanup.push(() => process.removeListener("unhandledRejection", observe));
  context.serve({ webContents: { executeJavaScript: async () => ({ ready: true }) } }, "test-key");
  await once(server(), "listening");
  cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write("POST /call HTTP/1.1\r\nHost: 127.0.0.1\r\nx-peel-key: test-key\r\nContent-Length: 100\r\n\r\n{");
  await Bun.sleep(30);
  socket.destroy();
  await Bun.sleep(50);
  expect(unhandled).toBeUndefined();
  const state = await fetch(`http://127.0.0.1:${port}/state`, { headers: { "x-peel-key": "test-key" } });
  expect(state.status).toBe(200);
  expect((await state.json()).ready).toBe(true);
  const large = await fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: "x".repeat(9 * 1024 * 1024) }).catch(() => undefined);
  if (large) expect(large.status).toBe(413);
  expect(unhandled).toBeUndefined();
});

test("#18 a queue read that started before a removal does not bring removed songs back", async () => {
  const track = (id: string, queueIndex: number): Media => ({ ...song(id), queueIndex });
  let player = ["A", "B", "C"], held: ((page: Page) => void) | undefined;
  const deleted: string[] = [];
  const model = new Model(library(), {
    queuesItems: true, snapshot: async () => structuredClone(stopped),
    queue: async () => {
      if (!held) return new Promise<Page>(resolve => { held = resolve; });
      return { items: player.map((id, index) => track(id, index + 1)), more: false };
    },
    command: async (path: string) => { const place = Number(path.split("/").at(-1)); deleted.push(player[place - 1]!); player.splice(place - 1, 1); },
  } as any);
  model.connected = true; model.view = "queue"; model.items = player.map((id, index) => track(id, index + 1));
  // The read a song change starts, answered only after the removal.
  const old = (model as any).requeue();
  await model.removeQueued(0);
  expect(model.items.map(item => item.id)).toEqual(["B", "C"]);
  held!({ items: ["A", "B", "C"].map((id, index) => track(id, index + 1)), more: false });
  await old;
  expect(model.items.map(item => item.id)).toEqual(["B", "C"]);
  await model.removeQueued(0);
  expect(deleted).toEqual(["A", "B"]);
});

test("#19 a closing Peel releases the engine, which quits only when its last Peel has gone", async () => {
  const released: string[] = [];
  stopEngine({ release: async () => { released.push("release"); } } as unknown as Engine);
  expect(released).toEqual(["release"]);
  const { context, server, quits } = engineMain({ PEEL_OWNER: "101" });
  context.serve({ webContents: { executeJavaScript: async () => ({ ready: true }) } }, "test-key");
  await once(server(), "listening");
  cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  const send = (path: string, owner: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: path === "/state" ? "GET" : "POST", headers: { "x-peel-key": "test-key", "x-peel-owner": owner } });
  await send("/state", "202");
  await send("/release", "101");
  expect(quits.length).toBe(0);
  await send("/release", "202");
  expect(quits.length).toBe(1);
});

// cross-platform installs the engine from TypeScript and has no run.sh.
test.skipIf(!existsSync(new URL("../engine/run.sh", import.meta.url)))("#20 an engine download that stopped partway is replaced on the next start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-run-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), engine = join(dir, "engine");
  await mkdir(bin); await mkdir(engine);
  await writeFile(join(engine, "run.sh"), await readFile(new URL("../engine/run.sh", import.meta.url)), { mode: 0o755 });
  await writeFile(join(bin, "curl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\necho zip > "$out"\n', { mode: 0o755 });
  // UNPACK=fail writes the engine's executable, then stops before the rest, like an interrupted unpack.
  await writeFile(join(bin, "unzip"), '#!/bin/sh\nprintf \'#!/bin/sh\\necho ran\\n\' > electron; chmod +x electron\n[ "$UNPACK" = fail ] && exit 1\nprintf 44.5.1+wvcus > version\n', { mode: 0o755 });
  const start = (unpack: string) => {
    const run = Bun.spawnSync(["bash", join(engine, "run.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, UNPACK: unpack } });
    return { code: run.exitCode, output: run.stdout.toString().trim() };
  };
  expect(start("fail").code).not.toBe(0);
  expect(existsSync(join(engine, ".electron"))).toBe(false);
  expect(start("ok")).toEqual({ code: 0, output: "ran" });
  // An install from the old run.sh that has the executable but no version file is replaced too.
  await rm(join(engine, ".electron", "version"));
  await writeFile(join(engine, ".electron", "electron"), "#!/bin/sh\necho incomplete\n", { mode: 0o755 });
  expect(start("ok")).toEqual({ code: 0, output: "ran" });
});


test("the engine quits when the last Peel closes, even after an old SSH helper asked it to stay", async () => {
  const { context, server, quits } = engineMain({ PEEL_OWNER: "101" });
  context.serve({ webContents: { executeJavaScript: async () => ({ ready: true }) } }, "test-key");
  await once(server(), "listening"); cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  const send = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "x-peel-key": "test-key", "x-peel-owner": "101" } });
  expect((await send("/retain")).ok).toBe(true);
  expect(quits.length).toBe(0);
  await send("/release");
  expect(quits.length).toBe(1);
});

test("commands from different controllers finish in order on the host", async () => {
  const { context, server } = engineMain({});
  const completed: string[] = [];
  context.serve({ webContents: { executeJavaScript: async (source: string) => {
    if (source.includes(".enqueue(")) { await Bun.sleep(30); completed.push("enqueue"); }
    if (source.includes(".remove(")) completed.push("remove");
    return null;
  } } }, "test-key");
  await once(server(), "listening"); cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  const send = (method: string) => fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: JSON.stringify({ method, args: [] }) });
  const first = send("enqueue"); await Bun.sleep(5); const second = send("remove");
  await Promise.all([first, second]);
  expect(completed).toEqual(["enqueue", "remove"]);
});

test("status polling stays responsive while a host command is waiting", async () => {
  const { context, server } = engineMain({});
  let unblock!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  context.serve({ webContents: { executeJavaScript: async (source: string) => {
    if (source.includes(".enqueue(")) { await held; return null; }
    return { ready: true };
  } } }, "test-key");
  await once(server(), "listening"); cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  const command = fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: JSON.stringify({ method: "enqueue", args: [] }) });
  await Bun.sleep(5);
  try {
    const state = await fetch(`http://127.0.0.1:${port}/state`, { headers: { "x-peel-key": "test-key" }, signal: AbortSignal.timeout(1000) });
    expect((await state.json()).ready).toBe(true);
  } finally { unblock(); await command; }
});

// The engine's main process with a fake player page that records what it was asked to do.
function recovering() {
  const { context, server } = engineMain({});
  const done: string[] = [];
  let reloads = 0, release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const queue = { items: [{ id: "a" }, { id: "b" }, { id: "c" }], position: 1, added: [], time: 0, playing: false };
  context.serve({ loadURL: async () => { reloads++; done.push("reload"); }, webContents: { executeJavaScript: async (source: string) => {
    const call = source.match(/peelEngine\.(\w+)\(\.\.\.(.*)\)\s*:/s);
    if (!call) return;
    const [, method, args] = call;
    if (method === "state") return { ready: true };
    if (method === "exportPlayback") return structuredClone(queue);
    if (method === "slow") { await slow; return null; }
    done.push(`${method} ${args}`);
    return null;
  } } }, "test-key");
  const settle = async () => { for (let i = 0; i < 20; i++) await Bun.sleep(5); };
  return { context, server, done, reloads: () => reloads, settle, release: () => release() };
}

test("a failure to load audio reloads the player and continues the queue where it stopped", async () => {
  const app = recovering(); await once(app.server(), "listening"); cleanup.push(() => app.server().close());
  vm.runInContext("recover({ position: 1, time: 42 })", app.context);
  await app.settle();
  expect(app.done[0]).toBe("reload");
  const imported = JSON.parse(app.done.find(entry => entry.startsWith("importPlayback"))!.slice("importPlayback ".length))[0];
  expect(imported).toMatchObject({ position: 1, time: 42, playing: true, items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
});

test("a playback command since the failure wins, and the player reloads at most three times in ten minutes", async () => {
  const app = recovering(); await once(app.server(), "listening"); cleanup.push(() => app.server().close());
  const port = (app.server().address() as net.AddressInfo).port;
  // A slow command keeps the player busy, the failure arrives, then a pause arrives behind it.
  const busy = fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: JSON.stringify({ method: "slow", args: [] }) });
  await app.settle();
  vm.runInContext("recover({ position: 0, time: 10 })", app.context);
  const pause = fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: JSON.stringify({ method: "pause", args: [] }) });
  await app.settle(); app.release(); await busy; await pause; await app.settle();
  expect(app.reloads()).toBe(0);
  for (let attempt = 0; attempt < 4; attempt++) { vm.runInContext("recover({ position: 0, time: 10 })", app.context); await app.settle(); }
  expect(app.reloads()).toBe(3);
  expect(app.done.at(-1)).toContain("failed");
});

test("a player that stops answering is reloaded with the queue paused, and its old operation can never start the music", async () => {
  const { context, server } = engineMain({});
  vm.runInContext("stuckAfter = 50", context);
  // Each reload starts a new page. An operation from an old page that finishes later changes nothing.
  let page = 0, playing = false, finishOld!: () => void;
  const invoked: string[] = [];
  const old = new Promise<void>(resolve => { finishOld = resolve; });
  context.serve({ loadURL: async () => { page++; invoked.push("reload"); }, webContents: { executeJavaScript: async (source: string) => {
    const call = source.match(/peelEngine\.(\w+)\(\.\.\.(.*)\)\s*:/s);
    if (!call) return;
    const [, method, args] = call, mine = page;
    if (method === "state") return { ready: true };
    if (method === "exportPlayback") return { items: [{ id: "a" }, { id: "b" }], position: 1 };
    invoked.push(method === "importPlayback" ? `importPlayback cue=${JSON.parse(args)[0].cue}` : method);
    if (method === "play" && mine === 0) { await old; if (page === mine) playing = true; return null; }
    if (method === "pause") playing = false;
    if (method === "next") playing = true;
    return null;
  } } }, "test-key");
  await once(server(), "listening"); cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  const send = (method: string) => fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: JSON.stringify({ method, args: [] }) });
  const [play, next, pause] = [send("play"), send("next"), send("pause")];
  expect((await play).status).toBe(500);
  expect((await next).status).toBe(200);
  expect((await pause).status).toBe(200);
  finishOld();
  await Bun.sleep(20);
  expect(playing).toBe(false);
  expect(invoked).toEqual(["play", "reload", "volume", "importPlayback cue=true", "next", "pause"]);
});

test("a recovery whose reloaded player hangs is reloaded again with the queue paused, and later commands still run", async () => {
  const { context, server } = engineMain({});
  vm.runInContext("stuckAfter = 50", context);
  const invoked: string[] = [];
  context.serve({ loadURL: async () => { invoked.push("reload"); }, webContents: { executeJavaScript: async (source: string) => {
    const call = source.match(/peelEngine\.(\w+)\(\.\.\.(.*)\)\s*:/s);
    if (!call) return;
    const [, method, args] = call;
    if (method === "state") return { ready: true };
    if (method === "exportPlayback") return { items: [{ id: "a" }, { id: "b" }], position: 0 };
    const start = method === "importPlayback" ? JSON.parse(args)[0] : undefined;
    invoked.push(start ? `importPlayback playing=${start.playing} cue=${start.cue}` : method);
    // Starting the song again hangs, as it can when Apple's stream still fails.
    if (start?.playing) await new Promise(() => {});
    return null;
  } } }, "test-key");
  await once(server(), "listening"); cleanup.push(() => server().close());
  const port = (server().address() as net.AddressInfo).port;
  vm.runInContext("recover({ position: 1, time: 30 })", context);
  const pause = await fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "x-peel-key": "test-key" }, body: JSON.stringify({ method: "pause", args: [] }) });
  expect(pause.status).toBe(200);
  expect(invoked).toEqual(["reload", "volume", "importPlayback playing=true cue=undefined", "reload", "volume", "importPlayback playing=false cue=true", "pause"]);
});
