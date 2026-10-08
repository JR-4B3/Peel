import { setTimeout as sleep } from "node:timers/promises";
import { finishNiriBackground, prepareNiriBackground, showCiderForApproval } from "./niri-background";

// Cider stays owned by the desktop's user manager when Peel exits.
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { output, error, code };
}

export function managesCider(base: string) {
  try {
    const url = new URL(base);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && url.port === "10767" && url.pathname === "/";
  } catch { return false; }
}

async function probe(base: string, token: string) {
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/api/v2/playback`, {
      headers: { apptoken: token }, signal: AbortSignal.timeout(1500),
    });
    return { ready: response.ok || response.status === 401 || response.status === 403, authorised: response.ok };
  } catch { return { ready: false, authorised: false }; }
}

// Clicks Hide or Show in Cider's tray menu. The menu offers only the one that applies.
async function trayWindow(action: "Hide" | "Show", signal?: AbortSignal) {
  const other = action === "Hide" ? "Show" : "Hide";
  const until = Date.now() + 15000;
  do {
    signal?.throwIfAborted();
    const buses = await run(["busctl", "--user", "list", "--no-legend"]);
    const name = buses.output.split("\n").find(line => line.startsWith("org.freedesktop.StatusNotifierItem-") && /\bCider\b/.test(line))?.split(/\s+/)[0];
    if (name) {
      const args = ["gdbus", "call", "--session", "--dest", name,
        "--object-path", "/org/chromium/DbusMenu/1", "--method"];
      const layout = await run([...args, "com.canonical.dbusmenu.GetLayout", "--", "0", "-1", '["label"]']);
      const item = layout.output.match(new RegExp(`<\\((\\d+), \\{[^}]*label[^}]*${action}`));
      if (item) {
        const result = await run([...args, "com.canonical.dbusmenu.Event", item[1]!, "clicked", "<0>", "0"]);
        if (!result.code) return;
      } else if (new RegExp(`label[^}]*${other}`).test(layout.output)) return;
    }
    await sleep(250, undefined, { signal });
  } while (Date.now() < until);
  throw new Error(`Cider is running, but its tray could not ${action.toLowerCase()} the window. Use ${action} in Cider's tray menu.`);
}

export const hideCiderWindow = (signal?: AbortSignal) => trayWindow("Hide", signal);

export async function ensureCider(base: string, token: string, hide: boolean, status: (text: string) => void = () => {}, signal?: AbortSignal) {
  // A custom server belongs to its caller, including test fixtures and remote APIs.
  if (!managesCider(base) || process.platform !== "linux") return;
  signal?.throwIfAborted();
  let state = await probe(base, token);
  let startedAt = 0;
  if (!state.ready) {
    status("Starting Cider in the background...");
    const executable = Bun.which("Cider");
    if (!executable) throw new Error("Install Cider on this PC, then open Peel again.");
    // An existing process may still be opening its API. Never launch another one.
    const running = await run(["pgrep", "-x", "Cider"]);
    startedAt = Date.now();
    if (running.code !== 0) {
      if (hide && token) await prepareNiriBackground();
      const launch = await run(["systemd-run", "--user", "--collect", "--unit=peel-cider", "--", executable]);
      if (launch.code !== 0) {
        // Concurrent Peel launches can race for the same unit; the winner owns Cider.
        const active = await run(["systemctl", "--user", "is-active", "peel-cider.service"]);
        if (active.code !== 0) throw new Error(`Could not start Cider: ${launch.error.trim()}`);
      }
    }
    const until = Date.now() + 60000;
    while (!state.ready && Date.now() < until) {
      await sleep(250, undefined, { signal });
      state = await probe(base, token);
    }
    if (!state.ready) throw new Error("Cider did not open its API within a minute. Open Cider to check sign-in and API settings.");
  }
  // Leave sign-in and consent visible. Cider also has a delayed startup show handler.
  if (hide && state.authorised) {
    if (startedAt) await sleep(Math.max(0, startedAt + 6500 - Date.now()), undefined, { signal });
    status("Connected to Cider. Hiding its window...");
    await hideCiderWindow(signal);
    await finishNiriBackground();
  } else {
    // A Cider hidden in the tray has no window, so its approval dialog would stay invisible.
    await trayWindow("Show", signal).catch(() => {});
    await showCiderForApproval();
  }
}
