import { createSocket, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { connect as connectTcp, createServer, type Server, type Socket as TcpSocket } from "node:net";
import { configDir, readCache, saveJson } from "./config";
import type { EngineTransport } from "./engine";
import { Cipher, Ephemeral, checkAuth, clientFinish, clientHello, commitment, keyId, newGroupKey, pairingKeys, serverHello, type GroupKey, type Hello, type PairOffer } from "./link";
import type { Playback } from "./types";

// Every Peel on the network is a device. Paired devices reach each other directly over an
// encrypted TCP connection, and find each other through a small UDP broadcast. No device is in
// charge: whichever device plays the music holds the queue, and every Peel controls it.

export const devicePort = Number(process.env.PEEL_DEVICE_PORT ?? 10770);
export const discoveryPort = Number(process.env.PEEL_DISCOVERY_PORT ?? 10771);

// Which device plays. A higher generation wins, and the larger device ID breaks a tie, so two
// devices that move the music at the same moment still agree on one of them.
export interface Claim { device: string; generation: number }
export interface Summary { state: Playback["state"]; song?: string; artist?: string }
export interface DeviceView { id: string; name: string; self: boolean; paired: boolean; online: boolean; output: boolean; summary?: Summary; note?: string }
export interface Pairing {
  id: string; name: string; incoming: boolean; code?: string;
  // confirm: waiting for this person. waiting: accepted here, waiting for the other device.
  state: "connecting" | "confirm" | "waiting" | "done" | "failed";
  message?: string;
  accept(): void;
  decline(): void;
}

// What the network needs from this computer's player. send starts the engine when needed;
// summary and pause leave an engine that is not running alone.
export interface LocalPlayer { send: EngineTransport; summary(): Promise<Summary | undefined>; pause(): Promise<void> }

// A paired device and where it was reached: the address that worked last, and the addresses it
// reports for itself, such as its Tailscale address.
interface Known { id: string; name: string; address?: string; port?: number; addresses?: string[] }
interface Stored { id: string; keys: GroupKey[]; known: Known[]; output?: Claim }
interface Nearby { id: string; name: string; address: string; port: number; keys: string[]; seen: number }

// The engine methods another device may call. Tokens and stream quality stay on this computer.
const methods = new Set(["state", "pause", "stop", "resume", "toggle", "next", "previous", "seek", "volume", "shuffle", "toggleShuffle", "toggleRepeat", "play", "enqueue", "move", "remove", "jump", "queue", "rating", "rate", "exportPlayback", "importPlayback"]);
export function allowedRequest(path: unknown, body: any) {
  if (path === "/state") return body === undefined;
  return path === "/call" && typeof body?.method === "string" && methods.has(body.method) && (body.args === undefined || Array.isArray(body.args));
}

const text = (value: unknown, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max;
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{8,64}$/.test(value);
// An IPv4 address another device can be reached at. Loopback, link-local, unspecified, multicast
// and broadcast addresses are refused, so gossip cannot make Peel connect to this computer's own
// services or to anything that is not a device.
const validAddress = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const [a, b] = value.split(".").map(Number);
  if (value.split(".").some(part => Number(part) > 255 || part.length > 1 && part.startsWith("0"))) return false;
  return a !== 0 && a !== 127 && !(a === 169 && b === 254) && a! < 224;
};
const validPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;
function readKnown(device: any): Known | undefined {
  if (!validId(device?.id) || !text(device.name, 100)) return undefined;
  const addresses = Array.isArray(device.addresses) ? [...new Set(device.addresses.filter(validAddress) as string[])].slice(0, 8) : [];
  return { id: device.id, name: device.name, ...(validAddress(device.address) ? { address: device.address } : {}), ...(validPort(device.port) ? { port: device.port } : {}), ...(addresses.length ? { addresses } : {}) };
}
// This computer's IPv4 addresses on every network, Tailscale's included.
export function ownAddresses() {
  const addresses: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const address of list ?? []) if (address.family === "IPv4" && !address.internal) addresses.push(address.address);
  return addresses.slice(0, 8);
}
// Whether an address is on one of this computer's own networks, as a device on the same Wi-Fi is.
export function onLocalNetwork(address: string) {
  if (!validAddress(address)) return false;
  const number = (text: string) => text.split(".").reduce((sum, part) => ((sum << 8) | Number(part)) >>> 0, 0);
  for (const list of Object.values(networkInterfaces())) for (const own of list ?? []) {
    if (own.family !== "IPv4" || own.internal || own.netmask === "255.255.255.255") continue;
    const mask = number(own.netmask);
    if (((number(own.address) & mask) >>> 0) === ((number(address) & mask) >>> 0)) return true;
  }
  return false;
}
// Generations stay far below the largest safe integer, so a claim can always be raised by one.
const validClaim = (value: any): value is Claim => validId(value?.device) && Number.isSafeInteger(value?.generation) && value.generation >= 0 && value.generation < 2 ** 40;
export const newer = (a: Claim, b: Claim) => a.generation > b.generation || a.generation === b.generation && a.device > b.device;
// A request that got no answer may still have run on the other device.
export const unanswered = (text: string) => Object.assign(new Error(text), { unanswered: true });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function deviceName() {
  if (process.platform === "darwin") {
    const name = Bun.spawnSync(["scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    if (name) return name;
  }
  if (process.platform === "win32" && process.env.COMPUTERNAME) return process.env.COMPUTERNAME;
  return hostname().replace(/\.(local|lan|home|fritz\.box)$/i, "") || "Peel";
}

// One encrypted connection to a paired device. Either side can ask the other.
class Session {
  private sequence = 0;
  // Requests from the other device still being answered.
  private handling = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  // A session replaced by a better one takes no new requests and closes once its answers are in.
  retiring = false;
  retire() {
    this.retiring = true;
    const until = Date.now() + 130000;
    const check = () => { if (this.closed) return; if (!this.pending.size && !this.handling || Date.now() > until) this.end(); else setTimeout(check, 500); };
    check();
  }
  constructor(readonly peer: { id: string; name: string; address?: string }, private cipher: Cipher, private send: (text: string) => void,
    private hangUp: () => void, private handle: (session: Session, op: string, body: any) => Promise<unknown>) {}

  receive(data: string) {
    let value: any;
    try { value = this.cipher.open(data); } catch { this.end(); return; }
    if (typeof value?.reply === "number") {
      const pending = this.pending.get(value.reply);
      if (!pending) return;
      this.pending.delete(value.reply); clearTimeout(pending.timer);
      if (typeof value.error === "string") pending.reject(new Error(value.error)); else pending.resolve(value.value);
    } else if (typeof value?.id === "number" && typeof value.op === "string") {
      this.handling++;
      this.handle(this, value.op, value.body).then(result => this.post({ reply: value.id, value: result ?? null }), error => this.post({ reply: value.id, error: message(error) }))
        .finally(() => { this.handling--; });
    }
  }

  request(op: string, body?: unknown, timeout = 10000): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`${this.peer.name} is offline.`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(unanswered(`${this.peer.name} did not answer. A command may have completed there.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ id, op, body });
    });
  }

  private post(value: unknown) { if (!this.closed) { try { this.send(this.cipher.seal(value)); } catch { this.end(); } } }

  end() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(unanswered(`Lost the connection to ${this.peer.name}.`)); }
    this.pending.clear();
    try { this.hangUp(); } catch {}
  }
}

// The steps both devices share once the pairing code is known: each person accepts, then each
// device sends its group keys and the devices it knows, encrypted with the pairing keys.
class PairingFlow implements Pairing {
  code?: string;
  state: Pairing["state"] = "connecting";
  message?: string;
  private cipher?: Cipher;
  private accepted = false;
  private otherAccepted = false;
  private sentKeys = false;
  private gotKeys = false;
  private timer: ReturnType<typeof setTimeout>;
  // A pairing started before the paired devices were forgotten cannot finish.
  private epoch: number;
  constructor(public id: string, public name: string, readonly incoming: boolean, private send: (text: string) => void, private hangUp: () => void,
    private network: DeviceNetwork, public address?: string) {
    this.epoch = network.keyEpoch;
    this.timer = setTimeout(() => this.fail("Pairing timed out. Try again."), 120000);
  }
  ready(code: string, cipher: Cipher) { this.code = code; this.cipher = cipher; this.state = "confirm"; this.network.pairingChanged(); }
  accept() {
    if (this.state !== "confirm" || !this.cipher) return;
    this.accepted = true; this.state = "waiting";
    this.send(this.cipher.seal({ t: "accept" }));
    this.progress();
  }
  // Declining closes the pairing. A device that declined refuses the same device for a while.
  decline() {
    const active = this.state !== "done" && this.state !== "failed";
    if (active) {
      try { this.send(JSON.stringify({ t: "decline" })); } catch {}
      this.fail("Pairing cancelled.");
      if (this.incoming) this.network.refuse();
    }
    this.network.clearPairing(this);
  }
  receive(data: string) {
    if (data.startsWith("{")) {
      let value: any; try { value = JSON.parse(data); } catch { return this.fail("The other Peel sent an invalid message."); }
      if (value.t === "decline") return this.fail(`${this.name} declined.`);
      if (value.t === "error") return this.fail(typeof value.error === "string" ? value.error : "Pairing failed.");
      return;
    }
    if (!this.cipher) return this.fail("The other Peel sent an invalid message.");
    let value: any; try { value = this.cipher.open(data); } catch { return this.fail("The pairing connection was changed on its way. Try again."); }
    if (value?.t === "accept") { this.otherAccepted = true; this.progress(); }
    else if (value?.t === "keys" && this.accepted && this.otherAccepted) {
      if (this.epoch !== this.network.keyEpoch) return this.fail("The paired devices were forgotten. Pair again.");
      this.network.merge(value.keys, value.known, this.id);
      this.network.remember({ id: this.id, name: this.name, address: this.address, port: typeof value.port === "number" ? value.port : undefined });
      this.gotKeys = true; this.progress();
    }
  }
  private progress() {
    if (this.epoch !== this.network.keyEpoch) return this.fail("The paired devices were forgotten. Pair again.");
    if (this.accepted && this.otherAccepted && !this.sentKeys && this.cipher) {
      this.sentKeys = true;
      this.send(this.cipher.seal({ t: "keys", keys: this.network.groupKeys, known: this.network.shareList(), port: this.network.port }));
    }
    if (this.sentKeys && this.gotKeys) {
      clearTimeout(this.timer);
      this.state = "done"; this.message = `Paired with ${this.name}.`;
      setTimeout(() => { try { this.hangUp(); } catch {} }, 200);
      this.network.paired(this);
    } else this.network.pairingChanged();
  }
  closed() { if (this.state !== "done" && this.state !== "failed") this.fail(`Lost the connection to ${this.name}.`); }
  fail(text: string) {
    if (this.state === "done" || this.state === "failed") return;
    clearTimeout(this.timer);
    this.state = "failed"; this.message = text;
    try { this.hangUp(); } catch {}
    this.network.pairingChanged();
  }
}

// A TCP connection that carries one message per line. Messages are JSON or base64url, which never
// contain a line break.
const maxMessage = 16 * 1024 * 1024;
class Line {
  data: SocketData = { stage: "start" };
  // A connection that has not proven it is paired may send only small messages. A paired device
  // sends a queue of a few hundred songs at most.
  limit = 16 * 1024;
  onopen = () => {};
  onmessage = (_text: string) => {};
  onclose = () => {};
  private buffer = "";
  private ended = false;
  private draining = false;
  private drain() {
    this.draining = false;
    for (let end = this.buffer.indexOf("\n"); end >= 0 && !this.ended; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.length > this.limit) return this.close();
      this.onmessage(line);
    }
    if (!this.ended && this.buffer.length > this.limit) this.close();
  }
  constructor(private socket: TcpSocket) {
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.on("connect", () => this.onopen());
    socket.on("data", (chunk: string) => {
      if (this.ended) return;
      this.buffer += chunk;
      // An unfinished message is held to this stage's limit. Finished lines are checked one by one
      // when they are handled, since the handshake line can arrive together with the first message
      // of the stage after it.
      if (this.buffer.length > maxMessage || this.buffer.indexOf("\n") < 0 && this.buffer.length > this.limit) return this.close();
      // Messages are handled on the next turn of the event loop, not inside the socket's read
      // callback. On Windows, Bun stopped reading a socket that sent a request from inside its
      // read callback and got the reply back at once.
      if (!this.draining) { this.draining = true; setImmediate(() => this.drain()); }
    });
    socket.on("error", () => this.close());
    socket.on("close", () => { this.ended = true; this.onclose(); });
  }
  get remoteAddress() { return (this.socket.remoteAddress ?? "").replace(/^::ffff:/, ""); }
  send(text: string) { if (!this.ended) this.socket.write(text + "\n"); }
  // Messages already written still go out, such as a refusal sent just before closing.
  close() {
    if (this.ended) return;
    this.ended = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }
}

type SocketData = { stage: "start" | "auth" | "session" | "pair-reveal" | "pair"; epoch?: number; timer?: ReturnType<typeof setTimeout>; expect?: string; cipher?: Cipher; client?: Hello; session?: Session; ephemeral?: Ephemeral; offer?: PairOffer; pairing?: PairingFlow };

export interface NetworkOptions {
  local: LocalPlayer;
  dir?: string;
  name?: string;
  port?: number;
  discoveryPort?: number;
  // Tests connect devices directly instead of broadcasting.
  discovery?: boolean;
  announceEvery?: number;
  // Tests run several devices on one computer and reach them at its own addresses.
  allowOwnAddresses?: boolean;
}

export class DeviceNetwork extends EventEmitter {
  id = "";
  name: string;
  groupKeys: GroupKey[] = [];
  claim: Claim = { device: "", generation: 0 };
  pairing?: PairingFlow;
  port: number;
  private known = new Map<string, Known>();
  private nearby = new Map<string, Nearby>();
  private summaries = new Map<string, Summary | undefined>();
  private sessions = new Map<string, Set<Session>>();
  private connecting = new Map<string, number>();
  // Set when this device declined a pairing. Every request is refused for a while after that, so a
  // device cannot keep a prompt on screen by changing its ID.
  private declined = 0;
  // The incoming pairing being set up, from its first message. Only one at a time.
  private pairingSocket?: Line;
  // Raised when the group keys change, so a handshake started with the old keys cannot finish.
  private epoch = 0;
  get keyEpoch() { return this.epoch; }
  // When this device last tried to reach each device, so retries take turns.
  private attempts = new Map<string, number>();
  private turns = new Map<string, number>();
  private missed = new WeakMap<Session, number>();
  private checking = new WeakSet<Session>();
  private sockets = new Set<Line>();
  private clients = new Set<Line>();
  private server?: Server;
  private socket?: Socket;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private dir: string;

  constructor(private options: NetworkOptions) {
    super();
    this.name = options.name ?? deviceName();
    this.port = options.port ?? devicePort;
    this.dir = options.dir ?? configDir;
  }

  // Only one Peel per computer runs the devices: the one that listens on the device port. Another
  // window waits and takes over once that one closes, so pairing, keys, and forgetting stay in
  // one place.
  active = false;

  async start() {
    await this.load();
    await this.listen();
    const every = this.options.announceEvery ?? 3000;
    this.timers.push(setInterval(() => this.tick(), every));
    this.timers.push(setInterval(() => void this.poll(), 2000));
    if (this.server) this.activate();
    this.changed();
  }

  private activate() {
    this.active = true;
    // Connections that arrived while this Peel was reading the keys start again.
    this.epoch++;
    for (const socket of this.sockets) if (socket.data.stage !== "session") socket.close();
    if (this.options.discovery !== false) this.discover();
    this.tick();
    this.changed();
  }

  private deactivate() {
    this.active = false;
    this.epoch++;
    this.pairing?.fail("Another Peel window handles devices now.");
    for (const socket of [...this.sockets, ...this.clients]) socket.close();
    for (const sessions of this.sessions.values()) for (const session of sessions) session.end();
    this.sessions.clear(); this.summaries.clear();
    try { this.socket?.close(); } catch {}
    this.socket = undefined;
    this.changed();
  }

  private async load() {
    const stored = await readCache<Stored>("devices.json", this.dir);
    this.id = validId(stored?.id) ? stored.id : randomUUID();
    this.groupKeys = Array.isArray(stored?.keys) ? stored.keys.filter(key => validId(key?.id) && typeof key.key === "string" && keyId(Buffer.from(key.key, "base64url")) === key.id) : [];
    if (!this.groupKeys.length) this.groupKeys = [newGroupKey()];
    this.known.clear();
    for (const value of Array.isArray(stored?.known) ? stored.known.slice(0, 64) : []) { const device = readKnown(value); if (device && device.id !== this.id) this.known.set(device.id, device); }
    this.claim = validClaim(stored?.output) ? stored.output : { device: this.id, generation: 0 };
    if (!stored || stored.id !== this.id) await saveJson("devices.json", { id: this.id, keys: this.groupKeys, known: this.knownList(), output: this.claim }, this.dir).catch(() => {});
  }

  private persist() {
    if (!this.active) return Promise.resolve();
    const stored: Stored = { id: this.id, keys: this.groupKeys, known: this.knownList(), output: this.claim };
    return saveJson("devices.json", stored, this.dir).catch(() => {});
  }

  changed() { if (!this.stopped) this.emit("change"); }
  pairingChanged() { this.changed(); }

  knownList() { return [...this.known.values()]; }
  // What this device tells paired devices: the devices it knows, and itself with its addresses.
  shareList(): Known[] { return [...this.knownList(), { id: this.id, name: this.name, port: this.port, addresses: ownAddresses() }]; }
  online(id: string) { return [...this.sessions.get(id) ?? []].some(session => !session.closed); }
  private session(id: string) { return [...this.sessions.get(id) ?? []].reverse().find(session => !session.closed && !session.retiring); }
  nameOf(id: string) { return id === this.id ? this.name : this.known.get(id)?.name ?? this.nearby.get(id)?.name ?? "the other device"; }

  // The device list for the popup: this computer, then paired devices, then nearby ones to pair.
  views(): DeviceView[] {
    const views: DeviceView[] = [{ id: this.id, name: this.name, self: true, paired: true, online: true, output: this.claim.device === this.id, summary: this.summaries.get(this.id),
      ...(this.active ? {} : { note: "Another Peel window on this computer handles devices." }) }];
    if (!this.active) return views;
    const now = Date.now();
    // A paired device that reset its pairing announces keys this one lacks. It can be paired again.
    const unpaired = (id: string) => { const device = this.nearby.get(id); return !!device && now - device.seen < 12000 && !this.online(id) && !device.keys.some(key => this.groupKeys.some(own => own.id === key)); };
    const paired = [...this.known.values()].filter(device => device.id !== this.id && !unpaired(device.id)).sort((a, b) => a.name.localeCompare(b.name));
    for (const device of paired) views.push({ id: device.id, name: device.name, self: false, paired: true, online: this.online(device.id), output: this.claim.device === device.id, summary: this.online(device.id) ? this.summaries.get(device.id) : undefined });
    const others = [...this.nearby.values()].filter(device => (!this.known.has(device.id) || unpaired(device.id)) && now - device.seen < 12000).sort((a, b) => a.name.localeCompare(b.name));
    for (const device of others) views.push({ id: device.id, name: device.name, self: false, paired: false, online: true, output: false });
    return views;
  }

  // Requests for a paired device's engine.
  request(id: string, path: string, body?: unknown) {
    const session = this.session(id);
    if (!session) return Promise.reject(new Error(`${this.nameOf(id)} is offline. Open Peel on it, on the same network.`));
    // Starting the engine there can include its first sign-in.
    return session.request("engine", { path, body }, path === "/state" ? 15000 : 120000);
  }

  // This device's view of who plays moves to device, and every connected device hears about it.
  claimOutput(device: string) {
    this.claim = { device, generation: this.claim.generation + 1 };
    void this.persist();
    for (const sessions of this.sessions.values()) for (const session of sessions) if (!session.closed) void session.request("claim", { claim: this.claim }).catch(() => {});
    this.emit("claim", this.claim);
    this.changed();
  }

  adopt(claim: unknown) {
    // Generation 0 is every device's own starting point, not a choice anyone made.
    if (!validClaim(claim) || claim.generation < 1 || !newer(claim, this.claim)) return;
    this.claim = { device: claim.device, generation: claim.generation };
    void this.persist();
    // The music moved to another device, so this one stops.
    if (claim.device !== this.id) void this.options.local.pause().catch(() => {});
    this.emit("claim", this.claim);
    this.changed();
  }

  // from is the device that sent the list. Only a device itself changes how it is reached.
  merge(keys: unknown, known: unknown, from?: string) {
    let changed = false;
    for (const key of Array.isArray(keys) ? keys.slice(0, 16) : []) {
      if (this.groupKeys.length >= 16) break;
      if (!validId(key?.id) || typeof key.key !== "string" || this.groupKeys.some(own => own.id === key.id)) continue;
      const bytes = Buffer.from(key.key, "base64url");
      if (bytes.length !== 32 || keyId(bytes) !== key.id) continue;
      this.groupKeys.push({ id: key.id, key: key.key }); changed = true;
    }
    for (const value of Array.isArray(known) ? known.slice(0, 256) : []) {
      const device = readKnown(value);
      if (!device || device.id === this.id) continue;
      if (!this.known.has(device.id) && this.known.size >= 64) continue;
      if (this.known.has(device.id)) {
        if (device.id === from) this.remember({ id: device.id, name: this.known.get(device.id)!.name, port: device.port, addresses: [...device.addresses ?? [], ...device.address ? [device.address] : []] });
        continue;
      }
      this.known.set(device.id, device);
      changed = true;
    }
    if (changed) { void this.persist(); this.changed(); }
  }

  remember(device: Known) {
    if (device.id === this.id) return;
    const previous = this.known.get(device.id);
    if (!previous && this.known.size >= 64) return;
    const addresses = [...new Set([...device.addresses ?? [], ...previous?.addresses ?? []].filter(validAddress))].slice(0, 8);
    const next: Known = { id: device.id, name: device.name, address: device.address ?? previous?.address, port: device.port ?? previous?.port, ...(addresses.length ? { addresses } : {}) };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.known.set(device.id, next);
    void this.persist();
  }

  // Forgets every paired device and starts a new group of one. Devices paired before keep the old
  // key, so this computer can no longer reach them or be reached by them.
  async forget() {
    if (!this.active) throw new Error("Another Peel window on this computer handles devices. Forget them there.");
    this.epoch++;
    this.pairing?.fail("The paired devices were forgotten.");
    this.pairing = undefined;
    for (const socket of this.sockets) socket.close();
    for (const socket of this.clients) socket.close();
    for (const sessions of this.sessions.values()) for (const session of sessions) session.end();
    this.sessions.clear(); this.known.clear(); this.summaries.clear();
    this.groupKeys = [newGroupKey()];
    // A new group starts its claims again, even after a paired device sent a huge generation.
    this.claim = { device: this.id, generation: 1 };
    await this.persist();
    this.emit("claim", this.claim);
    this.changed();
  }

  // UDP announcements: who is here and which group keys they hold, by key ID only.
  private announcement() {
    return Buffer.from(JSON.stringify({ peel: 1, id: this.id, name: this.name, port: this.port, keys: this.groupKeys.map(key => key.id) }));
  }

  private discover() {
    const port = this.options.discoveryPort ?? discoveryPort;
    const socket = this.socket = createSocket({ type: "udp4", reuseAddr: true });
    let bound = false;
    // A port that cannot be bound turns discovery off. Paired devices are still tried at their
    // last address. A failed send to one network is ignored.
    socket.on("error", () => { if (bound) return; try { socket.close(); } catch {} if (this.socket === socket) this.socket = undefined; });
    socket.on("message", (data, from) => {
      if (data.length > 4096) return;
      let value: any; try { value = JSON.parse(data.toString()); } catch { return; }
      if (value?.peel !== 1 || !validId(value.id) || value.id === this.id || !text(value.name, 100) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return;
      const first = !this.nearby.has(value.id) || Date.now() - this.nearby.get(value.id)!.seen > 12000;
      const keys = Array.isArray(value.keys) ? value.keys.filter(validId).slice(0, 64) : [];
      // Announcements are not authenticated, so a flood of made-up devices is bounded.
      if (!this.nearby.has(value.id) && this.nearby.size >= 64) return;
      this.nearby.set(value.id, { id: value.id, name: value.name, address: from.address, port: value.port, keys, seen: Date.now() });
      // Answering a new device directly lets it list this one at once.
      if (first) { socket.send(this.announcement(), port, from.address, () => {}); this.changed(); }
      const shared = keys.some((id: string) => this.groupKeys.some(key => key.id === id));
      // A device is remembered only once its session proves it holds a shared key. A device
      // reached another way, such as over Tailscale, is reached on this network instead, which
      // is usually faster and does not depend on another service.
      if (shared) this.connect(value.id, from.address, value.port, true);
    });
    socket.bind(port, () => { bound = true; try { socket.setBroadcast(true); } catch {} this.announce(); });
  }

  private announce() {
    const socket = this.socket;
    if (!socket) return;
    const port = this.options.discoveryPort ?? discoveryPort, data = this.announcement();
    const targets = new Set(["255.255.255.255"]);
    for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || address.netmask === "255.255.255.255") continue;
      const ip = address.address.split(".").map(Number), mask = address.netmask.split(".").map(Number);
      targets.add(ip.map((part, index) => (part & mask[index]!) | (~mask[index]! & 255)).join("."));
    }
    for (const target of targets) { try { socket.send(data, port, target, () => {}); } catch {} }
  }

  private tick() {
    if (this.stopped) return;
    if (!this.active) {
      if (!this.server) void this.listen().then(async () => { if (this.server && !this.active && !this.stopped) { await this.load(); this.activate(); } });
      return;
    }
    this.announce();
    if (!this.server) this.listen();
    // Paired devices are also tried at their last address, which reaches them across networks
    // that do not pass broadcasts, such as Tailscale.
    // Each try uses the next of the device's addresses, so one that works on another network,
    // such as its Tailscale address, is reached in turn.
    const waiting = [...this.known.values()].filter(device => device.port && (device.address || device.addresses?.length) && !this.online(device.id))
      .sort((a, b) => (this.attempts.get(a.id) ?? 0) - (this.attempts.get(b.id) ?? 0));
    for (const device of waiting) {
      // A device's list never makes Peel connect to this computer itself.
      const own = this.options.allowOwnAddresses ? [] : ownAddresses();
      const candidates = [...new Set([...device.address ? [device.address] : [], ...device.addresses ?? []])].filter(address => !own.includes(address));
      if (!candidates.length) continue;
      const turn = this.turns.get(device.id) ?? 0;
      if (Date.now() - (this.connecting.get(device.id) ?? 0) < 5000) continue;
      this.turns.set(device.id, turn + 1);
      this.connect(device.id, candidates[turn % candidates.length]!, device.port!);
    }
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.nearby) if (now - device.seen > 12000) { this.nearby.delete(id); changed = true; }
    if (changed) this.changed();
  }

  // Asks every connected device what it plays, and tells it which device this one thinks plays.
  private async poll() {
    if (this.stopped || !this.active) return;
    const own = await this.options.local.summary().catch(() => undefined);
    if (JSON.stringify(own) !== JSON.stringify(this.summaries.get(this.id))) { this.summaries.set(this.id, own); this.changed(); }
    await Promise.all([...this.sessions.keys()].map(async id => {
      const session = this.session(id);
      if (!session || this.checking.has(session)) return;
      this.checking.add(session);
      try {
        const status = await session.request("status", { claim: this.claim, keys: this.groupKeys.map(key => key.id) }, 5000);
        this.adopt(status?.claim);
        if (text(status?.name, 100)) this.remember({ id, name: status.name, port: validPort(status.port) ? status.port : undefined, addresses: Array.isArray(status.addresses) ? status.addresses.filter(validAddress).slice(0, 8) : undefined });
        if (Array.isArray(status?.keys) && (status.keys.some((key: string) => !this.groupKeys.some(own => own.id === key)) || this.groupKeys.some(own => !status.keys.includes(own.id)))) await this.sync(session);
        const summary = status?.summary && typeof status.summary.state === "string" ? { state: status.summary.state, song: typeof status.summary.song === "string" ? status.summary.song : undefined, artist: typeof status.summary.artist === "string" ? status.summary.artist : undefined } : undefined;
        if (JSON.stringify(summary) !== JSON.stringify(this.summaries.get(id))) { this.summaries.set(id, summary); this.changed(); }
        this.missed.delete(session);
      } catch {
        // A computer that went to sleep keeps its connection open but stops answering. Two missed
        // checks in a row, about ten seconds, count as offline.
        const missed = (this.missed.get(session) ?? 0) + 1;
        this.missed.set(session, missed);
        if (missed >= 2 && !session.closed) session.end();
      } finally { this.checking.delete(session); }
    }));
  }

  private async sync(session: Session) {
    const reply = await session.request("keys", { keys: this.groupKeys, known: this.shareList() });
    this.merge(reply?.keys, reply?.known, session.peer.id);
  }

  // What a paired device may ask this one.
  private async handle(session: Session, op: string, body: any): Promise<unknown> {
    if (op === "status") {
      this.adopt(body?.claim);
      // The answer does not wait for the engine, so a slow engine does not look like a lost device.
      return { name: this.name, summary: this.summaries.get(this.id), claim: this.claim, keys: this.groupKeys.map(key => key.id), port: this.port, addresses: ownAddresses() };
    }
    if (op === "claim") { this.adopt(body?.claim); return this.claim; }
    if (op === "keys") { this.merge(body?.keys, body?.known, session.peer.id); return { keys: this.groupKeys, known: this.shareList() }; }
    if (op === "engine") {
      if (!allowedRequest(body?.path, body?.body)) throw new Error("This request is not allowed from another device.");
      return this.options.local.send(body.path, body.body);
    }
    throw new Error(`Unknown request ${op}. Update Peel on both devices.`);
  }

  private register(session: Session) {
    const sessions = this.sessions.get(session.peer.id) ?? new Set();
    sessions.add(session); this.sessions.set(session.peer.id, sessions);
    this.remember({ id: session.peer.id, name: session.peer.name, address: session.peer.address });
    this.emit("online", session.peer.id);
    this.changed();
    void this.poll();
    // Music that started before any device was chosen makes this device the one that plays.
    if (this.claim.device === this.id && this.claim.generation === 0) void this.options.local.summary().then(summary => { if (summary?.state === "playing" && this.claim.generation === 0) this.claimOutput(this.id); }, () => {});
  }

  private unregister(session: Session) {
    const sessions = this.sessions.get(session.peer.id);
    sessions?.delete(session);
    if (sessions && !sessions.size) { this.sessions.delete(session.peer.id); this.summaries.delete(session.peer.id); }
    if (!this.stopped) { this.emit("offline", session.peer.id); this.changed(); }
  }

  // The listening side, on every network address. Another Peel on this computer may already
  // listen, and this one tries again later.
  private listen() {
    if (this.server || this.stopped) return Promise.resolve();
    const server = this.server = createServer(raw => {
      const socket = new Line(raw);
      // A connection that has not finished its handshake in ten seconds is closed. Pairing has its own limit.
      if (this.sockets.size >= 64 || this.stopped) return socket.close();
      this.sockets.add(socket);
      socket.data.epoch = this.epoch;
      socket.data.timer = setTimeout(() => { if (socket.data.stage !== "session" && socket.data.stage !== "pair") socket.close(); }, 10000);
      socket.onmessage = data => this.incoming(socket, data);
      socket.onclose = () => {
        this.sockets.delete(socket); clearTimeout(socket.data.timer);
        if (this.pairingSocket === socket) this.pairingSocket = undefined;
        socket.data.session?.end(); socket.data.pairing?.closed();
      };
    });
    // A port another Peel on this computer already uses, or a later error, closes this server.
    // tick() tries to listen again.
    server.on("error", () => {
      try { server.close(); } catch {}
      if (this.server !== server) return;
      this.server = undefined;
      // Another Peel window may take the port now, so this one stops handling devices.
      if (this.active) this.deactivate();
    });
    return new Promise<void>(resolve => {
      server.once("error", () => resolve());
      server.listen(this.port, "0.0.0.0", () => {
        const address = server.address();
        if (address && typeof address === "object") this.port = address.port;
        resolve();
      });
    });
  }

  private incoming(socket: Line, data: string) {
    const state = socket.data;
    // Until this Peel has read the keys it owns, it accepts no handshake.
    if (!this.active || state.epoch !== this.epoch) return socket.close();
    if (state.stage === "session") return state.session?.receive(data);
    if (state.stage === "pair") return state.pairing?.receive(data);
    if (data.length > 8192) return socket.close();
    let value: any; try { value = JSON.parse(data); } catch { return socket.close(); }
    if (state.stage === "start" && value?.t === "hello" && value.v === 1 && validId(value.id) && text(value.name, 100) && typeof value.e === "string" && typeof value.n === "string" && Array.isArray(value.keys)) {
      const ephemeral = new Ephemeral();
      let answer: ReturnType<typeof serverHello>;
      try { answer = serverHello(ephemeral, this.id, this.name, this.groupKeys, value); } catch { return socket.close(); }
      if (!answer) { socket.send(JSON.stringify({ t: "error", error: "not paired" })); return socket.close(); }
      Object.assign(state, { stage: "auth", expect: answer.expect, cipher: answer.cipher, client: value });
      socket.send(JSON.stringify(answer.hello));
      return;
    }
    if (state.stage === "auth" && value?.t === "auth") {
      if (this.stopped || state.epoch !== this.epoch || !checkAuth(value, state.expect!)) return socket.close();
      const client = state.client!;
      const session = new Session({ id: client.id, name: client.name, address: socket.remoteAddress }, state.cipher!, text => socket.send(text), () => socket.close(), (session, op, body) => this.handle(session, op, body));
      state.stage = "session"; state.session = session; socket.limit = maxMessage;
      const end = session.end.bind(session);
      session.end = () => { if (session.closed) return; end(); this.unregister(session); };
      this.register(session);
      return;
    }
    if (state.stage === "start" && value?.t === "pair" && value.v === 1 && validId(value.id) && text(value.name, 100) && typeof value.commit === "string") {
      const refused = this.pairingSocket || this.pairing && this.pairing.state !== "done" && this.pairing.state !== "failed" ? `${this.name} is pairing with another device. Try again later.`
        : Date.now() - this.declined < 30000 ? `${this.name} declined a moment ago. Try again later.` : value.id === this.id ? `${this.name} is this device.`
        : Date.now() > this.pairable ? `${this.name} is not open for pairing. Press d in Peel on ${this.name}, then try again.` : "";
      if (refused) { socket.send(JSON.stringify({ t: "error", error: refused })); return socket.close(); }
      const ephemeral = new Ephemeral();
      const offer: PairOffer = { t: "pair", v: 1, id: this.id, name: this.name, e: ephemeral.public, n: ephemeral.nonce };
      Object.assign(state, { stage: "pair-reveal", ephemeral, offer, client: value });
      this.pairingSocket = socket;
      socket.send(JSON.stringify(offer));
      return;
    }
    if (state.stage === "pair-reveal" && value?.t === "reveal") {
      if (this.pairingSocket !== socket || this.pairing && this.pairing.state !== "done" && this.pairing.state !== "failed") return socket.close();
      const initiator = state.client as unknown as PairOffer;
      let derived: ReturnType<typeof pairingKeys>;
      try { derived = pairingKeys(state.ephemeral!, initiator, state.offer!, value); } catch { return socket.close(); }
      const flow = new PairingFlow(initiator.id, initiator.name, true, text => socket.send(text), () => socket.close(), this, socket.remoteAddress);
      state.stage = "pair"; state.pairing = flow; socket.limit = maxMessage;
      this.pairing = flow;
      flow.ready(derived.code, derived.cipher("responder"));
      this.emit("pairing", flow);
      return;
    }
    socket.close();
  }

  // The connecting side of a session, to a paired device.
  private connect(id: string, address: string, port: number, local = false) {
    if (!this.active) return;
    const sessions = [...this.sessions.get(id) ?? []].filter(session => !session.closed);
    if (this.stopped || id === this.id || Date.now() - (this.connecting.get(id) ?? 0) < 5000) return;
    // A device already reached on this network keeps that connection. A computer with two network
    // cards on one network announces itself from either address, which must not swap connections.
    if (sessions.length && (!local || sessions.some(session => session.peer.address === address || onLocalNetwork(session.peer.address ?? "")))) return;
    // Few connections are on their way at once, however many devices announce themselves.
    if (this.clients.size >= 8) return;
    this.attempts.set(id, Date.now());
    for (const [other, started] of this.connecting) if (Date.now() - started > 10000) this.connecting.delete(other);
    this.connecting.set(id, Date.now());
    const groups = this.groupKeys, epoch = this.epoch;
    let socket: Line;
    try { socket = new Line(connectTcp({ host: address, port })); } catch { return; }
    this.clients.add(socket);
    const ephemeral = new Ephemeral(), hello = clientHello(ephemeral, this.id, this.name, groups);
    let session: Session | undefined;
    const timer = setTimeout(() => { if (!session) socket.close(); }, 6000);
    socket.onopen = () => socket.send(JSON.stringify(hello));
    socket.onmessage = data => {
      if (session) return session.receive(data);
      let server: Hello;
      try { server = JSON.parse(data); } catch { return socket.close(); }
      if (server?.t !== "hello" || server.id !== id || !text(server.name, 100)) return socket.close();
      if (epoch !== this.epoch || this.stopped) return socket.close();
      let finished: ReturnType<typeof clientFinish>;
      try { finished = clientFinish(ephemeral, groups, hello, server); } catch { return socket.close(); }
      this.clients.delete(socket);
      socket.limit = maxMessage;
      socket.send(JSON.stringify(finished.auth));
      clearTimeout(timer);
      const opened: Session = session = new Session({ id, name: server.name, address }, finished.cipher, text => socket.send(text), () => socket.close(), (session, op, body) => this.handle(session, op, body));
      const end = opened.end.bind(opened);
      opened.end = () => { if (opened.closed) return; end(); this.unregister(opened); };
      this.connecting.delete(id);
      this.remember({ id, name: server.name, address, port });
      this.register(opened);
      // The connection on this network replaces one made another way.
      if (local) for (const other of sessions) if (!other.closed && other.peer.address !== address) other.retire();
      void this.sync(opened).catch(() => {});
    };
    socket.onclose = () => { clearTimeout(timer); this.clients.delete(socket); session?.end(); };
  }

  // Starts pairing with a nearby device. Both screens then show the same code.
  pair(id: string) {
    if (!this.active) throw new Error("Another Peel window on this computer handles devices. Pair there.");
    const device = this.nearby.get(id);
    if (!device) throw new Error("That device is no longer nearby.");
    if (this.pairing && this.pairing.state !== "done" && this.pairing.state !== "failed") throw new Error("Finish the pairing that is open first.");
    const socket = new Line(connectTcp({ host: device.address, port: device.port }));
    const ephemeral = new Ephemeral();
    const offer: PairOffer = { t: "pair", v: 1, id: this.id, name: this.name, commit: commitment(ephemeral) };
    const flow = this.pairing = new PairingFlow(device.id, device.name, false, text => socket.send(text), () => socket.close(), this, device.address);
    let stage: "offer" | "pair" = "offer";
    let reached = false;
    socket.onopen = () => { reached = true; socket.send(JSON.stringify(offer)); };
    socket.onmessage = data => {
      if (stage === "pair") return flow.receive(data);
      let value: any; try { value = JSON.parse(data); } catch { return flow.fail("The other Peel sent an invalid message."); }
      if (value?.t === "error") return flow.fail(typeof value.error === "string" ? value.error : "Pairing failed.");
      if (value?.t !== "pair" || value.id !== device.id || typeof value.e !== "string" || typeof value.n !== "string") return flow.fail("The other Peel sent an invalid message.");
      let derived: ReturnType<typeof pairingKeys>;
      try { derived = pairingKeys(ephemeral, offer, value, { e: ephemeral.public, n: ephemeral.nonce }); } catch { return flow.fail("The other Peel sent an invalid key."); }
      socket.send(JSON.stringify({ t: "reveal", e: ephemeral.public, n: ephemeral.nonce }));
      stage = "pair"; socket.limit = maxMessage;
      flow.ready(derived.code, derived.cipher("initiator"));
    };
    socket.onclose = () => reached ? flow.closed() : flow.fail(`Could not reach ${device.name}.`);
    this.changed();
    return flow;
  }

  paired(flow: PairingFlow) {
    const device = this.known.get(flow.id);
    if (device?.address && device.port) { this.connecting.delete(flow.id); this.connect(flow.id, device.address, device.port); }
    setTimeout(() => this.clearPairing(flow), 3000);
    this.changed();
  }

  clearPairing(flow: PairingFlow) {
    if (this.pairing !== flow) return;
    this.pairing = undefined;
    this.changed();
  }
  refuse() { this.declined = Date.now(); }
  // A device accepts pairing requests only for two minutes after someone opened its devices popup,
  // so another device on the network cannot put a pairing prompt on screen at any time.
  private pairable = 0;
  openForPairing() { this.pairable = Date.now() + 120000; }

  // Tests and other callers outside discovery connect to a device directly.
  connectTo(id: string, address: string, port: number) { this.connecting.delete(id); this.connect(id, address, port); }
  pairWith(device: Nearby) { this.nearby.set(device.id, device); return this.pair(device.id); }

  close() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.pairing?.fail("Peel closed.");
    for (const socket of this.clients) { try { socket.close(); } catch {} }
    this.clients.clear();
    for (const socket of this.sockets) { try { socket.close(); } catch {} }
    for (const sessions of this.sessions.values()) for (const session of sessions) session.end();
    this.sessions.clear();
    try { this.socket?.close(); } catch {}
    this.server?.close();
    this.server = undefined;
  }
}
