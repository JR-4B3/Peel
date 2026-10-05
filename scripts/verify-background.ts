import { mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Cider } from "../src/cider";
import { readToken } from "../src/config";
import { captureCiderAudio } from "./audio";
import type { Playback } from "../src/types";

// Verify the installed desktop app on the main PC's Niri session.
// Hide Cider using its tray menu and open Peel before running this check.
const report: { checkedAt: string; checks: { name: string; value: unknown }[]; error?: string; restorationError?: string } = {
  checkedAt: new Date().toISOString(), checks: [],
};
function record(name: string, value: unknown) {
  report.checks.push({ name, value });
  console.log(`PASS ${name}: ${JSON.stringify(value)}`);
}
const player = new Cider(undefined, await readToken());
let original: Playback | undefined;
async function observe(predicate: (value: Playback) => boolean, description: string) {
  const until = Date.now() + 15000;
  do {
    const value = await player.snapshot();
    if (predicate(value)) return value;
    await Bun.sleep(250);
  } while (Date.now() < until);
  throw new Error(`Cider did not confirm ${description}`);
}
try {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
  const socket = process.env.NIRI_SOCKET ?? join(runtime, (await readdir(runtime)).find(name => /^niri\..*\.sock$/.test(name)) ?? "");
  const niri = Bun.spawn(["niri", "msg", "--json", "windows"], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtime, NIRI_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
  });
  const [output, diagnostic] = await Promise.all([new Response(niri.stdout).text(), new Response(niri.stderr).text()]);
  if (await niri.exited !== 0) throw new Error(`Cannot inspect the main PC's desktop: ${diagnostic}`);
  const windows: { id: number; title: string; app_id: string; pid: number }[] = JSON.parse(output);
  if (windows.some(window => window.app_id.toLowerCase() === "cider")) throw new Error("Cider's window is still visible");
  record("Cider window is hidden", true);
  const peel = windows.find(window => ["peel", "io.github.jr4b3.peel"].includes(window.app_id));
  if (!peel) throw new Error("The installed Peel desktop window is not open");
  record("Peel interface is visible on main", peel);

  const terminalParent = (await readFile(`/proc/${peel.pid}/status`, "utf8")).match(/^PPid:\s+(\d+)/m)?.[1];
  if (!terminalParent || (await readFile(`/proc/${terminalParent}/comm`, "utf8")).trim() !== "systemd") {
    throw new Error("Peel's terminal is not owned by the main PC's desktop session manager");
  }
  let appPid = "", ciderPid = "";
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const parent = status.match(/^PPid:\s+(\d+)/m)?.[1];
      const name = status.match(/^Name:\s+(.+)/m)?.[1];
      if (name === "Cider" && !ciderPid) ciderPid = pid;
      if (name === "bun" && parent === String(peel.pid)) appPid = pid;
    } catch { /* A process can exit while /proc is being read. */ }
  }
  if (!appPid || !ciderPid) throw new Error("Peel or Cider is not running on the main PC");
  const directory = await readlink(`/proc/${appPid}/cwd`);
  if (directory !== process.cwd()) throw new Error(`Peel is running a different checkout: ${directory}`);
  const environment = (await readFile(`/proc/${appPid}/environ`, "utf8")).split("\0");
  const base = environment.find(value => value.startsWith("CIDER_API_BASE="))?.slice("CIDER_API_BASE=".length) ?? "http://127.0.0.1:10767";
  if (base !== "http://127.0.0.1:10767" || player.base !== base) throw new Error("Peel is not using Cider's local loopback address");
  record("main owns both processes and uses its local API", { appPid, ciderPid, terminalParent, directory, base });

  original = await player.snapshot();
  if (!original.nowPlaying) throw new Error("Select a song before checking background playback");
  if (original.volume < 0.05) await player.command("/audio/volume", { volume: 0.05 }, "PATCH");
  await player.command("/playback/play");
  const start = await observe(value => value.state === "playing", "background playback");
  const advanced = await observe(value => value.time.currentTime >= start.time.currentTime + 2, "background playback time advancing");
  record("playback advances with Cider hidden", { track: advanced.nowPlaying?.name, before: start.time.currentTime, after: advanced.time.currentTime });
  record("actual main PC audio with Cider hidden", await captureCiderAudio());
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (original) {
    try {
      const state = original.state === "playing" ? "playing" : "paused";
      await player.command(state === "playing" ? "/playback/play" : "/playback/pause");
      await observe(value => value.state === state, "the original playback state");
      await player.command("/audio/volume", { volume: original.volume }, "PATCH");
      const restored = await observe(value => Math.abs(value.volume - original!.volume) < 0.005, "the original volume");
      record("original playback state and volume restored", { originalState: original.state, state: restored.state, volume: restored.volume });
    } catch (error) {
      report.restorationError = error instanceof Error ? error.message : String(error);
      console.error(`Restoration failed: ${report.restorationError}`);
      process.exitCode = 1;
    }
  }
  await mkdir("evidence", { recursive: true });
  await Bun.write("evidence/background-report.json", JSON.stringify(report, null, 2) + "\n");
}
