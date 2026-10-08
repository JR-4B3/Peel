import { mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { AppleMusic } from "../src/apple";
import { Cider } from "../src/cider";
import { readAppleSignIn, readToken } from "../src/config";

// Run on main with Cider stopped. Restarts only the installed Peel window.
const report: { checkedAt: string; checks: { name: string; value: unknown }[]; error?: string } = {
  checkedAt: new Date().toISOString(), checks: [],
};
const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
const socket = process.env.NIRI_SOCKET ?? join(runtime, (await readdir(runtime)).find(name => /^niri\..*\.sock$/.test(name)) ?? "");
const env = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, NIRI_SOCKET: socket };
async function run(args: string[]) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]} failed: ${error}`);
  return output;
}
type Window = { id: number; app_id: string; pid: number; title: string };
const windows = async (): Promise<Window[]> => JSON.parse(await run(["niri", "msg", "--json", "windows"]));
async function ciderPids() {
  const pids: string[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      // Only the parent process has no Electron --type argument.
      const name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (name === "Cider" && !command.includes("--type=")) pids.push(pid);
    } catch { /* A process can exit during inspection. */ }
  }
  return pids;
}
function record(name: string, value: unknown) {
  report.checks.push({ name, value });
  console.log(`PASS ${name}: ${JSON.stringify(value)}`);
}
async function wait<T>(read: () => Promise<T | undefined>, label: string) {
  const until = Date.now() + 75000;
  do {
    try { const value = await read(); if (value !== undefined) return value; } catch { /* Startup can temporarily refuse connections. */ }
    await Bun.sleep(500);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}
const player = new Cider(undefined, await readToken());
const signIn = await readAppleSignIn();
const library = new AppleMusic(signIn.userToken, { storefront: signIn.storefront });
let monitor: ReturnType<typeof Bun.spawn> | undefined;
let monitoring: Promise<void> | undefined;
let monitorFailure: string | undefined;
let eventCount = 0;
const ciderEvents: unknown[] = [];
const liveWindows = new Map<number, any>();
const liveWorkspaces = new Map<number, any>();
function inspectEvent(event: any) {
  eventCount++;
  if (event.WorkspacesChanged) {
    liveWorkspaces.clear();
    for (const item of event.WorkspacesChanged.workspaces) liveWorkspaces.set(item.id, item);
  }
  if (event.WorkspaceActivated) {
    const target = liveWorkspaces.get(event.WorkspaceActivated.id);
    if (target) for (const workspace of liveWorkspaces.values()) {
      if (workspace.output === target.output) workspace.is_active = workspace.id === target.id;
    }
  }
  if (event.WindowsChanged) {
    liveWindows.clear();
    for (const item of event.WindowsChanged.windows) liveWindows.set(item.id, item);
  }
  if (event.WindowOpenedOrChanged) {
    const item = event.WindowOpenedOrChanged.window;
    liveWindows.set(item.id, item);
    if (item.app_id === "cider") ciderEvents.push({ windowId: item.id, workspace: liveWorkspaces.get(item.workspace_id)?.name, focused: item.is_focused });
  }
  if (event.WindowClosed) liveWindows.delete(event.WindowClosed.id);
  if (event.WindowFocusChanged) {
    for (const item of liveWindows.values()) item.is_focused = item.id === event.WindowFocusChanged.id;
  }
  for (const item of liveWindows.values()) {
    if (item.app_id === "cider" && (item.is_focused || liveWorkspaces.get(item.workspace_id)?.is_active)) {
      monitorFailure = "Cider appeared on an active workspace or took focus during startup";
    }
  }
}
async function monitorDesktop() {
  monitor = Bun.spawn(["niri", "msg", "--json", "event-stream"], { env, stdout: "pipe", stderr: "pipe" });
  const reader = (monitor.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    pending += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) inspectEvent(JSON.parse(line));
    }
  }
}
async function openPeel() {
  await run(["niri", "msg", "action", "spawn", "--", "gio", "launch", join(process.env.HOME!, ".local/share/applications/peel.desktop")]);
  return wait(async () => (await windows()).find(window => ["peel", "io.github.jr4b3.peel"].includes(window.app_id)), "Peel window");
}
try {
  await mkdir("evidence", { recursive: true });
  const initial = await ciderPids();
  if (initial.length) throw new Error("Stop Cider before this cold-start check");
  record("Cider is stopped before launching Peel", initial);
  monitoring = monitorDesktop();
  await wait(async () => liveWorkspaces.size && liveWindows.size ? true : undefined, "desktop event stream");
  const old = (await windows()).filter(window => ["peel", "io.github.jr4b3.peel"].includes(window.app_id));
  if (old.length > 1) throw new Error("Close extra Peel windows before this check");
  if (old[0]) {
    await run(["niri", "msg", "action", "close-window", "--id", String(old[0].id)]);
    await wait(async () => (await windows()).some(window => window.id === old[0]!.id) ? undefined : true, "old Peel to close");
  }
  const first = await openPeel();
  const pids = await wait(async () => { const value = await ciderPids(); return value.length ? value : undefined; }, "Cider to start automatically");
  if (pids.length !== 1) throw new Error("More than one Cider parent process started");
  record("Peel starts Cider automatically on main", { peel: first, ciderPid: pids[0] });
  const state = await wait(async () => { const value = await player.snapshot(); return value ? value : undefined; }, "authorised API");
  const playlists = await wait(async () => { const value = await library.playlists(); return value.length ? value : undefined; }, "Apple Music library");
  const favourite = playlists.find(item => item.favourite);
  if (!favourite) throw new Error("Apple Music did not return Favourite Songs");
  const songs = await library.songs(favourite.id);
  record("existing approval and Apple Music session connect", { state: state.state, volume: state.volume, favouriteSongs: songs.items.length });
  await wait(async () => (await windows()).some(window => window.app_id.toLowerCase() === "cider") ? undefined : true, "Cider's window to hide");
  // Allow the delayed Cider show handler and Peel's first library render to finish.
  await Bun.sleep(8000);
  if ((await windows()).some(window => window.app_id.toLowerCase() === "cider")) throw new Error("Cider's window reappeared after startup");
  record("Cider remains hidden after startup", true);
  if (monitorFailure) throw new Error(monitorFailure);
  if (!ciderEvents.length) throw new Error("The event stream did not observe Cider opening offscreen");
  record("Cider never appears on either visible desktop or takes focus", { eventCount, ciderEvents, visibleCiderEvents: 0 });
  await run(["niri", "msg", "action", "close-window", "--id", String(first.id)]);
  await wait(async () => (await windows()).some(window => window.id === first.id) ? undefined : true, "Peel to close");
  if (JSON.stringify(await ciderPids()) !== JSON.stringify(pids)) throw new Error("Quitting Peel stopped Cider");
  await player.snapshot();
  record("quitting Peel leaves Cider alive and reachable", pids);
  const second = await openPeel();
  await Bun.sleep(5000);
  if (JSON.stringify(await ciderPids()) !== JSON.stringify(pids)) throw new Error("Reopening Peel launched a different Cider process");
  if ((await windows()).some(window => window.app_id.toLowerCase() === "cider")) throw new Error("Reopening Peel showed Cider");
  const workspaces = JSON.parse(await run(["niri", "msg", "--json", "workspaces"]));
  if (workspaces.some((workspace: { name: string }) => workspace.name === "peel-cider-background")) throw new Error("The temporary background workspace was not removed");
  record("temporary startup workspace is removed", true);
  record("reopening Peel reuses the hidden Cider process", { peel: second, ciderPid: pids[0] });
  const owner = (await readFile(`/proc/${pids[0]}/status`, "utf8")).match(/^PPid:\s+(\d+)/m)?.[1];
  if (!owner || (await readFile(`/proc/${owner}/comm`, "utf8")).trim() !== "systemd") throw new Error("Cider depends on the launch terminal");
  record("main's user manager owns Cider independently of Peel", owner);
  const children = (await readFile(`/proc/${second.pid}/task/${second.pid}/children`, "utf8")).trim().split(/\s+/);
  const appPid = children.find(pid => pid);
  if (!appPid || await readlink(`/proc/${appPid}/cwd`) !== process.cwd()) throw new Error("Peel is not running the main checkout");
  const appEnv = (await readFile(`/proc/${appPid}/environ`, "utf8")).split("\0");
  const base = appEnv.find(value => value.startsWith("CIDER_API_BASE="))?.slice("CIDER_API_BASE=".length) ?? "http://127.0.0.1:10767";
  if (base !== "http://127.0.0.1:10767") throw new Error("Peel is not using main's local API");
  record("Peel runs the main checkout and uses its loopback API", { appPid, base });
  await run(["niri", "msg", "action", "focus-window", "--id", String(second.id)]);
  await Bun.sleep(1000); // Let the terminal redraw after the desktop changes focus and size.
  if (monitorFailure) throw new Error(monitorFailure);
  await run(["niri", "msg", "action", "screenshot-window", "--id", String(second.id), "--path", join(process.cwd(), "evidence/main-auto-start.png")]);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  monitor?.kill();
  await monitoring;
  await Bun.write("evidence/startup-report.json", JSON.stringify(report, null, 2) + "\n");
}
