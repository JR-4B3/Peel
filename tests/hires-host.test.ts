// Runs the real hi-res host against a simulated controller and Apple API. It never reaches
// Android or Apple. The simulated controller applies commands as Apple Music does, and each test
// can make it fail a command, ignore it, or drop the connection after applying it.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The host starts the controller through a shell script, which Windows cannot run.
const supported = process.platform !== "win32";

interface Item { queueId: number; id: string; title: string }
const android = {
  batch: 0, selected: 0, position: 0, state: 2, volume: 1, queue: [] as Item[],
  // What the next commands do instead of their usual effect.
  ignore: new Set<string>(), fail: new Set<string>(), dropAfter: new Set<string>(), partialAdd: false,
  // While above zero, a start stays buffering, as when Apple Music stops renewing its stream
  // lease. Each restart of Apple Music takes one off.
  stall: 0, restarts: 0,
  // While above zero, every sample of Android's stream is zero although Apple Music reports
  // playing. Each restart of Apple Music takes one off.
  silent: 0,
  // Like Apple Music, the controller ignores a list or addition of more songs than limit, and its
  // queue answer lists only the playing entry and the next view - 1. The host's window is the
  // same size in these tests.
  limit: 20, view: 8,
  // Songs Apple Music leaves out of a list or addition without a word, as it does with songs it
  // cannot play, and songs the catalog no longer has.
  drops: new Set<string>(), gone: new Set<string>(),
  // A state reply is split at this byte offset into two packets.
  splitAt: undefined as number | undefined,
  commands: [] as string[],
};
// The simulated pacat records zeros while this file exists.
const silence = (times: number) => {
  android.silent = Math.max(0, times);
  if (android.silent) writeFileSync(join(temporary, "silent"), ""); else rmSync(join(temporary, "silent"), { force: true });
};
function reset() {
  // Queue IDs keep counting, as Apple's do: a new queue never reuses an old entry's ID.
  Object.assign(android, { selected: 0, position: 0, state: 2, volume: 1, queue: [], partialAdd: false, splitAt: undefined, commands: [], stall: 0, restarts: 0 });
  silence(0);
  android.ignore.clear(); android.fail.clear(); android.dropAfter.clear(); android.drops.clear(); android.gone.clear();
}
const snapshot = () => {
  const item = android.queue[android.selected];
  return { state: android.state, position: android.position, item: item?.queueId ?? -1, id: item?.id, title: item?.title, duration: 300000 };
};
const batchOf = (ids: string[]) => { android.batch++; return ids.filter(id => !android.drops.has(id)).map((id, index) => ({ queueId: android.batch * 2 ** 32 + index, id, title: `Song ${id}` })); };

function apply(name: string, args: string[]): unknown {
  if (android.ignore.has(name)) return undefined;
  if (android.fail.has(name)) return { error: `simulated ${name} failure` };
  switch (name) {
    case "ping": return { ok: true };
    case "queue": return { queue: android.queue.slice(android.selected, android.selected + android.view) };
    case "list": if (args[1]!.split(",").length > android.limit) return undefined; android.queue = batchOf(args[1]!.split(",")); android.selected = Number(args[0]); android.position = 0; android.state = android.stall ? 6 : 3; break;
    case "restart": android.restarts++; android.stall = Math.max(0, android.stall - 1); silence(android.silent - 1); android.queue = []; android.selected = 0; android.state = 1; return { ok: true };
    case "add": {
      let ids = args[1]!.split(",");
      if (ids.length > android.limit) return undefined;
      if (android.partialAdd) ids = ids.slice(0, 1);
      android.queue.splice(args[0] === "end" ? android.queue.length : android.selected + 1, 0, ...batchOf(ids));
      break;
    }
    case "skip": { const at = android.queue.findIndex(item => item.queueId === Number(args[0])); if (at >= 0) { android.selected = at; android.position = 0; android.state = 3; } break; }
    case "seek": android.position = Number(args[0]); break;
    case "volume": android.volume = Number(args[0]); break;
    case "pause": android.state = 2; break;
    case "stop": android.state = 1; break;
    case "play": android.state = android.stall ? 6 : 3; break;
    case "next": if (android.selected + 1 < android.queue.length) { android.selected++; android.position = 0; } break;
  }
  return undefined;
}

let controller: Server, api: ReturnType<typeof Bun.serve>, host: ReturnType<typeof Bun.spawn>, temporary: string;
let port = 0, key = "";
const lookups: string[] = [];
async function send(path: string, body?: unknown, owner = process.pid, remote = false) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "x-peel-key": key, "x-peel-owner": String(owner), ...remote ? { "x-peel-remote": "1" } : {} },
  });
  return { status: response.status, body: await response.json() as any };
}
const call = (method: string, ...args: unknown[]) => send("/call", { method, args });
const song = (id: string, name = `Song ${id}`) => ({ id, type: "songs", name, artist: "Review", album: "Review", duration: 300 });
const play = async (...ids: string[]) => expect((await call("play", ids.map(id => song(id)), 0)).status).toBe(200);

beforeAll(async () => {
  if (!supported) return;
  temporary = await mkdtemp(join(tmpdir(), "peel-hires-host-"));
  controller = createServer(socket => {
    let buffer = "";
    socket.on("data", bytes => {
      buffer += bytes.toString();
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const command = line.slice(line.indexOf(" ") + 1);
        android.commands.push(command);
        const [name, ...args] = command.split(" ");
        const answer = apply(name!, args);
        if (android.dropAfter.delete(name!)) { socket.destroy(); return; }
        const reply = Buffer.from(JSON.stringify(answer ?? snapshot()) + "\n");
        if (name === "state" && android.splitAt !== undefined) {
          socket.write(reply.subarray(0, android.splitAt));
          setTimeout(() => socket.write(reply.subarray(android.splitAt!)), 20);
          continue;
        }
        socket.write(reply);
      }
    });
  });
  await new Promise<void>(resolve => controller.listen(0, "127.0.0.1", resolve));
  const controlPort = (controller.address() as any).port;
  // The catalog knows song 301, which the cover test plays without Peel queuing it.
  api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const url = new URL(request.url), path = url.pathname;
    lookups.push(path);
    // The catalog has every song asked for by ID, except the ones a test took out of it.
    if (path.endsWith("/v1/catalog/de/songs") && url.searchParams.has("ids")) {
      const ids = url.searchParams.get("ids")!.split(",").filter(id => !android.gone.has(id));
      return Response.json({ data: ids.map(id => ({ id, type: "songs", attributes: { name: `Song ${id}`, playParams: { id, kind: "song" } } })) });
    }
    if (/\/v1\/catalog\/de\/songs\/30[23]$/.test(path)) return new Response("unavailable", { status: 503 });
    if (path.endsWith("/v1/me/storefront")) return Response.json({ data: [{ id: "de", type: "storefronts" }] });
    if (path.endsWith("/v1/catalog/de/songs/301")) return Response.json({ data: [{ id: "301", type: "songs", attributes: { name: "Song 301", artistName: "Catalog", albumName: "Lookup", artwork: { url: "https://art.example/{w}x{h}.jpg" } } }] });
    return Response.json({ results: { songs: { data: [] } } });
  } });
  const cache = join(temporary, "cache");
  await mkdir(cache);
  await writeFile(join(cache, "apple-developer-token.json"), JSON.stringify({ token: "offline", expires: Date.now() + 7 * 86400000 }));
  // The simulated peel-hires records each call, answers `controller` with the controller's
  // address, and takes half a second to stop Android.
  const command = join(temporary, "controller"), log = join(temporary, "calls");
  await writeFile(command, [
    "#!/bin/sh",
    `echo "$*" >> '${log}'`,
    `[ "$1" = controller ] && printf '%s\\n' '{"host":"127.0.0.1","port":${controlPort},"key":"offline"}'`,
    `[ "$1 $2" = "session idle" ] && { /bin/sleep 0.5; echo stopped >> '${log}'; }`,
    "exit 0", "",
  ].join("\n"), { mode: 0o700 });
  // PulseAudio's tools, simulated: one playing Waydroid stream, recorded as zeros while Android is
  // silent and as music otherwise.
  await mkdir(join(temporary, "bin"));
  await writeFile(join(temporary, "bin", "pactl"), `#!/bin/sh\necho '[{"index":7,"corked":false,"sample_specification":"float32le 2ch 96000Hz","properties":{"application.name":"Waydroid"}}]'\n`, { mode: 0o700 });
  await writeFile(join(temporary, "bin", "pacat"), `#!/bin/sh\nif [ -e '${join(temporary, "silent")}' ]; then /usr/bin/head -c 96000 /dev/zero; else /usr/bin/head -c 96000 /dev/urandom; fi\nexec /bin/sleep 5\n`, { mode: 0o700 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  port = reservation.port!; reservation.stop(true);
  const home = join(temporary, "host");
  host = Bun.spawn([process.execPath, new URL("../src/hires.ts", import.meta.url).pathname, "--hires-host"], {
    env: { ...process.env, PEEL_HIRES_HOME: home, PEEL_HIRES_PORT: String(port), PEEL_HIRES_COMMAND: command,
      PEEL_CONFIG_DIR: join(temporary, "config"), PEEL_CACHE_DIR: cache, APPLE_MUSIC_USER_TOKEN: "offline", PEEL_HIRES_STALL_MS: "300", PEEL_HIRES_SILENCE_MS: "300", PEEL_HIRES_WINDOW: "20",
      APPLE_MUSIC_API_BASE: api.url.toString(), PEEL_OWNER: String(process.pid), PATH: join(temporary, "bin") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let attempt = 0; attempt < 200 && !key; attempt++) {
    try { key = (await Bun.file(join(home, "key.json")).json()).key; } catch { await Bun.sleep(25); }
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await send("/state")).body.ready) break;
    await Bun.sleep(25);
  }
});
afterAll(async () => {
  if (!supported) return;
  host.kill(); await host.exited;
  controller.close(); api.stop(true);
  await rm(temporary, { recursive: true, force: true });
});
beforeEach(() => { if (supported) reset(); });

test.skipIf(!supported)("an addition the controller ignores or applies only in part fails", async () => {
  await play("101", "102");
  android.ignore.add("add");
  const ignored = await call("enqueue", [song("103")], true);
  expect(ignored.status).toBe(500);
  expect(android.queue.map(item => item.id)).toEqual(["101", "102"]);
  android.ignore.clear();

  android.partialAdd = true;
  const partial = await call("enqueue", [song("104"), song("105")], true);
  expect(partial.status).toBe(500);
  expect(partial.body.error).toContain("1 of 2");
  // The song that arrived keeps its own metadata.
  const queue = (await call("queue")).body.items;
  expect(queue.find((item: any) => item.id === "104")?.attributes.name).toBe("Song 104");
  android.partialAdd = false;

  const complete = await call("enqueue", [song("106"), song("107")], true);
  expect(complete.status).toBe(200);
  expect(android.queue.map(item => item.id)).toContain("107");
}, 20000);

const longList = Array.from({ length: 60 }, (_, at) => String(1000 + at));

test.skipIf(!supported)("a list longer than Apple Music takes plays in parts, in order, to its end", async () => {
  // Clears songs added in earlier tests, which play would keep.
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  expect((await call("play", longList.map(id => song(id)), 30)).status).toBe(200);
  // Apple gets a window around the chosen song, small enough that it does not ignore it.
  expect(android.commands.filter(command => command.startsWith("list "))).toHaveLength(1);
  expect(android.queue).toHaveLength(20);
  expect(android.queue[android.selected]?.id).toBe("1030");
  // The queue lists the rest of the list, also the songs Apple does not list or has not got yet.
  const queue = (await call("queue")).body;
  expect(queue.items.map((item: any) => item.id)).toEqual(longList.slice(26));
  expect(queue.items[queue.position].id).toBe("1030");
  expect(queue.items.at(-1).attributes.name).toBe("Song 1059");

  // Next plays every song to the end, as the host adds the rest in parts.
  const played = ["1030"];
  for (let step = 0; step < 29; step++) {
    expect((await call("next")).status).toBe(200);
    played.push(android.queue[android.selected]!.id);
  }
  expect(played).toEqual(longList.slice(30));
  const parts = android.commands.filter(command => command.startsWith("add end "));
  expect(parts.length).toBeGreaterThan(0);
  expect(parts.every(command => command.split(" ")[2]!.split(",").length <= android.limit)).toBe(true);
  expect((await send("/state")).body.playback.nowPlaying.name).toBe("Song 1059");
}, 30000);

test.skipIf(!supported)("a long list moves to another device whole, and a song not sent yet plays when chosen", async () => {
  // An import, unlike play, keeps no songs added before.
  expect((await call("importPlayback", { items: longList.map(id => song(id)), position: 0, playing: true })).status).toBe(200);
  const exported = (await call("exportPlayback")).body;
  expect(exported.items.map((item: any) => item.id)).toEqual(longList);
  expect(exported.position).toBe(0);

  // A song Apple has queued but does not list yet plays from Apple's queue, and the songs before
  // it stay in the queue as history.
  expect((await call("jump", 15, "1015")).status).toBe(200);
  expect(android.queue[android.selected]?.id).toBe("1015");
  expect(android.commands.filter(command => command.startsWith("list "))).toHaveLength(1);
  let queue = (await call("queue")).body;
  expect(queue.items.map((item: any) => item.id)).toEqual(longList);
  expect(queue.position).toBe(15);

  expect((await call("jump", 50, "1050")).status).toBe(200);
  expect(android.queue[android.selected]?.id).toBe("1050");
  queue = (await call("queue")).body;
  expect(queue.items[queue.position].id).toBe("1050");
  expect(queue.items.at(-1).id).toBe("1059");
}, 30000);

test.skipIf(!supported)("a song added to a long list pushes none of its songs out of the queue", async () => {
  expect((await call("importPlayback", { items: longList.map(id => song(id)), position: 0, playing: true })).status).toBe(200);
  // The added song moves the last song Apple listed out of its answer.
  expect((await call("enqueue", [song("777")], true)).status).toBe(200);
  const queue = (await call("queue")).body.items.map((item: any) => item.id);
  expect(queue).toEqual(["1000", "777", ...longList.slice(1)]);
  expect((await call("position")).body).toEqual({ position: 0, total: 61 });
  expect((await call("exportPlayback")).body.items).toHaveLength(61);
}, 20000);

const ids = (items: any[]) => items.map(item => item.id);

test.skipIf(!supported)("a song the catalog no longer has stays out of Apple's list, so the chosen song plays", async () => {
  // Clears songs added in earlier tests, which play would keep.
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  android.gone.add("402"); android.drops.add("402");
  expect((await call("play", ["401", "402", "403", "404"].map(id => song(id)), 2)).status).toBe(200);
  expect(android.commands.filter(command => command.startsWith("list "))).toEqual(["list 1 401,403,404"]);
  expect(android.queue[android.selected]?.id).toBe("403");
  const queue = (await call("queue")).body;
  expect(ids(queue.items)).toEqual(["401", "403", "404"]);
  expect(queue.items[queue.position].id).toBe("403");
}, 20000);

test.skipIf(!supported)("a song Apple drops before the chosen one, although the catalog has it, still lets the chosen song play", async () => {
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  android.drops.add("412");
  expect((await call("play", ["411", "412", "413", "414", "415"].map(id => song(id)), 2)).status).toBe(200);
  // Apple's third entry is 414, so the list starts again at 413.
  expect(android.commands.filter(command => command.startsWith("list "))).toEqual(["list 2 411,412,413,414,415", "list 0 413,414,415"]);
  expect(android.queue[android.selected]?.id).toBe("413");
  const queue = (await call("queue")).body;
  expect(ids(queue.items)).toEqual(["413", "414", "415"]);
  expect(queue.items[queue.position].id).toBe("413");
}, 20000);

test.skipIf(!supported)("a list starts without a search for each lost song, and says when the chosen one cannot play", async () => {
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  android.gone.add("432"); android.gone.add("434");
  lookups.length = 0;
  expect((await call("play", ["431", "432", "433", "434", "435"].map(id => song(id)), 0)).status).toBe(200);
  // Only the chosen song may wait on a search. The lost songs are left out and looked up later.
  expect(android.commands.filter(command => command.startsWith("list "))).toEqual(["list 0 431,433,435"]);
  expect((await send("/state")).body.playback.error).toBeUndefined();

  // The catalog search finds no match for a chosen song it lost, so the next song plays and Peel says why.
  expect((await call("play", ["431", "432", "433"].map(id => song(id)), 1)).status).toBe(200);
  expect(android.queue[android.selected]?.id).toBe("433");
  expect((await send("/state")).body.playback.error).toBe('Hi-res cannot play "Song 432", because Apple\'s catalog no longer has it or did not answer. The next song plays.');
}, 20000);

test.skipIf(!supported)("a library song whose catalog ID is gone plays under its second ID", async () => {
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  android.gone.add("452");
  lookups.length = 0;
  const items = [song("451"), { ...song("i.452", "Song 452"), catalogId: "452", reportingId: "9452" }, song("453")];
  expect((await call("play", items, 1)).status).toBe(200);
  expect(android.commands.filter(command => command.startsWith("list "))).toEqual(["list 1 451,9452,453"]);
  expect(android.queue[android.selected]?.id).toBe("9452");
  expect(lookups.some(path => path.endsWith("/search"))).toBe(false);
  const state = (await send("/state")).body.playback;
  // Peel knows the playing song as its own library song, so its heart and queue entry are right.
  expect(state.nowPlaying.playParams.id).toBe("i.452");
  expect(state.error).toBeUndefined();
}, 20000);

test.skipIf(!supported)("a catalog answer without any of ten songs counts as no answer, so the list still plays", async () => {
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  const tens = Array.from({ length: 10 }, (_, at) => String(461 + at));
  for (const id of tens) android.gone.add(id);
  expect((await call("play", tens.map(id => song(id)), 3)).status).toBe(200);
  expect(android.commands.filter(command => command.startsWith("list "))).toEqual([`list 3 ${tens.join(",")}`]);
  expect(android.queue[android.selected]?.id).toBe("464");
}, 20000);

test.skipIf(!supported)("a song Apple drops after the chosen one leaves the later songs in their places", async () => {
  await call("importPlayback", { items: [song("999")], playing: true });
  android.commands = [];
  android.drops.add("423");
  expect((await call("play", ["421", "422", "423", "424", "425"].map(id => song(id)), 0)).status).toBe(200);
  const queue = (await call("queue")).body;
  expect(ids(queue.items)).toEqual(["421", "422", "424", "425"]);
  expect((await call("position")).body).toEqual({ position: 0, total: 4 });
  expect((await call("jump", 2, "424")).status).toBe(200);
  expect(android.queue[android.selected]?.id).toBe("424");
  expect((await send("/state")).body.playback.nowPlaying.name).toBe("Song 424");
}, 20000);

test.skipIf(!supported)("a dropped connection after an addition or a skip applies it once", async () => {
  await play("101", "102", "103");
  android.dropAfter.add("add");
  const added = await call("enqueue", [song("105")], true);
  expect(added.status).toBe(200);
  expect(android.queue.filter(item => item.id === "105")).toHaveLength(1);
  const queue = (await call("queue")).body.items;
  expect(queue.every((item: any) => item.id)).toBe(true);

  android.dropAfter.add("next");
  const before = android.selected;
  expect((await call("next")).status).toBe(200);
  expect(android.selected).toBe(before + 1);
  expect(android.commands.filter(command => command === "next")).toHaveLength(1);

  // A new queue whose answer is lost is not sent again: Apple's state shows it started.
  android.commands = [];
  android.dropAfter.add("list");
  expect((await call("play", [song("201"), song("202")], 0)).status).toBe(200);
  expect(android.commands.filter(command => command.startsWith("list"))).toHaveLength(1);
  expect(android.queue[android.selected]?.id).toBe("201");
}, 20000);

test.skipIf(!supported)("a failed paused import stays silent", async () => {
  await play("101", "102");
  android.fail.add("seek");
  const failed = await call("importPlayback", { items: [song("103")], time: 30, playing: false });
  expect(failed.status).toBe(500);
  // Paused, then the volume returned, since the pause is confirmed.
  expect(android.state).toBe(2);
  expect(android.volume).toBe(1);
  android.fail.clear();

  // Neither pause nor stop works: the volume stays off.
  android.fail.add("seek"); android.ignore.add("pause"); android.ignore.add("stop");
  const muted = await call("importPlayback", { items: [song("104")], time: 30, playing: true });
  expect(muted.status).toBe(500);
  expect(android.volume).toBe(0);
  android.fail.clear(); android.ignore.clear();
  // The next playback command that works brings the volume back.
  expect((await call("pause")).status).toBe(200);
  expect(android.volume).toBe(1);
}, 30000);

test.skipIf(!supported)("a failed repeat after a paused import leaves it paused and silent", async () => {
  android.fail.add("repeat");
  const failed = await call("importPlayback", { items: [song("101")], playing: false, repeatMode: "all" });
  expect(failed.status).toBe(500);
  expect(android.state).not.toBe(3);
}, 20000);

test.skipIf(!supported)("an imported song that is not in the catalog does not pass its time on", async () => {
  const missing = { ...song("i.missing"), name: "Missing recording" };
  const skipped = await call("importPlayback", { items: [missing, song("104")], position: 0, time: 123, playing: true });
  expect(skipped.status).toBe(200);
  expect(android.queue[android.selected]?.id).toBe("104");
  expect(android.position).toBe(0);

  const kept = await call("importPlayback", { items: [missing, song("104")], position: 1, time: 123, playing: true });
  expect(kept.status).toBe(200);
  expect(android.position).toBe(123000);
}, 20000);

test.skipIf(!supported)("characters split between packets arrive whole", async () => {
  for (const title of ["Café", "日本の歌", "Song 🎵"]) {
    await play("101");
    android.queue[android.selected]!.title = title;
    const reply = Buffer.from(JSON.stringify(snapshot()));
    const start = reply.indexOf(Buffer.from(title)), length = Buffer.byteLength(title);
    for (let at = start + 1; at < start + length; at++) {
      android.splitAt = at;
      expect((await send("/state")).body.playback.nowPlaying.name).toBe(title);
    }
    android.splitAt = undefined;
  }
}, 30000);

test.skipIf(!supported)("a start that stays buffering restarts Apple Music once and continues, and a second stall pauses", async () => {
  // Peel reads the state every second, and the host notices the stall from it.
  const poll = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 150 && !done(); attempt++) { await send("/state"); await Bun.sleep(20); }
    expect(done()).toBe(true);
  };
  android.stall = 1;
  await play("101", "102");
  expect(android.state).toBe(6);
  await poll(() => android.restarts === 1 && android.state === 3);
  expect(android.queue[android.selected]?.id).toBe("101");
  expect(android.queue.map(item => item.id)).toEqual(["101", "102"]);

  // It stalls again after the restart: the host pauses and says so, and restarts no more.
  android.stall = 2;
  await play("103");
  await poll(() => android.state === 2);
  expect(android.restarts).toBe(2);
  expect((await send("/state")).body.playback.error).toContain("stopped streaming");
  await Bun.sleep(500); await send("/state");
  expect(android.restarts).toBe(2);
}, 20000);

test.skipIf(!supported)("a song that plays silent restarts Apple Music once and continues, and silence again soon after only says so", async () => {
  const poll = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 150 && !done(); attempt++) { await send("/state"); await Bun.sleep(20); }
    expect(done()).toBe(true);
  };
  const listen = async () => { for (let attempt = 0; attempt < 40; attempt++) { await send("/state"); await Bun.sleep(20); } };
  await play("501", "502");
  // The host does not check the first seconds of a song.
  silence(1); android.position = 1000; await listen();
  expect(android.restarts).toBe(0);
  // Music that sounds changes nothing.
  silence(0); android.position = 60000; await listen();
  expect(android.restarts).toBe(0);

  // The host restarts Apple Music, which continues the song where it was.
  silence(1);
  await poll(() => android.restarts === 1 && android.state === 3 && android.position === 60000);
  expect(android.queue[android.selected]?.id).toBe("501");
  expect(android.queue.map(item => item.id)).toEqual(["501", "502"]);
  await listen();
  expect(android.restarts).toBe(1);

  // Silent again within a minute: the host says so and keeps playing, without another restart.
  silence(1);
  let error = "";
  for (let attempt = 0; attempt < 150 && !error.includes("silent"); attempt++) { error = (await send("/state")).body.playback?.error ?? ""; await Bun.sleep(20); }
  expect(error).toContain("silent, also after a restart");
  expect(android.restarts).toBe(1);
  expect(android.state).toBe(3);
}, 20000);

test.skipIf(!supported)("a song Apple Music plays that Peel did not queue gets its cover from the catalog", async () => {
  // As after a restart of the host: Apple Music plays on from a queue this host never saw.
  android.queue = batchOf(["301"]); android.selected = 0; android.state = 3;
  let song: any;
  for (let attempt = 0; attempt < 100 && !song?.artwork?.url; attempt++) { song = (await send("/state")).body.playback.nowPlaying; await Bun.sleep(20); }
  expect(song).toMatchObject({ name: "Song 301", artwork: { url: "https://art.example/{w}x{h}.jpg" }, playParams: { id: "301" } });
  const looked = (id: string) => lookups.filter(path => path.endsWith(`/songs/${id}`)).length;
  expect(looked("301")).toBe(1);

  // A later placeholder of the same song gets the cover without asking again.
  android.queue = batchOf(["301"]); android.selected = 0;
  song = (await send("/state")).body.playback.nowPlaying;
  expect(song.artwork.url).toBe("https://art.example/{w}x{h}.jpg");
  expect(looked("301")).toBe(1);

  // Songs whose lookup fails are asked for once each, also while they alternate.
  for (let round = 0; round < 6; round++) {
    android.queue = batchOf([round % 2 ? "303" : "302"]); android.selected = 0;
    await send("/state"); await Bun.sleep(30);
  }
  expect([looked("302"), looked("303")]).toEqual([1, 1]);
}, 20000);

const calls = async () => (await readFile(join(temporary, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);

test.skipIf(!supported)("the last Peel on this computer closing pauses the music while a Peel controlling it over SSH stays, and Android keeps running", async () => {
  const helper = Bun.spawn(["sleep", "30"]);
  const stops = async () => (await calls()).filter(call => call === "session idle").length, earlier = await stops();
  try {
    await send("/state", undefined, helper.pid, true);
    await play("401");
    expect(android.state).toBe(3);
    await send("/release", {});
    for (let attempt = 0; attempt < 100 && android.state !== 2; attempt++) await Bun.sleep(20);
    expect(android.state).toBe(2);
    expect(await Promise.race([host.exited, Bun.sleep(500).then(() => "running")])).toBe("running");
    expect(await stops()).toBe(earlier);
    // The remote Peel can start the music again.
    expect((await send("/call", { method: "resume", args: [] }, helper.pid, true)).status).toBe(200);
    expect(android.state).toBe(3);
  } finally {
    await send("/state");
    // A remote Peel that leaves while a Peel on this computer stays changes nothing.
    await send("/release", {}, helper.pid, true);
    helper.kill();
  }
  await Bun.sleep(1200);
  expect(android.state).toBe(3);
}, 20000);

test.skipIf(!supported)("a Peel that attaches while Android stops plays after Android starts again", async () => {
  await send("/release", {});
  for (let attempt = 0; attempt < 100 && !(await calls()).includes("session idle"); attempt++) await Bun.sleep(20);
  const before = (await calls()).length;
  // Attaches and plays while Android is still stopping.
  await play("201");
  const after = (await calls()).slice(before - 1);
  expect(after.indexOf("stopped")).toBeGreaterThanOrEqual(0);
  expect(after.indexOf("controller")).toBeGreaterThan(after.indexOf("stopped"));
  expect(android.queue.map(item => item.id)).toEqual(["201"]);
  expect(await Promise.race([host.exited, Bun.sleep(1500).then(() => "running")])).toBe("running");
}, 20000);

test.skipIf(!supported)("the state reports the rate of Android's stream in PipeWire", async () => {
  expect((await call("play", ["501", "502"].map(id => song(id)), 0)).status).toBe(200);
  // The controller switches the rate about a second after a song starts, so the host reads it later.
  // The simulated pactl reports Android's stream at 96 kHz.
  let state: any;
  for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(250)) {
    state = (await send("/state")).body;
    if (state.playback?.sampleRate) break;
  }
  expect(state.playback.sampleRate).toBe(96000);
}, 20000);

// Last: the host exits at the end.
test.skipIf(!supported)("a Peel that attaches while the last one leaves keeps the host and Android", async () => {
  const other = Bun.spawn(["sleep", "30"]);
  const stops = async () => (await calls()).filter(call => call === "session idle").length, earlier = await stops();
  try {
    await Promise.all([send("/release", {}), send("/retain", undefined, other.pid)]);
    expect(await Promise.race([host.exited, Bun.sleep(1000).then(() => "running")])).toBe("running");
    expect(await stops()).toBe(earlier);
    // The last Peel leaves: the music pauses, Android stops, and the host exits.
    android.state = 3;
    await send("/release", {}, other.pid);
    expect(await Promise.race([host.exited, Bun.sleep(3000).then(() => "running")])).toBe(0);
    expect(android.state).toBe(2);
    expect(await stops()).toBe(earlier + 1);
  } finally { other.kill(); }
}, 20000);
