import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Engine, ensureEngine, type EngineTransport } from "./engine";

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

// An Engine with a selectable transport keeps every playback operation on the selected host.
export class DevicePlayer extends Engine {
  private local = new Engine();
  private remote?: RemoteConnection;
  private localUsed = false;
  private detached = false;
  host?: string;
  constructor(host?: string, private status: (text: string) => void = () => {}) {
    super(undefined, (path, body) => this.detached ? Promise.reject(new Error("Peel restarted into an update."))
      : this.remote ? this.remote.request(path, body) : this.local.send(path, body));
    if (host) { this.remote = new RemoteConnection(host, status); this.host = host; }
  }
  async ensure(signal?: AbortSignal) {
    if (this.remote) await this.remote.request("/state");
    else { this.localUsed = true; await ensureEngine(this.local, this.status, signal); }
  }
  async select(host?: string) {
    const next = host ? new RemoteConnection(host, this.status) : undefined;
    try {
      if (next) {
        await next.request("/state");
        if (!this.remote && (await this.local.snapshot().catch(() => undefined))?.state === "playing") await this.local.command("/playback/pause");
      }
      else { this.localUsed = true; await ensureEngine(this.local, this.status); }
    } catch (error) { next?.close(); throw error; }
    this.remote?.close(); this.remote = next; this.host = host;
  }
  // Closes the remote connection but keeps this computer's engine, for a Peel restarting into an
  // update. Requests still on their way fail instead of reaching another engine.
  detach() { this.detached = true; this.remote?.close(); }
  async release() {
    this.remote?.close();
    if (this.localUsed) await this.local.release();
  }
}
