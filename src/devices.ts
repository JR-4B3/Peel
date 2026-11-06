import { createSocket, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { Server, ServerWebSocket } from "bun";
import { configDir, readCache, saveJson } from "./config";
import type { EngineTransport } from "./engine";
import { Cipher, Ephemeral, checkAuth, clientFinish, clientHello, commitment, keyId, newGroupKey, pairingKeys, serverHello, type GroupKey, type Hello, type PairOffer } from "./link";
import type { Playback } from "./types";

// Every Peel on the network is a device. Paired devices reach each other directly over an
// encrypted WebSocket, and find each other through a small UDP broadcast. No device is in
// charge: whichever device plays the music holds the queue, and every Peel controls it.

export const devicePort = Number(process.env.PEEL_DEVICE_PORT ?? 10770);
export const discoveryPort = Number(process.env.PEEL_DISCOVERY_PORT ?? 10771);

// Which device plays. A higher generation wins, and the larger device ID breaks a tie, so two
// devices that move the music at the same moment still agree on one of them.
export interface Claim { device: string; generation: number }
export interface Summary { state: Playback["state"]; song?: string; artist?: string }
export interface DeviceView { id: string; name: string; self: boolean; paired: boolean; online: boolean; output: boolean; summary?: Summary }
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

interface Known { id: string; name: string; address?: string; port?: number }
interface Stored { id: string; keys: GroupKey[]; known: Known[]; output?: Claim }
interface Nearby { id: string; name: string; address: string; port: number; keys: string[]; seen: number }

// The engine methods another device may call. Tokens and stream quality stay on this computer.
const methods = new Set(["state", "pause", "resume", "toggle", "next", "previous", "seek", "volume", "shuffle", "toggleShuffle", "toggleRepeat", "play", "enqueue", "move", "remove", "jump", "queue", "rating", "rate", "exportPlayback", "importPlayback"]);
export function allowedRequest(path: unknown, body: any) {
  if (path === "/state") return body === undefined;
  return path === "/call" && typeof body?.method === "string" && methods.has(body.method) && (body.args === undefined || Array.isArray(body.args));
}

const text = (value: unknown, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max;
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{8,64}$/.test(value);
const validClaim = (value: any): value is Claim => validId(value?.device) && Number.isSafeInteger(value?.generation) && value.generation >= 0;
export const newer = (a: Claim, b: Claim) => a.generation > b.generation || a.generation === b.generation && a.device > b.device;
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
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
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
      this.handle(this, value.op, value.body).then(result => this.post({ reply: value.id, value: result ?? null }), error => this.post({ reply: value.id, error: message(error) }));
    }
  }

  request(op: string, body?: unknown, timeout = 10000): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`${this.peer.name} is offline.`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.peer.name} did not answer. A command may have completed there.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ id, op, body });
    });
  }

  private post(value: unknown) { if (!this.closed) { try { this.send(this.cipher.seal(value)); } catch { this.end(); } } }

  end() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Lost the connection to ${this.peer.name}.`)); }
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
      this.network.merge(value.keys, value.known);
      this.network.remember({ id: this.id, name: this.name, address: this.address, port: typeof value.port === "number" ? value.port : undefined });
      this.gotKeys = true; this.progress();
    }
  }
  private progress() {
    if (this.epoch !== this.network.keyEpoch) return this.fail("The paired devices were forgotten. Pair again.");
    if (this.accepted && this.otherAccepted && !this.sentKeys && this.cipher) {
      this.sentKeys = true;
      this.send(this.cipher.seal({ t: "keys", keys: this.network.groupKeys, known: this.network.knownList(), port: this.network.port }));
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
  private pairingSocket?: ServerWebSocket<SocketData>;
  // Raised when the group keys change, so a handshake started with the old keys cannot finish.
  private epoch = 0;
  get keyEpoch() { return this.epoch; }
  // When this device last tried to reach each device, so retries take turns.
  private attempts = new Map<string, number>();
  private sockets = new Set<ServerWebSocket<SocketData>>();
  private clients = new Set<WebSocket>();
  private server?: Server<SocketData>;
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

  async start() {
    const stored = await readCache<Stored>("devices.json", this.dir);
    this.id = validId(stored?.id) ? stored.id : randomUUID();
    this.groupKeys = Array.isArray(stored?.keys) ? stored.keys.filter(key => validId(key?.id) && typeof key.key === "string" && keyId(Buffer.from(key.key, "base64url")) === key.id) : [];
    if (!this.groupKeys.length) this.groupKeys = [newGroupKey()];
    for (const device of Array.isArray(stored?.known) ? stored.known : []) if (validId(device?.id) && text(device.name)) this.known.set(device.id, { id: device.id, name: device.name, address: typeof device.address === "string" ? device.address : undefined, port: Number.isInteger(device.port) ? device.port : undefined });
    this.claim = validClaim(stored?.output) ? stored.output : { device: this.id, generation: 0 };
    if (!stored || stored.id !== this.id) await this.persist();
    this.listen();
    if (this.options.discovery !== false) this.discover();
    const every = this.options.announceEvery ?? 3000;
    this.timers.push(setInterval(() => this.tick(), every));
    this.timers.push(setInterval(() => void this.poll(), 2000));
    this.tick();
    this.changed();
  }

  private persist() {
    const stored: Stored = { id: this.id, keys: this.groupKeys, known: this.knownList(), output: this.claim };
    return saveJson("devices.json", stored, this.dir).catch(() => {});
  }

  changed() { if (!this.stopped) this.emit("change"); }
  pairingChanged() { this.changed(); }

  knownList() { return [...this.known.values()]; }
  online(id: string) { return [...this.sessions.get(id) ?? []].some(session => !session.closed); }
  private session(id: string) { return [...this.sessions.get(id) ?? []].reverse().find(session => !session.closed); }
  nameOf(id: string) { return id === this.id ? this.name : this.known.get(id)?.name ?? this.nearby.get(id)?.name ?? "the other device"; }

  // The device list for the popup: this computer, then paired devices, then nearby ones to pair.
  views(): DeviceView[] {
    const views: DeviceView[] = [{ id: this.id, name: this.name, self: true, paired: true, online: true, output: this.claim.device === this.id, summary: this.summaries.get(this.id) }];
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

  merge(keys: unknown, known: unknown) {
    let changed = false;
    for (const key of Array.isArray(keys) ? keys : []) {
      if (!validId(key?.id) || typeof key.key !== "string" || this.groupKeys.some(own => own.id === key.id)) continue;
      const bytes = Buffer.from(key.key, "base64url");
      if (bytes.length !== 32 || keyId(bytes) !== key.id) continue;
      this.groupKeys.push({ id: key.id, key: key.key }); changed = true;
    }
    for (const device of Array.isArray(known) ? known : []) {
      if (!validId(device?.id) || !text(device.name) || device.id === this.id || this.known.has(device.id)) continue;
      this.known.set(device.id, { id: device.id, name: device.name, address: typeof device.address === "string" ? device.address : undefined, port: Number.isInteger(device.port) ? device.port : undefined });
      changed = true;
    }
    if (changed) { void this.persist(); this.changed(); }
  }

  remember(device: Known) {
    if (device.id === this.id) return;
    const previous = this.known.get(device.id);
    const next = { id: device.id, name: device.name, address: device.address ?? previous?.address, port: device.port ?? previous?.port };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.known.set(device.id, next);
    void this.persist();
  }

  // Forgets every paired device and starts a new group of one. Devices paired before keep the old
  // key, so this computer can no longer reach them or be reached by them.
  async forget() {
    this.epoch++;
    this.pairing?.fail("The paired devices were forgotten.");
    this.pairing = undefined;
    for (const socket of this.sockets) socket.close();
    for (const socket of this.clients) socket.close();
    for (const sessions of this.sessions.values()) for (const session of sessions) session.end();
    this.sessions.clear(); this.known.clear(); this.summaries.clear();
    this.groupKeys = [newGroupKey()];
    this.claim = { device: this.id, generation: this.claim.generation + 1 };
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
      // A device is remembered only once its session proves it holds a shared key.
      if (shared) this.connect(value.id, from.address, value.port);
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
    this.announce();
    if (!this.server) this.listen();
    // Paired devices are also tried at their last address, which reaches them across networks
    // that do not pass broadcasts, such as Tailscale.
    const waiting = [...this.known.values()].filter(device => device.address && device.port && !this.online(device.id))
      .sort((a, b) => (this.attempts.get(a.id) ?? 0) - (this.attempts.get(b.id) ?? 0));
    for (const device of waiting) this.connect(device.id, device.address!, device.port!);
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.nearby) if (now - device.seen > 12000) { this.nearby.delete(id); changed = true; }
    if (changed) this.changed();
  }

  // Asks every connected device what it plays, and tells it which device this one thinks plays.
  private async poll() {
    if (this.stopped) return;
    const own = await this.options.local.summary().catch(() => undefined);
    if (JSON.stringify(own) !== JSON.stringify(this.summaries.get(this.id))) { this.summaries.set(this.id, own); this.changed(); }
    await Promise.all([...this.sessions.keys()].map(async id => {
      const session = this.session(id);
      if (!session) return;
      try {
        const status = await session.request("status", { claim: this.claim, keys: this.groupKeys.map(key => key.id) }, 5000);
        this.adopt(status?.claim);
        if (text(status?.name, 100) && this.known.get(id)?.name !== status.name) this.remember({ id, name: status.name });
        if (Array.isArray(status?.keys) && (status.keys.some((key: string) => !this.groupKeys.some(own => own.id === key)) || this.groupKeys.some(own => !status.keys.includes(own.id)))) await this.sync(session);
        const summary = status?.summary && typeof status.summary.state === "string" ? { state: status.summary.state, song: typeof status.summary.song === "string" ? status.summary.song : undefined, artist: typeof status.summary.artist === "string" ? status.summary.artist : undefined } : undefined;
        if (JSON.stringify(summary) !== JSON.stringify(this.summaries.get(id))) { this.summaries.set(id, summary); this.changed(); }
      } catch {}
    }));
  }

  private async sync(session: Session) {
    const reply = await session.request("keys", { keys: this.groupKeys, known: this.knownList() });
    this.merge(reply?.keys, reply?.known);
  }

  // What a paired device may ask this one.
  private async handle(session: Session, op: string, body: any): Promise<unknown> {
    if (op === "status") {
      this.adopt(body?.claim);
      return { name: this.name, summary: await this.options.local.summary().catch(() => undefined), claim: this.claim, keys: this.groupKeys.map(key => key.id) };
    }
    if (op === "claim") { this.adopt(body?.claim); return this.claim; }
    if (op === "keys") { this.merge(body?.keys, body?.known); return { keys: this.groupKeys, known: this.knownList() }; }
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
    if (this.server || this.stopped) return;
    try {
      this.server = Bun.serve<SocketData>({
        port: this.port, hostname: "0.0.0.0",
        fetch: (request, server) => server.upgrade(request, { data: { stage: "start" } }) ? undefined : new Response("Peel device port", { status: 426 }),
        websocket: {
          maxPayloadLength: 16 * 1024 * 1024, idleTimeout: 120,
          // A connection that has not finished its handshake in ten seconds is closed. Pairing has its own limit.
          open: socket => {
            if (this.sockets.size >= 64) return socket.close();
            this.sockets.add(socket);
            socket.data.epoch = this.epoch;
            socket.data.timer = setTimeout(() => { if (socket.data.stage !== "session" && socket.data.stage !== "pair") socket.close(); }, 10000);
          },
          message: (socket, data) => this.incoming(socket, typeof data === "string" ? data : data.toString()),
          close: socket => {
            this.sockets.delete(socket); clearTimeout(socket.data.timer);
            if (this.pairingSocket === socket) this.pairingSocket = undefined;
            socket.data.session?.end(); socket.data.pairing?.closed();
          },
        },
      });
      this.port = this.server.port ?? this.port;
    } catch { this.server = undefined; }
  }

  private incoming(socket: ServerWebSocket<SocketData>, data: string) {
    const state = socket.data;
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
      state.stage = "session"; state.session = session;
      const end = session.end.bind(session);
      session.end = () => { if (session.closed) return; end(); this.unregister(session); };
      this.register(session);
      return;
    }
    if (state.stage === "start" && value?.t === "pair" && value.v === 1 && validId(value.id) && text(value.name, 100) && typeof value.commit === "string") {
      const refused = this.pairingSocket || this.pairing && this.pairing.state !== "done" && this.pairing.state !== "failed" ? "is pairing with another device"
        : Date.now() - this.declined < 30000 ? "declined a moment ago" : value.id === this.id ? "is this device" : "";
      if (refused) { socket.send(JSON.stringify({ t: "error", error: `${this.name} ${refused}. Try again later.` })); return socket.close(); }
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
      state.stage = "pair"; state.pairing = flow;
      this.pairing = flow;
      flow.ready(derived.code, derived.cipher("responder"));
      this.emit("pairing", flow);
      return;
    }
    socket.close();
  }

  // The connecting side of a session, to a paired device.
  private connect(id: string, address: string, port: number) {
    if (this.stopped || id === this.id || this.online(id) || Date.now() - (this.connecting.get(id) ?? 0) < 5000) return;
    // Few connections are on their way at once, however many devices announce themselves.
    if (this.clients.size >= 8) return;
    this.attempts.set(id, Date.now());
    for (const [other, started] of this.connecting) if (Date.now() - started > 10000) this.connecting.delete(other);
    this.connecting.set(id, Date.now());
    const groups = this.groupKeys, epoch = this.epoch;
    let socket: WebSocket;
    try { socket = new WebSocket(`ws://${address.includes(":") ? `[${address}]` : address}:${port}`); } catch { return; }
    this.clients.add(socket);
    const ephemeral = new Ephemeral(), hello = clientHello(ephemeral, this.id, this.name, groups);
    let session: Session | undefined;
    const timer = setTimeout(() => { if (!session) socket.close(); }, 6000);
    socket.onopen = () => socket.send(JSON.stringify(hello));
    socket.onmessage = event => {
      const data = String(event.data);
      if (session) return session.receive(data);
      let server: Hello;
      try { server = JSON.parse(data); } catch { return socket.close(); }
      if (server?.t !== "hello" || server.id !== id || !text(server.name, 100)) return socket.close();
      if (epoch !== this.epoch || this.stopped) return socket.close();
      let finished: ReturnType<typeof clientFinish>;
      try { finished = clientFinish(ephemeral, groups, hello, server); } catch { return socket.close(); }
      this.clients.delete(socket);
      socket.send(JSON.stringify(finished.auth));
      clearTimeout(timer);
      const opened: Session = session = new Session({ id, name: server.name, address }, finished.cipher, text => socket.send(text), () => socket.close(), (session, op, body) => this.handle(session, op, body));
      const end = opened.end.bind(opened);
      opened.end = () => { if (opened.closed) return; end(); this.unregister(opened); };
      this.connecting.delete(id);
      this.remember({ id, name: server.name, address, port });
      this.register(opened);
      void this.sync(opened).catch(() => {});
    };
    socket.onclose = () => { clearTimeout(timer); this.clients.delete(socket); session?.end(); };
    socket.onerror = () => socket.close();
  }

  // Starts pairing with a nearby device. Both screens then show the same code.
  pair(id: string) {
    const device = this.nearby.get(id);
    if (!device) throw new Error("That device is no longer nearby.");
    if (this.pairing && this.pairing.state !== "done" && this.pairing.state !== "failed") throw new Error("Finish the pairing that is open first.");
    const socket = new WebSocket(`ws://${device.address}:${device.port}`);
    const ephemeral = new Ephemeral();
    const offer: PairOffer = { t: "pair", v: 1, id: this.id, name: this.name, commit: commitment(ephemeral) };
    const flow = this.pairing = new PairingFlow(device.id, device.name, false, text => socket.send(text), () => socket.close(), this, device.address);
    let stage: "offer" | "pair" = "offer";
    socket.onopen = () => socket.send(JSON.stringify(offer));
    socket.onmessage = event => {
      const data = String(event.data);
      if (stage === "pair") return flow.receive(data);
      let value: any; try { value = JSON.parse(data); } catch { return flow.fail("The other Peel sent an invalid message."); }
      if (value?.t === "error") return flow.fail(typeof value.error === "string" ? value.error : "Pairing failed.");
      if (value?.t !== "pair" || value.id !== device.id || typeof value.e !== "string" || typeof value.n !== "string") return flow.fail("The other Peel sent an invalid message.");
      let derived: ReturnType<typeof pairingKeys>;
      try { derived = pairingKeys(ephemeral, offer, value, { e: ephemeral.public, n: ephemeral.nonce }); } catch { return flow.fail("The other Peel sent an invalid key."); }
      socket.send(JSON.stringify({ t: "reveal", e: ephemeral.public, n: ephemeral.nonce }));
      stage = "pair";
      flow.ready(derived.code, derived.cipher("initiator"));
    };
    socket.onclose = () => flow.closed();
    socket.onerror = () => flow.fail(`Could not reach ${device.name}.`);
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
    this.server?.stop(true);
  }
}
