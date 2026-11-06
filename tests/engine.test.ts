import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, engineVersion } from "../src/engine";
import { stopped, type Media } from "../src/types";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

// A fake engine with the real interface: a key header, /state, and /call by method name.
async function fakeEngine() {
  const home = await mkdtemp(join(tmpdir(), "peel-engine-")); cleanup.push(() => rm(home, { recursive: true }));
  const calls: { method: string; args: unknown[] }[] = [];
  let key = "first";
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.headers.get("x-peel-key") !== key) return Response.json({ error: "Wrong engine key" }, { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json({ ready: true, signIn: false, playback: { ...stopped, volume: 0.5 } });
    const { method, args } = await request.json();
    calls.push({ method, args });
    if (method === "queue") return Response.json({ position: 1, items: [{ id: "a", type: "songs", attributes: { name: "A", durationInMillis: 1000 } }, { id: "b", type: "songs", attributes: { name: "B" } }, { id: "c", type: "songs", added: true, attributes: { name: "C" } }] });
    return Response.json(null);
  } });
  cleanup.push(() => server.stop(true));
  const write = (value: string) => { key = value; return writeFile(join(home, "key.json"), JSON.stringify({ port: server.port, key })); };
  await write("first");
  return { engine: new Engine(home), calls, write };
}

const song = (id: string, type = "library-songs"): Media => ({ id, type, name: id, artist: "Artist", album: "Album", duration: 100 });

test("the engine client maps Peel's controls to engine methods", async () => {
  const { engine, calls } = await fakeEngine();
  expect((await engine.snapshot()).volume).toBe(0.5);
  await engine.command("/playback/toggle");
  await engine.command("/playback/seek", { position: 42 });
  await engine.command("/audio/volume", { volume: 0.3 }, "PATCH");
  await engine.command("/queue/jump", { index: 2 });
  await engine.command("/library/now-playing/rating", { rating: 1 }, "PUT");
  await engine.command("/library/now-playing/rating", {}, "DELETE");
  expect(calls.map(call => [call.method, ...call.args])).toEqual([["toggle"], ["seek", 42], ["volume", 0.3], ["jump", 2], ["rate", 1], ["rate", 0]]);
  await engine.command("/queue/move", { from: 3, to: 1 });
  await engine.command("/queue/items/4", undefined, "DELETE");
  expect(calls.slice(-2).map(call => [call.method, ...call.args])).toEqual([["move", 3, 1], ["remove", 4]]);
  await expect(engine.command("/queue/clear")).rejects.toThrow("no command");
});

test("a collection plays from the selected song with every loaded song queued", async () => {
  const { engine, calls } = await fakeEngine();
  await engine.playCollectionTrack({ id: "p.1", type: "library-playlists" }, [song("i.1"), song("i.2"), song("i.3")], 1);
  expect(calls[0]).toMatchObject({ method: "play", args: [[{ id: "i.1" }, { id: "i.2" }, { id: "i.3" }], 1] });
  expect(await engine.queuePosition()).toEqual({ position: 1, total: 3 });
});

test("the queue lists only the songs the listener added, at their places in the player's queue", async () => {
  const { engine } = await fakeEngine();
  expect((await engine.queue()).items.map(item => [item.name, item.queueIndex])).toEqual([["C", 2]]);
});

// Runs engine/engine.js against a stand-in for MusicKit's queue.
async function musicKit() {
  const listeners: Record<string, () => unknown> = {};
  const entry = (item: { id: string }) => ({ id: item.id, type: "songs", title: item.id });
  const music: any = {
    isAuthorized: true, volume: 0.5, items: [] as any[], position: -1,
    get queue() { return { items: music.items, position: music.position, spliceQueueItems: (at: number, count: number, entries: any[] = []) => music.items.splice(at, count, ...entries) }; },
    addEventListener() {},
    async setQueue({ items, startWith = 0 }: any) { music.items = items.map(entry); music.position = startWith; },
    async playAt(at: number, { items }: any) { music.items.splice(at, 0, ...items.map(entry)); },
    async changeToMediaAtIndex(index: number) { music.position = index; },
  };
  const window: any = { peel: { token: "t", volume: 0.5 } };
  const document = { addEventListener: (name: string, fn: () => unknown) => { listeners[name] = fn; }, createElement: () => ({ dataset: {} }), head: { append() {} } };
  const MusicKit = { configure: async () => music };
  new Function("window", "document", "MusicKit", "console", await Bun.file(new URL("../engine/engine.js", import.meta.url)).text())(window, document, MusicKit, { log() {} });
  await listeners.musickitloaded!();
  const engine = window.peelEngine;
  const queued = () => engine.queue().items.filter((item: any) => item.added).map((item: any) => item.id);
  return { engine, music, queued };
}

test("added songs wait after the playing song, apart from the rest of the collection", async () => {
  const { engine, music, queued } = await musicKit();
  await engine.play([song("c1"), song("c2"), song("c3")], 0);
  expect(queued()).toEqual([]);
  await engine.enqueue([song("a1")], false);
  await engine.enqueue([song("a2")], false);
  await engine.enqueue([song("n1")], true);
  expect(music.items.map((item: any) => item.id)).toEqual(["c1", "n1", "a1", "a2", "c2", "c3"]);
  expect(queued()).toEqual(["n1", "a1", "a2"]);
  // A song that has started playing leaves the queue.
  await engine.jump(1);
  expect(queued()).toEqual(["a1", "a2"]);
  // Starting another collection keeps the added songs that have not played.
  await engine.play([song("d1"), song("d2")], 1);
  expect(music.items.map((item: any) => item.id)).toEqual(["d1", "d2", "a1", "a2"]);
  expect(queued()).toEqual(["a1", "a2"]);
});

test("queued songs move and leave the queue, and the playing song stays put", async () => {
  const { engine, music, queued } = await musicKit();
  await engine.play([song("c1"), song("c2")], 0);
  await engine.enqueue([song("a1"), song("a2"), song("a3")], false);
  engine.move(3, 1);
  expect(queued()).toEqual(["a3", "a1", "a2"]);
  engine.move(1, 2);
  expect(queued()).toEqual(["a1", "a3", "a2"]);
  engine.remove(2);
  expect(music.items.map((item: any) => item.id)).toEqual(["c1", "a1", "a2", "c2"]);
  engine.move(1, 0);
  engine.remove(0);
  expect(music.items.map((item: any) => item.id)).toEqual(["c1", "a1", "a2", "c2"]);
});

test("a restarted engine's new key is read again", async () => {
  const { engine, calls, write } = await fakeEngine();
  await engine.command("/playback/next");
  await write("second");
  await engine.command("/playback/previous");
  expect(calls.map(call => call.method)).toEqual(["next", "previous"]);
});

test("the engine reads and changes a library favourite through its library ID despite a catalog link", async () => {
  const { engine, music } = await musicKit();
  music.nowPlayingItem = { id: "i.creep", title: "Creep", artistName: "fakemink", playParams: { catalogId: "catalog.creep" } };
  let value = 1;
  const paths: string[] = [];
  music.api = { music: async (path: string, _query: unknown, options?: any) => {
    paths.push(path);
    if (options?.fetchOptions) {
      value = options.fetchOptions.method === "DELETE" ? 0 : 1;
      return {};
    }
    return { data: { data: path.endsWith("library-songs") && value ? [{ attributes: { value } }] : [] } };
  } };
  expect(await engine.rating()).toBe(1);
  await engine.rate(0, "i.creep");
  expect(await engine.rating()).toBe(0);
  expect(engine.state().playback.nowPlaying.inFavorites).toBe(false);
  await engine.rate(1, "i.creep");
  expect(await engine.rating()).toBe(1);
  expect(engine.state().playback.nowPlaying.inFavorites).toBe(true);
  expect(paths.every(path => path.startsWith("/v1/me/ratings/library-songs"))).toBe(true);
});

test("Peel hashes the engine's files the way the engine does", async () => {
  const { createHash } = await import("node:crypto");
  const read = (name: string) => Bun.file(new URL(`../engine/${name}`, import.meta.url)).bytes();
  const expected = createHash("sha256").update(await read("engine.js")).update(await read("main.js")).digest("hex");
  expect(await engineVersion()).toBe(expected);
});

test("the engine rates only the song Peel names, so a song that changed in between is not rated", async () => {
  const { engine, music } = await musicKit();
  const rated: string[] = [];
  music.nowPlayingItem = { id: "i.now", attributes: {} };
  music.api = { music: async (path: string) => { rated.push(path); return { data: { data: [] } }; } };
  await expect(engine.rate(1, "i.other")).rejects.toThrow("changed");
  expect(rated).toEqual([]);
  await engine.rate(1, "i.now");
  expect(rated).toEqual(["/v1/me/ratings/library-songs/i.now"]);
});

test("the engine switches MusicKit's stream between 256 and 64 kbps", async () => {
  const { engine, music } = await musicKit();
  expect(engine.quality("standard")).toBe(64);
  expect(music.bitrate).toBe(64);
  expect(engine.quality("high")).toBe(256);
});


test("a stale queue removal or move cannot edit another controller's song", async () => {
  const { engine, music } = await musicKit();
  await engine.play([song("c1"), song("c2")], 0);
  await engine.enqueue([song("a1"), song("a2")], false);
  engine.remove(1, "a1");
  expect(() => engine.remove(1, "a1")).toThrow("queue changed");
  expect(() => engine.move(1, 2, "a1", "c2")).toThrow("queue changed");
  expect(music.items.map((item: any) => item.id)).toEqual(["c1", "a2", "c2"]);
});

test("a stale queue click refuses to jump to a different song", async () => {
  const { engine, music } = await musicKit();
  await engine.play([song("c1"), song("c2")], 0);
  await engine.enqueue([song("a1"), song("a2")], false);
  engine.remove(1, "a1");
  await expect(engine.jump(2, "a2")).rejects.toThrow("queue changed");
  expect(music.position).toBe(0);
  await engine.jump(1, "a2");
  expect(music.items[music.position].id).toBe("a2");
});

test("a queue exported on one engine plays on another at the same song and position", async () => {
  const source = await musicKit(), target = await musicKit();
  await source.engine.play([song("c1"), song("c2"), song("c3")], 1);
  await source.engine.enqueue([song("a1")], true);
  source.music.currentPlaybackTime = 73; source.music.playbackState = 2; source.music.repeatMode = 2;
  const exported = source.engine.exportPlayback();
  expect(exported).toMatchObject({ position: 1, added: [2], time: 73, playing: true, repeatMode: "all" });
  expect(exported.items.map((item: any) => item.id)).toEqual(["c1", "c2", "a1", "c3"]);
  // The target had its own queue and added songs. They do not survive the move.
  await target.engine.play([song("x1")], 0);
  await target.engine.enqueue([song("x2")], false);
  const calls: string[] = [];
  Object.assign(target.music, {
    volume: 0.8, repeatMode: 0, shuffleMode: 0,
    play: async () => { calls.push(`play ${target.music.volume}`); target.music.playbackState = 2; },
    pause: async () => { calls.push("pause"); target.music.playbackState = 3; },
    seekToTime: async (time: number) => { calls.push(`seek ${time}`); },
  });
  await target.engine.importPlayback(JSON.parse(JSON.stringify(exported)));
  expect(target.music.items.map((item: any) => item.id)).toEqual(["c1", "c2", "a1", "c3"]);
  expect(target.music.position).toBe(1);
  expect(target.queued()).toEqual(["a1"]);
  expect(target.music.repeatMode).toBe(2);
  expect(calls).toEqual(["play 0.8", "seek 73"]);
  // A paused queue reaches its position muted and stays paused, at this engine's own volume.
  calls.length = 0;
  await target.engine.importPlayback({ ...exported, playing: false });
  expect(calls).toEqual(["play 0", "seek 73", "pause"]);
  expect(target.music.volume).toBe(0.8);
});

test("an import that fails partway leaves the engine paused at its own volume", async () => {
  const { engine, music } = await musicKit();
  let playing = false;
  Object.assign(music, { volume: 0.7, play: async () => { playing = true; }, pause: async () => { playing = false; }, seekToTime: async () => { throw new Error("seek failed"); } });
  await expect(engine.importPlayback({ items: [song("c1")], position: 0, time: 30, playing: true })).rejects.toThrow("seek failed");
  expect(playing).toBe(false);
  await expect(engine.importPlayback({ items: [song("c1")], position: 0, time: 30, playing: false })).rejects.toThrow("seek failed");
  expect(playing).toBe(false);
  expect(music.volume).toBe(0.7);
});
