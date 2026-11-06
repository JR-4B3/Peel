// Regression tests for the bugs found in the review of 6 November 2026 (GitHub issues #6 to #11).
import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { saveJson } from "../src/config";
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

test("#7 rapid Next and Previous in repeat-one mode each move from where the last press landed", async () => {
  const { model, jumps } = setup();
  await Promise.all([model.skip(1), model.skip(1), model.skip(1)]);
  expect(jumps).toEqual([1, 2, 3]);
  await Promise.all([model.skip(-1), model.skip(1), model.skip(-1), model.skip(-1)]);
  expect(jumps.slice(3)).toEqual([2, 3, 2, 1]);
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
  const engineDir = new URL("../engine/", import.meta.url).pathname;
  const source = readFileSync(join(engineDir, "main.js"), "utf8");
  let server: http.Server | undefined;
  const app = { setPath() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => true, exit() {} };
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
    setInterval: () => ({ unref() {} }),
  });
  vm.runInContext(source.slice(0, source.indexOf("app.whenReady()")), context);
  return { context, server: () => server! };
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
