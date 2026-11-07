import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { DeviceNetwork, allowedRequest, newer, onLocalNetwork, ownAddresses } from "../src/devices";
import { Engine } from "../src/engine";
import { Cipher, Ephemeral, clientFinish, clientHello, commitment, newGroupKey, pairingKeys, type PairOffer } from "../src/link";
import { Model } from "../src/model";
import { DevicePlayer } from "../src/remote";
import { defaults } from "../src/config";
import { PeelUI } from "../src/ui";
import { fixture } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function waitFor(predicate: () => boolean, what = "state", milliseconds = 3000) {
  for (let count = 0; count < milliseconds / 10; count++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error(`Expected ${what} did not arrive`);
}

interface Song { id: string; type: string; name: string; artist: string; album: string; duration: number }
const song = (id: string): Song => ({ id, type: "songs", name: id.toUpperCase(), artist: "Artist", album: "Album", duration: 100 });

// A stand-in for one computer's engine: a queue, a position, and whether it plays.
function fakeEngine() {
  const state = { items: [] as Song[], position: 0, time: 0, playing: false, added: [] as number[], calls: [] as string[], started: 0 };
  const instance = crypto.randomUUID();
  const transport = async (path: string, body?: any) => {
    if (path === "/state") {
      const current = state.items[state.position];
      return { ready: true, instance, playback: { state: !current ? "stopped" : state.playing ? "playing" : "paused", nowPlaying: current ? { name: current.name, artistName: current.artist, playParams: { id: current.id } } : null,
        time: { currentTime: state.time, duration: 100 }, volume: 0.5, repeatMode: "none", shuffleMode: false } };
    }
    if (path === "/release") return null;
    const { method, args = [] } = body;
    state.calls.push(method);
    if (method === "pause") state.playing = false;
    if (method === "stop") Object.assign(state, { items: [], position: 0, time: 0, playing: false, added: [] });
    if (method === "resume") state.playing = true;
    if (method === "play") { state.items = structuredClone(args[0]); state.position = args[1] ?? 0; state.playing = true; state.time = 0; }
    if (method === "exportPlayback") return { items: state.items, position: state.position, added: state.added, time: state.time, playing: state.playing, repeatMode: "none", shuffleMode: false };
    if (method === "importPlayback") { const value = args[0]; Object.assign(state, { items: value.items, position: value.position, added: value.added, time: value.time, playing: value.playing }); }
    if (method === "tokens") return { userToken: "local token" };
    return null;
  };
  return { state, engine: new Engine("/nonexistent", transport) };
}

// One computer: its engine, its player, and its place on the network. Devices find each other
// directly in tests rather than by broadcast.
async function computer(name: string, announceEvery = 60000, claimSettle?: number) {
  const dir = await mkdtemp(join(tmpdir(), "peel-devices-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeEngine();
  let failImport = false;
  const inner = (fake.engine as any).transport;
  (fake.engine as any).transport = async (path: string, body?: any) => {
    if (failImport && body?.method === "importPlayback") { fake.state.playing = true; throw new Error("import failed"); }
    return inner(path, body);
  };
  const player = new DevicePlayer(undefined, () => {}, fake.engine, async () => { fake.state.started++; });
  const network = new DeviceNetwork({ local: player.localPlayer(), dir, name, port: 0, discovery: false, announceEvery, allowOwnAddresses: true, claimSettle });
  player.attach(network);
  await network.start();
  cleanup.push(() => network.close());
  return { name, dir, fake, player, network, failImports: (value: boolean) => { failImport = value; } };
}

type Computer = Awaited<ReturnType<typeof computer>>;
// Pairing without the code exchange: both share one group key, then one connects to the other.
async function link(a: Computer, b: Computer) {
  b.network.merge(a.network.groupKeys, []);
  b.network.connectTo(a.network.id, "127.0.0.1", a.network.port);
  await waitFor(() => a.network.online(b.network.id) && b.network.online(a.network.id), "a session");
}

test("paired devices control each other's engines, and nothing else", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  main.fake.state.items = [song("a")]; main.fake.state.playing = true;
  const state = await mac.network.request(main.network.id, "/state");
  expect(state.playback.nowPlaying.name).toBe("A");
  await mac.network.request(main.network.id, "/call", { method: "pause", args: [] });
  expect(main.fake.state.playing).toBe(false);
  await expect(mac.network.request(main.network.id, "/call", { method: "tokens", args: [] })).rejects.toThrow("not allowed");
  await expect(mac.network.request(main.network.id, "/quit", {})).rejects.toThrow("not allowed");
  expect(main.fake.state.calls).toEqual(["pause"]);
  // Each device lists the other as paired and online, with what it plays.
  await waitFor(() => mac.network.views().some(device => device.name === "main" && device.online && device.summary?.state === "paused"), "main's status", 6000);
}, 15000);

test("a device without a shared key cannot open a session", async () => {
  const mac = await computer("Mac"), stranger = await computer("stranger");
  stranger.network.connectTo(mac.network.id, "127.0.0.1", mac.network.port);
  await Bun.sleep(200);
  expect(mac.network.online(stranger.network.id)).toBe(false);
  expect(stranger.network.online(mac.network.id)).toBe(false);
});

test("only the engine requests a controller needs are forwarded", () => {
  expect(allowedRequest("/state", undefined)).toBe(true);
  expect(allowedRequest("/call", { method: "importPlayback", args: [{}] })).toBe(true);
  for (const [path, body] of [["/call", { method: "tokens" }], ["/call", { method: "quality", args: ["high"] }], ["/quit", {}], ["/retain", {}], ["/release", {}], ["/call", { method: "constructor" }]] as const) expect(allowedRequest(path, body)).toBe(false);
});

test("pairing shows the same code on both devices, and joins their groups once both accept", async () => {
  const mac = await computer("Mac"), main = await computer("main"), laptop = await computer("laptop");
  // main and laptop were paired before. Pairing the Mac with main joins it to both.
  await link(main, laptop);
  main.network.openForPairing();
  const outgoing = mac.network.pairWith({ id: main.network.id, name: "main", address: "127.0.0.1", port: main.network.port, keys: [], seen: Date.now() });
  await waitFor(() => outgoing.state === "confirm" && main.network.pairing?.state === "confirm", "codes");
  const incoming = main.network.pairing!;
  expect(incoming.incoming).toBe(true);
  expect(incoming.name).toBe("Mac");
  expect(outgoing.code).toMatch(/^\d{6}$/);
  expect(incoming.code).toBe(outgoing.code);
  outgoing.accept();
  await Bun.sleep(50);
  expect(mac.network.groupKeys).toHaveLength(1);
  incoming.accept();
  await waitFor(() => outgoing.state === "done" && incoming.state === "done", "pairing");
  await waitFor(() => mac.network.online(main.network.id), "a session after pairing");
  // The laptop's key reached the Mac through main, so the Mac can reach the laptop too.
  await waitFor(() => mac.network.groupKeys.length === laptop.network.groupKeys.length && laptop.network.groupKeys.length >= 2, "the group keys");
  laptop.network.connectTo(mac.network.id, "127.0.0.1", mac.network.port);
  await waitFor(() => mac.network.online(laptop.network.id), "a session with the laptop");
});

test("declining a pairing gives neither device the other's keys", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  main.network.openForPairing();
  const outgoing = mac.network.pairWith({ id: main.network.id, name: "main", address: "127.0.0.1", port: main.network.port, keys: [], seen: Date.now() });
  await waitFor(() => main.network.pairing?.state === "confirm", "the request");
  main.network.pairing!.decline();
  await waitFor(() => outgoing.state === "failed", "the refusal");
  expect(outgoing.message).toContain("declined");
  expect(mac.network.groupKeys.map(key => key.id)).not.toContain(main.network.groupKeys[0]!.id);
  expect(main.network.pairing).toBeUndefined();
});

test("a device in the middle cannot make the two pairing codes match", () => {
  // The device that asks commits to its key first. A device in between answers each side with
  // its own key, and the codes then differ.
  const initiator = new Ephemeral(), responder = new Ephemeral(), attacker = new Ephemeral(), attackerToResponder = new Ephemeral();
  const offer: PairOffer = { t: "pair", v: 1, id: "initiator-id", name: "Mac", commit: commitment(initiator) };
  const forged: PairOffer = { ...offer, commit: commitment(attackerToResponder) };
  const fromResponder: PairOffer = { t: "pair", v: 1, id: "responder-id", name: "main", e: responder.public, n: responder.nonce };
  const fromAttacker: PairOffer = { ...fromResponder, e: attacker.public, n: attacker.nonce };
  const seenByInitiator = pairingKeys(initiator, offer, fromAttacker, { e: initiator.public, n: initiator.nonce });
  const seenByResponder = pairingKeys(responder, forged, fromResponder, { e: attackerToResponder.public, n: attackerToResponder.nonce });
  expect(seenByInitiator.code).not.toBe(seenByResponder.code);
  // A key that does not match its commitment is refused.
  expect(() => pairingKeys(responder, offer, fromResponder, { e: attacker.public, n: attacker.nonce })).toThrow("changed");
});

test("sealed messages fail after tampering, replay, or reordering", () => {
  const key = Buffer.alloc(32, 7), sender = new Cipher(key, key), receiver = new Cipher(key, key);
  const first = sender.seal({ n: 1 }), second = sender.seal({ n: 2 });
  expect(receiver.open(first)).toEqual({ n: 1 });
  expect(() => receiver.open(first)).toThrow();
  const fresh = new Cipher(key, key);
  expect(() => fresh.open(second)).toThrow();
  const tampered = Buffer.from(first, "base64url"); tampered[0]! ^= 1;
  expect(() => new Cipher(key, key).open(tampered.toString("base64url"))).toThrow();
  expect(newGroupKey().id).toHaveLength(16);
});

test("play here moves the queue, song, and position, and the old device pauses", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  Object.assign(mac.fake.state, { items: [song("c1"), song("c2"), song("a1")], position: 1, time: 42, playing: true, added: [2] });
  await mac.player.playOn(main.network.id);
  expect(main.fake.state).toMatchObject({ position: 1, time: 42, playing: true, added: [2] });
  expect(main.fake.state.items.map(item => item.id)).toEqual(["c1", "c2", "a1"]);
  // The Mac stops, so it no longer holds the account's stream.
  expect(mac.fake.state.calls.slice(-1)).toEqual(["stop"]);
  expect(mac.fake.state.items).toEqual([]);
  expect(mac.player.peer).toBe(main.network.id);
  // Both devices agree that main plays now.
  await waitFor(() => main.network.claim.device === main.network.id, "main's claim");
  // Commands from the Mac now reach main.
  await mac.player.command("/playback/pause");
  expect(main.fake.state.playing).toBe(false);
  // And back.
  await mac.player.command("/playback/play");
  await mac.player.playOn(mac.network.id);
  expect(mac.fake.state).toMatchObject({ position: 1, time: 42, playing: true });
  expect(main.fake.state.playing).toBe(false);
  expect(mac.player.peer).toBeUndefined();
});

test("a failed move leaves the music playing where it was", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  Object.assign(mac.fake.state, { items: [song("c1")], position: 0, time: 10, playing: true });
  const original = (main.fake.engine as any).transport;
  (main.fake.engine as any).transport = async (path: string, body?: any) => { if (body?.method === "importPlayback") throw new Error("not a function"); return original(path, body); };
  await expect(mac.player.playOn(main.network.id)).rejects.toThrow("keeps playing on this computer");
  expect(mac.fake.state.playing).toBe(true);
  expect(mac.player.peer).toBeUndefined();
  expect(mac.network.claim.device).toBe(mac.network.id);
});

test("every Peel follows the device that plays, and falls back when it goes offline", async () => {
  const mac = await computer("Mac"), main = await computer("main"), laptop = await computer("laptop");
  await link(main, mac); await link(main, laptop);
  laptop.network.merge(mac.network.groupKeys, []); mac.network.merge(laptop.network.groupKeys, []);
  laptop.network.connectTo(mac.network.id, "127.0.0.1", mac.network.port);
  await waitFor(() => laptop.network.online(mac.network.id), "the laptop's session");
  let retargets = 0;
  laptop.player.onRetarget = () => { retargets++; laptop.player.applyTarget(); };
  Object.assign(mac.fake.state, { items: [song("c1")], position: 0, playing: true });
  // The Mac moves its music to main. The laptop hears about it and controls main from then on.
  await mac.player.playOn(main.network.id);
  await waitFor(() => laptop.player.peer === main.network.id, "the laptop following main");
  expect(retargets).toBeGreaterThan(0);
  expect(laptop.player.target).toBe("main");
  // main closes Peel. The laptop controls itself again.
  main.network.close();
  await waitFor(() => laptop.player.peer === undefined, "the fallback");
  // Playing on the laptop now makes it the device that plays, for the Mac too.
  await laptop.player.playItem(song("x") as any);
  await waitFor(() => mac.network.claim.device === laptop.network.id, "the Mac following the laptop");
});

test("losing the music to another device pauses this one", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  Object.assign(main.fake.state, { items: [song("c1")], position: 0, playing: true });
  mac.network.claimOutput(mac.network.id);
  await waitFor(() => !main.fake.state.playing, "main pausing");
  expect(newer({ device: "b", generation: 2 }, { device: "a", generation: 2 })).toBe(true);
  expect(newer({ device: "a", generation: 2 }, { device: "b", generation: 3 })).toBe(false);
});

test("the Apple sign-in comes from this computer while another device plays", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  await mac.player.playOn(main.network.id);
  expect((await mac.player.appleTokens()).userToken).toBe("local token");
  expect(main.fake.state.calls).not.toContain("tokens");
});

test("the devices popup lists devices, moves the music, and closes with Escape", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const app = await createTestRenderer({ width: 120, height: 36 }); cleanup.push(() => app.renderer.destroy());
  const model = new Model(api.library, api.player, structuredClone(defaults));
  const moved: string[] = [], paired: string[] = [];
  model.onPlayOn = async id => { moved.push(id); };
  model.onPair = id => { paired.push(id); };
  model.devices = [
    { id: "self-id", name: "t480", self: true, paired: true, online: true, output: true, summary: { state: "playing", song: "Soma", artist: "Skrillex" } },
    { id: "main-id", name: "main", self: false, paired: true, online: true, output: false, summary: { state: "paused", song: "Burnt", artist: "Artist" } },
    { id: "mac-id", name: "Fynn's Mac", self: false, paired: true, online: false, output: false },
    { id: "new-id", name: "living-room", self: false, paired: false, online: true, output: false },
  ];
  const ui = new PeelUI(app.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await app.flush();
  app.mockInput.pressKey("d"); await app.flush();
  const frame = app.captureCharFrame();
  expect(frame).toContain("Play on");
  expect(frame).toContain("t480  (this computer)");
  expect(frame).toContain("Soma  /  Skrillex");
  expect(frame).toContain("Offline");
  expect(frame).toContain("Pair");
  app.mockInput.pressArrow("down"); app.mockInput.pressEnter(); await app.flush(); await Bun.sleep(10);
  expect(moved).toEqual(["main-id"]);
  expect(app.captureCharFrame()).not.toContain("Play on");
  // Clicking the devices button opens it too. A nearby device pairs.
  const button = app.renderer.root.findDescendantById("devices")!;
  await app.mockMouse.click(button.x, button.y); await app.flush();
  expect(app.captureCharFrame()).toContain("Play on");
  for (let step = 0; step < 3; step++) app.mockInput.pressArrow("down");
  app.mockInput.pressEnter(); await app.flush();
  expect(paired).toEqual(["new-id"]);
  app.mockInput.pressKey("d"); await app.flush();
  // Escape arrives after the terminal's short wait for a longer key sequence.
  app.mockInput.pressEscape();
  await waitFor(() => !app.renderer.root.findDescendantById("devices-view"), "the popup closing");
  await app.flush();
  expect(app.captureCharFrame()).not.toContain("Play on");
});

test("the pairing prompt shows the code and accepts with Enter", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const app = await createTestRenderer({ width: 120, height: 36 }); cleanup.push(() => app.renderer.destroy());
  const model = new Model(api.library, api.player, structuredClone(defaults));
  let accepted = 0;
  model.onPlayOn = async () => {};
  model.pairing = { id: "mac-id", name: "Fynn's Mac", incoming: true, code: "482913", state: "confirm", accept: () => { accepted++; }, decline: () => {} };
  const ui = new PeelUI(app.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await app.flush();
  const frame = app.captureCharFrame();
  expect(frame).toContain("Pair with Fynn's Mac");
  expect(frame).toContain("482 913");
  app.mockInput.pressEnter(); await app.flush();
  expect(accepted).toBe(1);
  model.pairing = undefined; model.changed(); await app.flush();
  expect(app.captureCharFrame()).not.toContain("482 913");
});

test("a favourite set on the playing device replaces an earlier answer, in the player and the list", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  let reported: boolean | undefined;
  const snapshot = api.player.snapshot.bind(api.player);
  api.player.snapshot = async () => { const playback = await snapshot(); return { ...playback, nowPlaying: playback.nowPlaying ? { ...playback.nowPlaying, inFavorites: reported } : null }; };
  const model = new Model(api.library, api.player, structuredClone(defaults));
  await model.refresh(); await Bun.sleep(20);
  const known = model.favourite;
  expect(known).toBeDefined();
  reported = !known;
  const id = model.playback.nowPlaying?.playParams?.id;
  model.items = [{ id: id!, type: "songs", name: "Soma", artist: "", album: "", duration: 1, loved: known }];
  const revision = model.lovedRevision;
  await model.refresh();
  expect(model.favourite).toBe(!known);
  expect(model.items[0]!.loved).toBe(!known);
  expect(model.lovedRevision).toBeGreaterThan(revision);
});

test("music started here without a claim, as from a Peel over SSH, makes the other Peels follow", async () => {
  const mac = await computer("Mac", 60000, 100), main = await computer("main", 60000, 100);
  mac.player.onRetarget = () => { mac.player.applyTarget(); };
  await link(mac, main);
  // The Mac played last, so every Peel shows the Mac.
  mac.network.claimOutput(mac.network.id);
  await waitFor(() => main.network.claim.device === mac.network.id, "main following the Mac");
  // A Peel on the Mac starts music on main over SSH, straight at main's engine.
  Object.assign(main.fake.state, { items: [song("worth it")], position: 0, playing: true });
  await waitFor(() => main.network.claim.device === main.network.id, "main claiming the music", 8000);
  await waitFor(() => mac.player.peer === main.network.id, "the Mac following main");
  expect(main.fake.state.playing).toBe(true);
}, 15000);

// The Mac's Peel controls main over SSH, as after peel --remote main: its requests reach main's
// engine without the device network.
function controlOverSsh(computer: Computer, host: Computer) {
  (computer.player as any).remote = { request: (path: string, body?: any) => (host.fake.engine as any).transport(path, body), close: () => {} };
  computer.player.host = host.name;
}

test("a Peel that controls main over SSH follows music another Peel moves to its own computer", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  mac.player.onRetarget = () => { mac.player.applyTarget(); };
  controlOverSsh(mac, main);
  await link(mac, main);
  // main's own Peel moves what it plays to the Mac.
  Object.assign(main.fake.state, { items: [song("24hrs")], position: 0, playing: true });
  await main.player.playOn(mac.network.id);
  await waitFor(() => mac.player.host === undefined, "the Mac leaving SSH");
  expect(mac.player.peer).toBeUndefined();
  expect((await mac.player.state()).playback?.nowPlaying?.name).toBe("24HRS");
  expect(mac.fake.state.playing).toBe(true);
}, 15000);

test("a Peel that controls main over SSH stays when the music moves to main itself", async () => {
  const mac = await computer("Mac"), main = await computer("main"), laptop = await computer("laptop");
  let retargets = 0;
  mac.player.onRetarget = () => { retargets++; mac.player.applyTarget(); };
  controlOverSsh(mac, main);
  await link(mac, main); await link(main, laptop); await link(mac, laptop);
  Object.assign(laptop.fake.state, { items: [song("a")], position: 0, playing: true });
  await laptop.player.playOn(main.network.id);
  await waitFor(() => mac.network.claim.device === main.network.id, "the Mac hearing main's claim");
  await Bun.sleep(300);
  expect(mac.player.host).toBe("main");
  expect(retargets).toBe(0);
  expect(main.fake.state.playing).toBe(true);
}, 15000);

test("a device that plays keeps the claim while another one plays too", async () => {
  const mac = await computer("Mac", 60000, 100), main = await computer("main", 60000, 100);
  await link(mac, main);
  Object.assign(mac.fake.state, { items: [song("a")], position: 0, playing: true });
  mac.network.claimOutput(mac.network.id);
  await waitFor(() => main.network.claim.device === mac.network.id, "main following the Mac");
  Object.assign(main.fake.state, { items: [song("b")], position: 0, playing: true });
  await Bun.sleep(5000);
  expect(main.network.claim.device).toBe(mac.network.id);
  expect(mac.fake.state.playing).toBe(true);
}, 15000);

test("music started after pairing makes the other Peels follow", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  mac.player.onRetarget = () => { mac.player.applyTarget(); };
  await link(mac, main);
  main.fake.state.items = [song("a")];
  await main.player.command("/playback/play");
  await waitFor(() => mac.player.peer === main.network.id, "the Mac following main");
  expect(mac.network.claim).toEqual({ device: main.network.id, generation: 1 });
});

test("a failed move back keeps everyone on the device that still plays, and the new device silent", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  mac.player.onRetarget = () => { mac.player.applyTarget(); };
  main.player.onRetarget = () => { main.player.applyTarget(); };
  await link(mac, main);
  Object.assign(mac.fake.state, { items: [song("c1")], position: 0, time: 10, playing: true });
  await mac.player.playOn(main.network.id);
  await waitFor(() => main.network.claim.device === main.network.id && mac.player.peer === main.network.id, "main playing");
  // From main's popup, back to the Mac, which fails to start.
  mac.failImports(true);
  await expect(main.player.playOn(mac.network.id)).rejects.toThrow("keeps playing");
  await Bun.sleep(100);
  expect(main.fake.state.playing).toBe(true);
  expect(mac.fake.state.playing).toBe(false);
  expect(main.network.claim.device).toBe(main.network.id);
  expect(mac.network.claim.device).toBe(main.network.id);
  expect(mac.player.peer).toBe(main.network.id);
});

test("forgetting devices also refuses a handshake that started before", async () => {
  const mac = await computer("Mac");
  const old = mac.network.groupKeys.map(key => ({ ...key }));
  const ephemeral = new Ephemeral(), hello = clientHello(ephemeral, "former-device", "former", old);
  let auth: unknown, closed = false;
  const socket = connect({ host: "127.0.0.1", port: mac.network.port }, () => socket.write(JSON.stringify(hello) + "\n"));
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => { auth ??= clientFinish(ephemeral, old, hello, JSON.parse(data.split("\n")[0]!)).auth; });
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  await waitFor(() => !!auth, "the server's answer");
  await mac.network.forget();
  if (!closed) socket.write(JSON.stringify(auth) + "\n");
  await waitFor(() => closed, "the connection closing");
  expect(mac.network.online("former-device")).toBe(false);
});

test("only one pairing request reaches the screen, and a decline refuses the next", async () => {
  const main = await computer("main"), first = await computer("first"), second = await computer("second");
  const target = { id: main.network.id, name: "main", address: "127.0.0.1", port: main.network.port, keys: [], seen: Date.now() };
  main.network.openForPairing();
  const one = first.network.pairWith(target);
  await waitFor(() => main.network.pairing?.state === "confirm", "the first request");
  const two = second.network.pairWith(target);
  await waitFor(() => two.state === "failed", "the second refusal");
  expect(two.message).toContain("pairing with another device");
  expect(main.network.pairing?.name).toBe("first");
  main.network.pairing!.decline();
  await waitFor(() => one.state === "failed", "the decline");
  const three = second.network.pairWith(target);
  await waitFor(() => three.state === "failed", "the cooldown");
  expect(three.message).toContain("declined a moment ago");
});

test("forgetting devices cancels a pairing that this device already accepted", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  main.network.openForPairing();
  const outgoing = mac.network.pairWith({ id: main.network.id, name: "main", address: "127.0.0.1", port: main.network.port, keys: [], seen: Date.now() });
  await waitFor(() => outgoing.state === "confirm" && main.network.pairing?.state === "confirm", "codes");
  outgoing.accept();
  await mac.network.forget();
  expect(outgoing.state).toBe("failed");
  main.network.pairing?.accept();
  await Bun.sleep(200);
  expect(main.network.groupKeys.some(key => mac.network.groupKeys.some(own => own.id === key.id))).toBe(false);
  expect(mac.network.online(main.network.id)).toBe(false);
});

test("a handshake still on its way when Peel closes does not open a session", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  main.network.merge(mac.network.groupKeys, []);
  main.network.connectTo(mac.network.id, "127.0.0.1", mac.network.port);
  main.network.close();
  await Bun.sleep(300);
  expect(main.network.online(mac.network.id)).toBe(false);
  expect(mac.network.online(main.network.id)).toBe(false);
});

test("paired devices learn each other's addresses, and a device is tried at each of them", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  await waitFor(() => JSON.stringify(mac.network.knownList().find(device => device.id === main.network.id)?.addresses ?? []) === JSON.stringify(ownAddresses()), "main's addresses");
  // A laptop away from home knows main by an address that no longer answers and by one that
  // does, as its Tailscale address would.
  const working = ownAddresses()[0];
  if (!working) return;
  const laptop = await computer("laptop", 200);
  laptop.network.merge(main.network.groupKeys, [{ id: main.network.id, name: "main", address: "192.0.2.1", port: main.network.port, addresses: [working] }]);
  for (let count = 0; count < 150 && !laptop.network.online(main.network.id); count++) await Bun.sleep(100);
  expect(laptop.network.online(main.network.id)).toBe(true);
}, 20000);

test("a device found on this network replaces a connection made another way", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const sessions = () => [...((mac.network as any).sessions.get(main.network.id) ?? [])].filter((session: any) => !session.closed);
  expect(sessions().map((session: any) => session.peer.address)).toEqual(["127.0.0.1"]);
  // main announces itself on this network at another address, as it would after Tailscale.
  const other = ownAddresses()[0];
  if (!other) return;
  (mac.network as any).connecting.clear();
  (mac.network as any).connect(main.network.id, other, main.network.port, true);
  await waitFor(() => sessions().length === 1 && sessions()[0].peer.address === other, "the switch");
  expect(mac.network.online(main.network.id)).toBe(true);
  await mac.network.request(main.network.id, "/call", { method: "pause", args: [] });
});

test("a device that stops answering, as one that went to sleep, counts as offline", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  mac.player.onRetarget = () => { mac.player.applyTarget(); };
  await link(mac, main);
  Object.assign(mac.fake.state, { items: [song("c1")], position: 0, playing: true });
  await mac.player.playOn(main.network.id);
  // main keeps its connection open but answers nothing.
  (main.network as any).handle = () => new Promise(() => {});
  for (let count = 0; count < 200 && mac.network.online(main.network.id); count++) await Bun.sleep(100);
  expect(mac.network.online(main.network.id)).toBe(false);
  await waitFor(() => mac.player.peer === undefined, "the Mac controlling itself");
}, 30000);

test("a device asks for pairing only while the other one has its devices popup open", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  const refused = mac.network.pairWith({ id: main.network.id, name: "main", address: "127.0.0.1", port: main.network.port, keys: [], seen: Date.now() });
  await waitFor(() => refused.state === "failed", "the refusal");
  expect(refused.message).toContain("not open for pairing");
  expect(main.network.pairing).toBeUndefined();
});

test("moving the music to the same engine reached another way leaves it playing", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  // The Mac controls main's engine already, as it would over SSH, and main's engine is also its device.
  const inner = (main.fake.engine as any).transport;
  (main.fake.engine as any).transport = async (path: string, body?: any) => path === "/state" ? { ...await inner(path, body), instance: "main-engine" } : inner(path, body);
  Object.assign(main.fake.state, { items: [song("c1")], position: 0, playing: true });
  const { moveMusic } = await import("../src/remote");
  const viaSsh = (path: string, body?: any) => mac.network.request(main.network.id, path, body);
  await moveMusic(viaSsh, viaSsh, "main over SSH", "main");
  expect(main.fake.state.playing).toBe(true);
  expect(main.fake.state.calls).not.toContain("stop");
  expect(main.fake.state.calls).not.toContain("importPlayback");
});

test("a connection that has not proven it is paired cannot send large messages", async () => {
  const mac = await computer("Mac");
  let closed = false;
  const socket = connect({ host: "127.0.0.1", port: mac.network.port }, () => socket.write("x".repeat(64 * 1024)));
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  await waitFor(() => closed, "the connection closing");
});

test("gossip cannot point devices at this computer's own services, or change how another device is reached", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const fake = { id: "fake-device-1", name: "fake", port: 22, addresses: ["127.0.0.1", "169.254.1.1", "224.0.0.1", "0.0.0.0", "999.1.1.1", "10.0.0.5"], address: "127.0.0.2" };
  mac.network.merge([], [fake], main.network.id);
  expect(mac.network.knownList().find(device => device.id === "fake-device-1")).toEqual({ id: "fake-device-1", name: "fake", port: 22, addresses: ["10.0.0.5"] });
  // main's own record changes only when main sends it.
  const before = JSON.stringify(mac.network.knownList().find(device => device.id === main.network.id));
  mac.network.merge([], [{ id: main.network.id, name: "main", port: 1, addresses: ["10.9.9.9"] }], "fake-device-1");
  expect(JSON.stringify(mac.network.knownList().find(device => device.id === main.network.id))).toBe(before);
  expect(onLocalNetwork("127.0.0.1")).toBe(false);
});

test("a second Peel on the same computer leaves the devices to the first, and takes over when it closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-devices-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const probe = (await import("node:net")).createServer();
  const port: number = await new Promise(resolve => probe.listen(0, "0.0.0.0", () => resolve((probe.address() as any).port)));
  await new Promise(resolve => probe.close(resolve));
  const open = async () => {
    const fake = fakeEngine(), player = new DevicePlayer(undefined, () => {}, fake.engine, async () => {});
    const network = new DeviceNetwork({ local: player.localPlayer(), dir, name: "Mac", port, discovery: false, announceEvery: 100 });
    player.attach(network); await network.start(); cleanup.push(() => network.close());
    return network;
  };
  const first = await open(), second = await open();
  expect(first.active).toBe(true);
  expect(second.active).toBe(false);
  expect(second.id).toBe(first.id);
  expect(second.views()[0]!.note).toContain("Another Peel window");
  await expect(second.forget()).rejects.toThrow("Another Peel window");
  first.close();
  await waitFor(() => second.active, "the second Peel taking over");
});

test("a status check answers while the engine is slow", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const inner = (main.fake.engine as any).transport;
  (main.fake.engine as any).transport = async (path: string, body?: any) => { if (path === "/state") await Bun.sleep(9000); return inner(path, body); };
  await Bun.sleep(11000);
  expect(mac.network.online(main.network.id)).toBe(true);
}, 20000);

test("a connection replaced by a better one finishes its requests first", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const other = ownAddresses()[0];
  if (!other) return;
  const inner = (main.fake.engine as any).transport;
  (main.fake.engine as any).transport = async (path: string, body?: any) => { if (body?.method === "exportPlayback") await Bun.sleep(500); return inner(path, body); };
  const slow = mac.network.request(main.network.id, "/call", { method: "exportPlayback", args: [] });
  (mac.network as any).connecting.clear();
  (mac.network as any).connect(main.network.id, other, main.network.port, true);
  await expect(slow).resolves.toBeDefined();
});

test("a source that cannot be read keeps the music and the claim where they are", async () => {
  const mac = await computer("Mac"), main = await computer("main"), laptop = await computer("laptop");
  await link(mac, main); await link(mac, laptop);
  Object.assign(main.fake.state, { items: [song("c1")], position: 0, playing: true });
  mac.player.onRetarget = () => { mac.player.applyTarget(); };
  await mac.player.playOn(main.network.id);
  await waitFor(() => mac.player.peer === main.network.id, "the Mac controlling main");
  const inner = (main.fake.engine as any).transport;
  (main.fake.engine as any).transport = async (path: string, body?: any) => { if (path === "/state") throw new Error("busy"); return inner(path, body); };
  const claim = mac.network.claim;
  await expect(mac.player.playOn(laptop.network.id)).rejects.toThrow("nothing moved");
  expect(mac.network.claim).toEqual(claim);
  expect(laptop.fake.state.calls).not.toContain("importPlayback");
});

test("a move that loses the new device leaves the old one paused, so they never both play", async () => {
  const { moveMusic } = await import("../src/remote");
  const { unanswered } = await import("../src/devices");
  const source = fakeEngine(), destination = fakeEngine();
  Object.assign(source.state, { items: [song("c1")], position: 0, playing: true });
  const lost = async (path: string, body?: any) => { if (body?.method === "importPlayback") throw unanswered("Lost the connection to main."); return (destination.engine as any).transport(path, body); };
  await expect(moveMusic((source.engine as any).transport, lost, "this computer", "main", true)).rejects.toThrow("paused on this computer");
  expect(source.state.playing).toBe(false);
  expect(source.state.calls).not.toContain("resume");
});

test("a library song's favourite does not spill onto its catalog song or other library copies", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const snapshot = api.player.snapshot.bind(api.player);
  api.player.snapshot = async () => ({ ...await snapshot(), nowPlaying: { name: "Soma", playParams: { id: "i.mine", catalogId: "c.soma" }, inFavorites: true } });
  const model = new Model(api.library, api.player, structuredClone(defaults));
  model.items = [
    { id: "i.mine", type: "library-songs", name: "Soma", artist: "", album: "", duration: 1, catalogId: "c.soma", loved: false },
    { id: "c.soma", type: "songs", name: "Soma", artist: "", album: "", duration: 1, loved: false },
    { id: "i.copy", type: "library-songs", name: "Soma", artist: "", album: "", duration: 1, catalogId: "c.soma", loved: false },
  ];
  await model.refresh();
  expect(model.items.map(item => item.loved)).toEqual([true, false, false]);
});

test("a device whose first message after the handshake is large still connects", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  // Sixty devices of gossip make the first key exchange far larger than the handshake limit.
  mac.network.merge([], Array.from({ length: 60 }, (_, index) => ({ id: `device-${String(index).padStart(4, "0")}-x`, name: `Device number ${index} with a long name`, port: 10770, addresses: ["10.1.2.3", "10.1.2.4", "10.1.2.5"] })), "someone");
  await link(mac, main);
  await waitFor(() => main.network.knownList().length >= 60, "the gossip");
});

test("a device that loses its listener stops handling devices", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  (mac.network as any).server.emit("error", Object.assign(new Error("too many files"), { code: "EMFILE" }));
  expect(mac.network.active).toBe(false);
  await waitFor(() => !main.network.online(mac.network.id), "the old connection closing");
});

test("a replaced connection also finishes what the other device asked", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const inner = (mac.fake.engine as any).transport;
  (mac.fake.engine as any).transport = async (path: string, body?: any) => { if (body?.method === "exportPlayback") await Bun.sleep(600); return inner(path, body); };
  const slow = main.network.request(mac.network.id, "/call", { method: "exportPlayback", args: [] });
  await Bun.sleep(50);
  const session = [...(mac.network as any).sessions.get(main.network.id)][0];
  session.retire();
  await expect(slow).resolves.toBeDefined();
});

test("forgetting devices starts claims again, and no device list grows past its limit", async () => {
  const mac = await computer("Mac");
  mac.network.adopt({ device: "someone-else", generation: 2 ** 40 - 1 });
  await mac.network.forget();
  expect(mac.network.claim).toEqual({ device: mac.network.id, generation: 1 });
  for (let index = 0; index < 70; index++) mac.network.remember({ id: `device-${String(index).padStart(4, "0")}-x`, name: "x" });
  expect(mac.network.knownList().length).toBe(64);
});

test("a move whose new device cannot confirm it paused leaves the old one paused", async () => {
  const { moveMusic } = await import("../src/remote");
  const source = fakeEngine(), destination = fakeEngine();
  Object.assign(source.state, { items: [song("c1")], position: 0, playing: true });
  const broken = async (path: string, body?: any) => {
    if (body?.method === "importPlayback") { destination.state.playing = true; throw new Error("The playback engine returned HTTP 500."); }
    if (body?.method === "pause") throw new Error("Peel's playback engine is not running.");
    return (destination.engine as any).transport(path, body);
  };
  await expect(moveMusic((source.engine as any).transport, broken, "this computer", "main", true)).rejects.toThrow("Could not confirm");
  expect(source.state.playing).toBe(false);
});

test("a device list never makes Peel connect to this computer itself", async () => {
  const own = ownAddresses()[0];
  if (!own) return;
  const dir = await mkdtemp(join(tmpdir(), "peel-devices-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let reached = false;
  const service = (await import("node:net")).createServer(socket => { reached = true; socket.destroy(); });
  const port: number = await new Promise(resolve => service.listen(0, "0.0.0.0", () => resolve((service.address() as any).port)));
  cleanup.push(() => new Promise(resolve => service.close(resolve)));
  const fake = fakeEngine(), player = new DevicePlayer(undefined, () => {}, fake.engine, async () => {});
  const network = new DeviceNetwork({ local: player.localPlayer(), dir, name: "Mac", port: 0, discovery: false, announceEvery: 100 });
  await network.start(); cleanup.push(() => network.close());
  network.merge([], [{ id: "planted-device", name: "planted", port, addresses: [own] }], "someone");
  await Bun.sleep(600);
  expect(reached).toBe(false);
});

test("large messages are compressed, keys never are, and a small message cannot unpack into a huge one", async () => {
  const { deflateRawSync } = await import("node:zlib");
  const key = Buffer.alloc(32, 3);
  const queue = { items: Array.from({ length: 300 }, (_, index) => ({ id: `i.${index}`, name: `Song ${index}`, artwork: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/{w}x{h}bb.jpg" })) };
  const compressed = new Cipher(key, key).seal(queue, true), plain = new Cipher(key, key).seal(queue, false);
  expect(compressed.length * 5).toBeLessThan(plain.length);
  expect(new Cipher(key, key).open(compressed)).toEqual(queue);
  // A session never compresses a message that carries group keys.
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const sent: string[] = [];
  const session = [...(mac.network as any).sessions.get(main.network.id)][0];
  const seal = session.cipher.seal.bind(session.cipher);
  session.cipher.seal = (value: unknown, compress?: boolean) => { if (compress) sent.push(JSON.stringify(value)); return seal(value, compress); };
  await (mac.network as any).sync(session);
  expect(sent.some(text => text.includes('"key":'))).toBe(false);
  // A compressed bomb is refused.
  const bomb = Buffer.concat([Buffer.from("z"), deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 32))]);
  const { createCipheriv } = await import("node:crypto");
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  const sealed = Buffer.concat([cipher.update(bomb), cipher.final(), cipher.getAuthTag()]).toString("base64url");
  expect(() => new Cipher(key, key).open(sealed)).toThrow();
});

test("the player says when the device that plays cannot be reached", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  api.player.snapshot = async () => ({ state: "stopped", nowPlaying: null, time: { currentTime: 0, duration: 0 }, volume: 0.5, repeatMode: "none", shuffleMode: false });
  const app = await createTestRenderer({ width: 120, height: 36 }); cleanup.push(() => app.renderer.destroy());
  const model = new Model(api.library, api.player, structuredClone(defaults));
  model.devices = [
    { id: "self-id", name: "Mac", self: true, paired: true, online: true, output: false },
    { id: "main-id", name: "main", self: false, paired: true, online: false, output: true },
  ];
  const ui = new PeelUI(app.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await app.flush();
  expect(app.captureCharFrame()).toContain("main plays the music, but this Peel cannot reach it");
});

test("an older connection that stops answering is closed too", async () => {
  const mac = await computer("Mac"), main = await computer("main");
  await link(mac, main);
  const sessions = (mac.network as any).sessions;
  const old = [...sessions.get(main.network.id)][0];
  // A second, newer connection, as after the Mac changed networks. Peel opens no second connection
  // while one works, so the old one is set aside while the new one opens.
  sessions.delete(main.network.id);
  mac.network.connectTo(main.network.id, "127.0.0.1", main.network.port);
  await waitFor(() => sessions.get(main.network.id)?.size === 1, "a second connection");
  sessions.get(main.network.id).add(old);
  // The old one stops answering.
  old.request = () => Promise.reject(new Error("no answer"));
  for (let count = 0; count < 120 && !old.closed; count++) await Bun.sleep(100);
  expect(old.closed).toBe(true);
  expect(mac.network.online(main.network.id)).toBe(true);
}, 20000);
