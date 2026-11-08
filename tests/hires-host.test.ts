// Runs the real hi-res host against a simulated controller and Apple API. It never reaches
// Android or Apple. The simulated controller applies commands as Apple Music does, and each test
// can make it fail a command, ignore it, or drop the connection after applying it.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
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
  // A state reply is split at this byte offset into two packets.
  splitAt: undefined as number | undefined,
  commands: [] as string[],
};
function reset() {
  // Queue IDs keep counting, as Apple's do: a new queue never reuses an old entry's ID.
  Object.assign(android, { selected: 0, position: 0, state: 2, volume: 1, queue: [], partialAdd: false, splitAt: undefined, commands: [], stall: 0, restarts: 0 });
  android.ignore.clear(); android.fail.clear(); android.dropAfter.clear();
}
const snapshot = () => {
  const item = android.queue[android.selected];
  return { state: android.state, position: android.position, item: item?.queueId ?? -1, id: item?.id, title: item?.title, duration: 300000 };
};
const batchOf = (ids: string[]) => { android.batch++; return ids.map((id, index) => ({ queueId: android.batch * 2 ** 32 + index, id, title: `Song ${id}` })); };

function apply(name: string, args: string[]): unknown {
  if (android.ignore.has(name)) return undefined;
  if (android.fail.has(name)) return { error: `simulated ${name} failure` };
  switch (name) {
    case "ping": return { ok: true };
    case "queue": return { queue: android.queue.slice(android.selected) };
    case "list": android.queue = batchOf(args[1]!.split(",")); android.selected = Number(args[0]); android.position = 0; android.state = android.stall ? 6 : 3; break;
    case "restart": android.restarts++; android.stall = Math.max(0, android.stall - 1); android.queue = []; android.selected = 0; android.state = 1; return { ok: true };
    case "add": {
      let ids = args[1]!.split(",");
      if (android.partialAdd) ids = ids.slice(0, 1);
      android.queue.splice(android.selected + 1, 0, ...batchOf(ids));
      break;
    }
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
async function send(path: string, body?: unknown, owner = process.pid) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "x-peel-key": key, "x-peel-owner": String(owner) },
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
  api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ results: { songs: { data: [] } } }) });
  const cache = join(temporary, "cache");
  await mkdir(cache);
  await writeFile(join(cache, "apple-developer-token.json"), JSON.stringify({ token: "offline", expires: Date.now() + 7 * 86400000 }));
  // The simulated peel-hires records each call, and answers `controller` with the controller's address.
  const command = join(temporary, "controller");
  await writeFile(command, `#!/bin/sh\necho "$*" >> '${join(temporary, "calls")}'\n[ "$1" = controller ] && printf '%s\\n' '{"host":"127.0.0.1","port":${controlPort},"key":"offline"}'\nexit 0\n`, { mode: 0o700 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  port = reservation.port!; reservation.stop(true);
  const home = join(temporary, "host");
  host = Bun.spawn([process.execPath, new URL("../src/hires.ts", import.meta.url).pathname, "--hires-host"], {
    env: { ...process.env, PEEL_HIRES_HOME: home, PEEL_HIRES_PORT: String(port), PEEL_HIRES_COMMAND: command,
      PEEL_CONFIG_DIR: join(temporary, "config"), PEEL_CACHE_DIR: cache, APPLE_MUSIC_USER_TOKEN: "offline", PEEL_HIRES_STALL_MS: "300",
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

// Last: the host exits at the end.
test.skipIf(!supported)("a Peel that attaches while the last one leaves keeps the host and Android", async () => {
  const calls = async () => (await readFile(join(temporary, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const other = Bun.spawn(["sleep", "30"]);
  try {
    await Promise.all([send("/release", {}), send("/retain", undefined, other.pid)]);
    expect(await Promise.race([host.exited, Bun.sleep(1000).then(() => "running")])).toBe("running");
    expect(await calls()).not.toContain("session idle");
    // The last Peel leaves: the music pauses, Android stops, and the host exits.
    android.state = 3;
    await send("/release", {}, other.pid);
    expect(await Promise.race([host.exited, Bun.sleep(3000).then(() => "running")])).toBe(0);
    expect(android.state).toBe(2);
    expect(await calls()).toContain("session idle");
  } finally { other.kill(); }
}, 20000);
