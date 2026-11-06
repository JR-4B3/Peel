// Checks devices between two computers without touching either one's music: each side runs a
// stand-in engine on its own ports, finds the other by broadcast, pairs, and moves a queue.
//   on one computer:   bun scripts/verify-devices.ts wait
//   on the other:      bun scripts/verify-devices.ts pair
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceNetwork } from "../src/devices";
import { Engine } from "../src/engine";
import { DevicePlayer } from "../src/remote";

const role = process.argv[2];
if (role !== "wait" && role !== "pair") throw new Error("Use wait on one computer and pair on the other.");
const port = Number(process.env.VERIFY_PORT ?? 10780), discoveryPort = Number(process.env.VERIFY_DISCOVERY_PORT ?? 10781);
const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${role}: ${text}`);

const state = { items: [] as any[], position: 0, time: 0, playing: false, added: [] as number[] };
const engine = new Engine("/nonexistent", async (path, body: any) => {
  if (path === "/state") { const now = state.items[state.position]; return { ready: true, playback: { state: !now ? "stopped" : state.playing ? "playing" : "paused", nowPlaying: now ? { name: now.name, artistName: now.artist, playParams: { id: now.id } } : null, time: { currentTime: state.time, duration: 100 }, volume: 0.5, repeatMode: "none", shuffleMode: false } }; }
  if (path === "/release") return null;
  const { method, args = [] } = body;
  if (method === "pause") state.playing = false;
  if (method === "resume") state.playing = true;
  if (method === "exportPlayback") return { ...state };
  if (method === "importPlayback") Object.assign(state, args[0]);
  return null;
});
const dir = await mkdtemp(join(tmpdir(), "peel-verify-"));
const player = new DevicePlayer(undefined, () => {}, engine, async () => {});
const network = new DeviceNetwork({ local: player.localPlayer(), dir, name: `${hostname().split(".")[0]} check`, port, discoveryPort });
player.attach(network);
const until = async (predicate: () => boolean, what: string, seconds = 30) => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await Bun.sleep(100)) if (predicate()) return;
  throw new Error(`Timed out waiting for ${what}`);
};
try {
  await network.start();
  log(`device ${network.id.slice(0, 8)} listening on ${network.port}`);
  network.on("pairing", (pairing: any) => { log(`pairing request from ${pairing.name}, code ${pairing.code}`); pairing.accept(); });
  await until(() => network.views().some(device => !device.self && device.name.endsWith(" check")), "the other computer");
  const other = network.views().find(device => !device.self && device.name.endsWith(" check"))!;
  log(`found ${other.name} by broadcast`);
  if (role === "pair") {
    const pairing = network.pair(other.id);
    await until(() => pairing.state === "confirm", "the pairing code");
    log(`pairing code ${pairing.code}`);
    pairing.accept();
    await until(() => pairing.state === "done", "the other side to accept");
    await until(() => network.online(other.id), "a session");
    log("paired and connected");
    Object.assign(state, { items: [{ id: "1", type: "songs", name: "One", artist: "A", album: "X", duration: 100 }, { id: "2", type: "songs", name: "Two", artist: "A", album: "X", duration: 100 }], position: 1, time: 33, playing: true, added: [] });
    const started = performance.now();
    await player.playOn(other.id);
    const remote = await network.request(other.id, "/state");
    log(`moved in ${Math.round(performance.now() - started)} ms: ${remote.playback.nowPlaying.name} at ${remote.playback.time.currentTime}s, ${remote.playback.state} there, ${state.playing ? "playing" : "paused"} here`);
    if (remote.playback.nowPlaying.name !== "Two" || remote.playback.time.currentTime !== 33 || state.playing) throw new Error("The queue did not move as expected.");
    // The other side checks every tenth of a second, so the music stays there for a moment.
    await Bun.sleep(1000);
    await player.playOn(network.id);
    log(`moved back: ${state.items[state.position].name} at ${state.time}s, ${state.playing ? "playing" : "paused"} here`);
    if (!state.playing) throw new Error("The queue did not come back.");
    log("OK");
  } else {
    await until(() => network.online(other.id), "a session", 60);
    // Every device first claims itself at generation 0. The move raises the generation.
    await until(() => network.claim.device === network.id && network.claim.generation > 0, "the music to arrive", 30);
    log(`the music arrived: ${state.items[state.position]?.name} at ${state.time}s`);
    if (state.items[state.position]?.name !== "Two" || state.time !== 33) throw new Error("The queue arrived incomplete.");
    await until(() => network.claim.device !== network.id && !state.playing, "the music to leave", 30);
    log("the music left again. OK");
    await Bun.sleep(500);
  }
} finally { network.close(); await rm(dir, { recursive: true, force: true }); }
process.exit(0);
