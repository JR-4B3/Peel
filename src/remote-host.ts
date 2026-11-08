import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Engine, ensureEngine } from "./engine";
import { Hires, ensureHires, hiresSelected } from "./hires";

// The SSH helper uses its own PID on the host and marks itself remote. Client PIDs never enter
// the host's owner list. When the last Peel on the host closes, the music pauses, even while a
// controller stays connected. Once the controller has closed too, the engine quits.
export async function serveRemote(lines: AsyncIterable<string>, reply: (value: unknown) => void, engine = new Engine(), ready: () => Promise<void> = () => ensureEngine(engine, text => reply({ status: text }))) {
  // Attach before startup awaits, because readline otherwise drops early SSH requests.
  const input = lines[Symbol.asyncIterator]();
  await ready();
  try {
    for await (const line of { [Symbol.asyncIterator]: () => input }) {
      let id: number | undefined;
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error("Request too large");
        const request = JSON.parse(line); id = request.id;
        if (!Number.isSafeInteger(id) || !["/state", "/call"].includes(request.path)) throw new Error("Invalid remote request");
        reply({ id, value: await engine.send(request.path, request.body) });
      } catch (error) { reply({ id, error: error instanceof Error ? error.message : String(error) }); }
    }
  } finally { await engine.release().catch(() => {}); }
}

export async function runRemoteHost() {
  // Marks this helper's requests as a remote controller's (see remoteOwner in engine.ts).
  process.env.PEEL_REMOTE_HOST = "1";
  // SSH logins often omit the desktop session variables that systemd-run needs.
  if (process.platform === "linux" && process.getuid) {
    const runtime = `/run/user/${process.getuid()}`;
    if (!process.env.XDG_RUNTIME_DIR && existsSync(runtime)) process.env.XDG_RUNTIME_DIR = runtime;
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && existsSync(`${runtime}/bus`)) process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
    const environment = Bun.spawnSync(["systemctl", "--user", "show-environment"], { stdout: "pipe", stderr: "pipe" });
    for (const line of environment.stdout.toString().split("\n")) {
      const index = line.indexOf("="), name = line.slice(0, index);
      if (["WAYLAND_DISPLAY", "DISPLAY"].includes(name) && !process.env[name]) process.env[name] = line.slice(index + 1);
    }
  }
  const lines = createInterface({ input: process.stdin });
  const reply = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  // The host's own player: hi-res where its pipeline is installed, otherwise the web engine.
  const hires = hiresSelected();
  const engine = hires ? new Hires() : new Engine();
  try { await serveRemote(lines, reply, engine, () => (hires ? ensureHires : ensureEngine)(engine, text => reply({ status: text }))); }
  finally { lines.close(); }
}
