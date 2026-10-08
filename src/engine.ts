import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Media, Page, Playback, Player } from "./types";

// Peel's own playback engine in engine/: MusicKit JS in castlabs' Electron. It writes its
// port and a private key to ~/.config/peel-engine/key.json each time it starts.
export const engineHome = process.env.PEEL_ENGINE_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "peel-engine");
const launcher = new URL("../engine/run.sh", import.meta.url).pathname;

interface State { ready: boolean; signIn: boolean; playback?: Playback }
interface Queue { position: number; items: { id: string; type: string; attributes: { name?: string; artistName?: string; albumName?: string; durationInMillis?: number } }[] }

export class Engine implements Player {
  readonly queuesItems = true;
  private access?: { port: number; key: string };

  constructor(private home = engineHome) {}

  private async read() {
    try { this.access = JSON.parse(await readFile(join(this.home, "key.json"), "utf8")); } catch { this.access = undefined; }
    return this.access;
  }

  // A restarted engine has a new key, so a rejected key is read again once.
  private async send(path: string, body?: unknown, retry = true): Promise<any> {
    const access = this.access ?? await this.read();
    if (!access) throw new Error("Peel's playback engine is not running.");
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${access.port}${path}`, {
        method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "x-peel-key": access.key, "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
      });
    } catch { this.access = undefined; throw new Error("Peel's playback engine is not running."); }
    if (response.status === 403 && retry) { await this.read(); return this.send(path, body, false); }
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error ?? `The playback engine returned HTTP ${response.status}.`);
    return value;
  }

  private call(method: string, ...args: unknown[]) { return this.send("/call", { method, args }); }
  state(): Promise<State> { return this.send("/state"); }

  async snapshot(): Promise<Playback> {
    const state = await this.state();
    if (state.playback && state.ready) return state.playback;
    throw new Error(state.signIn ? "Sign in to Apple Music in the window that opened." : "The playback engine is starting.");
  }

  appleTokens(): Promise<{ userToken: string; storefront?: string }> { return this.call("tokens"); }
  async rating(): Promise<number> { return await this.call("rating") ?? 0; }

  async queue(offset = 0): Promise<Page> {
    const queue: Queue = await this.call("queue");
    const items = queue.items.slice(offset, offset + 100).map((item, index) => ({
      id: item.id, type: item.type, name: item.attributes.name ?? "Untitled", artist: item.attributes.artistName ?? "",
      album: item.attributes.albumName ?? "", duration: (item.attributes.durationInMillis ?? 0) / 1000, queueIndex: offset + index,
    }));
    return { items, more: offset + 100 < queue.items.length };
  }
  async queuePosition() {
    const queue: Queue = await this.call("queue");
    return { position: queue.position, total: queue.items.length };
  }

  async playItem(item: Media) { await this.call("play", [item], 0); }
  // The engine queues the whole collection as loaded, so Next and Previous follow the displayed order.
  async playCollectionTrack(_collection: { id: string; type: string }, items: Media[], index: number) {
    await this.call("play", items.filter(item => !/albums|artists|playlists/.test(item.type)), index);
  }

  // Peel's controls use Cider's command paths. The engine has a method for each.
  async command(path: string, body: any = {}, method = "POST") {
    const commands: Record<string, () => Promise<unknown>> = {
      "/playback/toggle": () => this.call("toggle"),
      "/playback/next": () => this.call("next"),
      "/playback/previous": () => this.call("previous"),
      "/playback/seek": () => this.call("seek", body.position),
      "/audio/volume": () => this.call("volume", body.volume),
      "/playback/shuffle": () => this.call("shuffle", body.enabled),
      "/playback/shuffle/toggle": () => this.call("toggleShuffle"),
      "/playback/repeat/toggle": () => this.call("toggleRepeat"),
      "/queue/jump": () => this.call("jump", body.index),
      "/library/now-playing/rating": () => this.call("rate", method === "DELETE" ? 0 : body.rating),
    };
    const run = commands[path];
    if (!run) throw new Error(`The playback engine has no command for ${path}.`);
    await run();
  }
}

// Starts the engine in the background when it is not running. Peel's first launch also
// downloads castlabs' Electron, and a first sign-in waits for the listener.
export async function ensureEngine(engine: Engine, status: (text: string) => void = () => {}, signal?: AbortSignal) {
  const state = () => engine.state().catch(() => undefined);
  let current = await state();
  if (!current) {
    status("Starting the playback engine...");
    const environment = ["WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
      .filter(name => process.env[name]).map(name => `--setenv=${name}=${process.env[name]}`);
    // The user manager owns the engine, so music keeps playing when Peel quits.
    const child = Bun.spawn(["systemd-run", "--user", "--collect", "--unit=peel-engine", ...environment, "--", launcher], { stdout: "ignore", stderr: "pipe" });
    if (await child.exited !== 0) {
      const active = Bun.spawn(["systemctl", "--user", "is-active", "--quiet", "peel-engine.service"]);
      if (await active.exited !== 0) throw new Error(`Could not start the playback engine: ${(await new Response(child.stderr).text()).trim()}`);
    }
  }
  // The first start downloads Electron. A first sign-in can take a few minutes.
  const until = Date.now() + 5 * 60 * 1000;
  while (!current?.ready && Date.now() < until) {
    if (current?.signIn) status("Sign in to Apple Music in the window that opened.");
    await sleep(250, undefined, { signal });
    current = await state();
  }
  if (!current?.ready) throw new Error("The playback engine did not become ready. Run engine/run.sh to see why.");
}
