import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const backgroundWorkspace = "peel-cider-background";
const rules = `// Managed by Peel. Keep Cider off the visible desktop during startup.
workspace "${backgroundWorkspace}"
window-rule {
    match app-id="^cider$"
    open-on-workspace "${backgroundWorkspace}"
    open-focused false
    opacity 0.0
    focus-ring { off; }
    border { off; }
    shadow { off; }
}
`;

function configPath() {
  return process.env.NIRI_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "niri/config.kdl");
}

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]}: ${error.trim()}`);
  return output;
}

export async function prepareNiriBackground() {
  if (!process.env.NIRI_SOCKET) return;
  const config = configPath();
  const directory = dirname(config);
  const path = join(directory, "peel-cider.kdl");
  const include = 'include "peel-cider.kdl"';
  const original = await readFile(config, "utf8");
  await mkdir(directory, { recursive: true });
  let previous = "";
  try { previous = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous && !previous.startsWith("// Managed by Peel.")) throw new Error("peel-cider.kdl belongs to another configuration. Cannot set background startup.");
  if (previous !== rules) {
    await writeFile(`${path}.${process.pid}.tmp`, rules);
    await rename(`${path}.${process.pid}.tmp`, path);
  }
  if (!original.split("\n").some(line => line.trim() === include)) {
    const candidate = `${config}.peel.${process.pid}.tmp`;
    await writeFile(candidate, `${original.trimEnd()}\n\n// Peel background playback\n${include}\n`);
    await command(["niri", "validate", "--config", candidate]);
    // Keep a backup without replacing one from a previous installation.
    try { await writeFile(`${config}.before-peel`, original, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await rename(candidate, config);
  }
  // Niri reloads config changes. Confirm the workspace exists before Cider starts.
  const until = Date.now() + 5000;
  do {
    const workspaces = JSON.parse(await command(["niri", "msg", "--json", "workspaces"]));
    const target = workspaces.find((workspace: { name: string }) => workspace.name === backgroundWorkspace);
    if (target) {
      if (target.is_active) throw new Error("Switch away from Peel's Cider background workspace before starting playback.");
      return;
    }
    await Bun.sleep(100);
  } while (Date.now() < until);
  throw new Error("Niri did not load Peel's background startup rule. Cider was not started.");
}

export async function finishNiriBackground() {
  if (!process.env.NIRI_SOCKET) return;
  const path = join(dirname(configPath()), "peel-cider.kdl");
  try {
    const content = await readFile(path, "utf8");
    if (!content.startsWith("// Managed by Peel.")) return;
    await writeFile(`${path}.${process.pid}.tmp`, "// Managed by Peel. No startup in progress.\n");
    await rename(`${path}.${process.pid}.tmp`, path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function showCiderForApproval() {
  if (!process.env.NIRI_SOCKET) return;
  await finishNiriBackground();
  const workspaces = JSON.parse(await command(["niri", "msg", "--json", "workspaces"]));
  const current = workspaces.find((workspace: { is_focused: boolean }) => workspace.is_focused);
  const windows = JSON.parse(await command(["niri", "msg", "--json", "windows"]));
  for (const window of windows.filter((item: { app_id: string }) => item.app_id === "cider")) {
    await command(["niri", "msg", "action", "move-window-to-workspace", "--window-id", String(window.id), String(current.idx)]);
    await command(["niri", "msg", "action", "focus-window", "--id", String(window.id)]);
  }
}
