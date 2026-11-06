import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Engine, ensureEngine, type EngineTransport } from "./engine";
import type { DeviceNetwork, LocalPlayer } from "./devices";

export function validHost(host: string) {
  return /^[a-zA-Z0-9:][a-zA-Z0-9._@:-]*$/.test(host);
}

// SSH carries the engine protocol. Its key and listening port stay on the playback computer.
export class RemoteConnection {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly host: string, private status: (text: string) => void = () => {}, private command = "~/.local/bin/peel --remote-host") {
    if (!validHost(host)) throw new Error("Use an SSH host name or alias for the playback computer.");
  }

  private start() {
    const child = this.child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", this.host, this.command], { windowsHide: true });
    let errorText = "";
    child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-2000); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const reply = JSON.parse(line);
        if (typeof reply.status === "string") { this.status(reply.status); return; }
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id); clearTimeout(pending.timer);
        if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.value);
      } catch { this.fail(child, "The remote Peel returned an invalid response. Update Peel on the playback computer."); }
    });
    child.on("error", error => this.fail(child, `Could not connect to ${this.host}: ${error.message}`));
    child.on("exit", () => this.fail(child, `Lost the connection to ${this.host}. ${errorText.trim() || "Playback stays on that computer. Reconnect to read its state."}`));
    child.stdin.on("error", () => this.fail(child, `Lost the connection to ${this.host}.`));
    return child;
  }

  private fail(child: ChildProcessWithoutNullStreams, message: string) {
    if (this.child !== child) return;
    this.child = undefined;
    child.kill();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }

  request: EngineTransport = (path, body) => {
    const child = this.child ?? this.start(), id = ++this.sequence;
    return new Promise((resolve, reject) => {
      // The first request can include signing in on the host. SSH itself times out sooner if unreachable.
      const timer = setTimeout(() => this.fail(child, `The request to ${this.host} timed out. A command may have completed. Reconnect before trying it again.`), 6 * 60 * 1000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, path, body }) + "\n");
    });
  };

  close() { if (this.child) this.fail(this.child, "Remote controller closed. Playback stays on the host."); }
}

// An Engine with a selectable transport keeps every playback operation on the selected device:
// this computer, a paired Peel on the network, or an SSH host.
export class DevicePlayer extends Engine {
  private remote?: RemoteConnection;
  private localUsed = false;
  private detached = false;
  private starting?: Promise<void>;
  network?: DeviceNetwork;
  // The paired device this Peel controls, when the music plays there.
  peer?: string;
  host?: string;
  // Called when the device that plays changed elsewhere. The model then calls applyTarget.
  onRetarget?: () => void;
  // Tests pass their own engine and startup, so they never start or stop a real engine.
  constructor(host?: string, private status: (text: string) => void = () => {}, private local = new Engine(), private startEngine: typeof ensureEngine = ensureEngine) {
    super(undefined, (path, body) => this.detached ? Promise.reject(new Error("Peel restarted into an update."))
      : this.remote ? this.remote.request(path, body) : this.peer ? this.network!.request(this.peer, path, body) : this.sendLocal(path, body));
    if (host) { this.remote = new RemoteConnection(host, status); this.host = host; }
  }

  private ensureLocal() {
    this.localUsed = true;
    return this.starting ??= this.startEngine(this.local, this.status).finally(() => { this.starting = undefined; });
  }

  // Commands that start music here make this device the one that plays, when another device
  // held the music (for example one that went offline) or no device was chosen yet. Moving
  // music here does not count: the Peel that moves it claims the device once the move worked.
  private async sendLocal(path: string, body?: any) {
    const network = this.network;
    if (network && (network.claim.device !== network.id || network.claim.generation === 0) && path === "/call" && starts.has(body?.method)) network.claimOutput(network.id);
    return this.local.send(path, body);
  }

  // What the device network asks of this computer's engine.
  localPlayer(): LocalPlayer {
    return {
      send: async (path, body) => { await this.ensureLocal(); return this.sendLocal(path, body); },
      summary: async () => {
        const playback = (await this.local.state().catch(() => undefined))?.playback;
        if (!playback) return undefined;
        return { state: playback.state, song: playback.nowPlaying?.name, artist: playback.nowPlaying?.artistName };
      },
      pause: async () => {
        const playback = (await this.local.state().catch(() => undefined))?.playback;
        if (playback?.state === "playing") await this.local.send("/call", { method: "pause", args: [] });
      },
    };
  }

  attach(network: DeviceNetwork) {
    this.network = network;
    const follow = () => { if (this.wanted() !== this.peer) this.onRetarget?.(); };
    network.on("claim", follow); network.on("online", follow); network.on("offline", follow);
  }

  // The device that plays, if this Peel can reach it. Otherwise this computer.
  private wanted() {
    const network = this.network;
    if (!network || this.remote) return this.peer;
    const device = network.claim.device;
    return device !== network.id && network.online(device) ? device : undefined;
  }

  // Follows the device that plays. Returns a message when the controlled device changed.
  applyTarget(): string | undefined {
    const next = this.wanted();
    if (next === this.peer) return undefined;
    const network = this.network!, previous = this.peer;
    this.peer = next;
    if (next) return `Playing on ${network.nameOf(next)}`;
    return previous && !network.online(previous) ? `${network.nameOf(previous)} went offline. Controlling this computer.` : "Playing on this computer";
  }

  // The device this Peel controls, for the player strip. Undefined means this computer.
  get target() { return this.host ?? (this.peer ? this.network?.nameOf(this.peer) : undefined); }

  async ensure(signal?: AbortSignal) {
    if (this.remote) await this.remote.request("/state");
    else if (this.peer) await this.network!.request(this.peer, "/state");
    else { this.localUsed = true; await this.startEngine(this.local, this.status, signal); }
  }

  // The Apple sign-in always comes from this computer's engine. Another device does not share it.
  async appleTokens() {
    if (!this.peer) return super.appleTokens();
    await this.ensureLocal();
    return this.local.appleTokens();
  }

  // Stream quality is each computer's own setting.
  async setQuality(quality: "high" | "standard") {
    if (this.remote || !this.peer) await super.setQuality(quality);
  }

  async select(host?: string) {
    const next = host ? new RemoteConnection(host, this.status) : undefined;
    try {
      if (next) {
        await next.request("/state");
        if (!this.remote && (await this.local.snapshot().catch(() => undefined))?.state === "playing") await this.local.command("/playback/pause");
      }
      else { this.localUsed = true; await this.startEngine(this.local, this.status); }
    } catch (error) { next?.close(); throw error; }
    this.remote?.close(); this.remote = next; this.host = host;
    if (!host) this.peer = this.wanted();
  }

  // Moves the music to device: the queue, the playing song, and its position. The device that
  // played pauses only once the new one has the queue, and keeps playing if that fails.
  async playOn(device: string) {
    const network = this.network;
    if (!network) throw new Error("Devices are not available with this player.");
    const here = device === network.id, name = network.nameOf(device);
    if (!here && !network.online(device)) throw new Error(`${name} is offline. Open Peel on it, on the same network.`);
    const current = this.remote ? `ssh:${this.host}` : this.peer ?? network.id;
    if (current !== device) {
      const source: EngineTransport = this.remote ? this.remote.request : this.peer ? (path, body) => network.request(this.peer!, path, body) : (path, body) => this.local.send(path, body);
      const destination: EngineTransport = here ? async (path, body) => { await this.ensureLocal(); return this.local.send(path, body); } : (path, body) => network.request(device, path, body);
      await moveMusic(source, destination, this.host ?? (this.peer ? network.nameOf(this.peer) : "this computer"), here ? "this computer" : name);
    }
    this.remote?.close(); this.remote = undefined; this.host = undefined;
    this.peer = here ? undefined : device;
    network.claimOutput(device);
  }

  // Closes the remote connection but keeps this computer's engine, for a Peel restarting into an
  // update. Requests still on their way fail instead of reaching another engine.
  detach() { this.detached = true; this.remote?.close(); this.network?.close(); }
  async release() {
    this.remote?.close();
    this.network?.close();
    if (this.localUsed) await this.local.release();
  }
}

const starts = new Set(["play", "enqueue", "resume", "toggle", "jump"]);

export async function moveMusic(source: EngineTransport, destination: EngineTransport, from: string, to: string) {
  const call = (transport: EngineTransport, method: string, ...args: unknown[]) => transport("/call", { method, args });
  // A computer whose engine is not running has nothing to move.
  const state = await source("/state").catch(() => undefined);
  const playback = state?.playback;
  if (!playback?.nowPlaying) return;
  // The same engine reached two ways, such as over SSH and over the network, already plays.
  const target = await destination("/state").catch(() => undefined);
  if (state?.instance && state.instance === target?.instance) return;
  const playing = playback.state === "playing";
  if (playing) await call(source, "pause");
  let exported: any;
  try { exported = await call(source, "exportPlayback"); }
  catch (error) {
    if (playing) await call(source, "resume").catch(() => {});
    throw new Error(`Could not read the queue on ${from}. Update Peel there. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!exported?.items?.length) return;
  try { await call(destination, "importPlayback", { ...exported, playing }); }
  catch (error) {
    // The new device may have started before it failed. It stops before the old one plays again.
    await call(destination, "pause").catch(() => {});
    if (playing) await call(source, "resume").catch(() => {});
    throw new Error(`Could not start the music on ${to}. It keeps playing on ${from}. ${error instanceof Error ? error.message : String(error)}`);
  }
  // A paused player still holds the account's Apple stream, which can stop the new device when
  // Apple allows one stream at a time. The old device stops. Its queue now lives on the new one.
  await call(source, "stop").catch(() => {});
}
