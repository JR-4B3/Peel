import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
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
    if (method === "queue") return Response.json({ position: 1, items: [{ id: "a", type: "songs", attributes: { name: "A", durationInMillis: 1000 } }, { id: "b", type: "songs", attributes: { name: "B" } }] });
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
  await expect(engine.command("/queue/move", { from: 0, to: 1 })).rejects.toThrow("no command");
});

test("a collection plays from the selected song with every loaded song queued", async () => {
  const { engine, calls } = await fakeEngine();
  await engine.playCollectionTrack({ id: "p.1", type: "library-playlists" }, [song("i.1"), song("i.2"), song("i.3")], 1);
  expect(calls[0]).toMatchObject({ method: "play", args: [[{ id: "i.1" }, { id: "i.2" }, { id: "i.3" }], 1] });
  expect(await engine.queuePosition()).toEqual({ position: 1, total: 2 });
  expect((await engine.queue()).items.map(item => [item.name, item.queueIndex])).toEqual([["A", 0], ["B", 1]]);
});

test("a restarted engine's new key is read again", async () => {
  const { engine, calls, write } = await fakeEngine();
  await engine.command("/playback/next");
  await write("second");
  await engine.command("/playback/previous");
  expect(calls.map(call => call.method)).toEqual(["next", "previous"]);
});
