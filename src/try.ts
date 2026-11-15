// peel --try [PR number | main]: starts Peel from the code of a pull request, or of main before the
// nightly release has it, without changing the installed Peel. Without a number it takes the open
// pull request that changed last. Each build is downloaded from GitHub once into <root>/try, and
// the three used last are kept. A test build never updates itself.
//
// Each start records the start time as the test build's time, so it counts as newer than every
// installed release and restarts the hi-res host with its own code, also for an older branch. When the test build closes and no other Peel uses
// that host, the host is stopped, and the next Peel starts it again from its own code.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hiresBuild } from "./build";
import { Hires } from "./hires";
import { defaultRoot, installRoot, repository } from "./update";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const api = `https://api.github.com/repos/${repository}`;
const keep = 3;

export interface TryTarget { label: string; sha: string; time: string; title: string }

// What --try names in args: a pull request number, main, or nothing for the newest pull request.
export function tryArgument(args: string[]) {
  const at = args.indexOf("--try"), next = args[at + 1];
  const target = next && (/^#?\d+$/.test(next) || next === "main") ? next.replace(/^#/, "") : undefined;
  const rest = args.filter((_, index) => index !== at && !(target && index === at + 1));
  return { target, rest };
}

async function github<T>(path: string): Promise<T> {
  const response = await fetch(`${api}${path}`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) throw new Error(`GitHub has no ${path.replace(/^\//, "")}.`);
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
  return await response.json() as T;
}

interface Pull { number: number; title: string; head: { sha: string } }

export async function resolveTarget(target?: string): Promise<TryTarget> {
  let label: string, sha: string, title: string;
  if (target === "main") {
    const commit = await github<{ sha: string; commit: { message: string } }>("/commits/main");
    ({ sha } = commit);
    label = "main"; title = commit.commit.message.split("\n")[0]!;
  } else {
    const pull = target
      ? await github<Pull>(`/pulls/${target}`)
      : (await github<Pull[]>("/pulls?state=open&sort=updated&direction=desc&per_page=1"))[0];
    if (!pull) throw new Error("There is no open pull request. peel --try main starts the newest code on main.");
    label = `pr${pull.number}`; sha = pull.head.sha; title = pull.title;
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitHub gave no valid commit.");
  const commit = await github<{ commit: { committer: { date: string } } }>(`/commits/${sha}`);
  return { label, sha, title, time: new Date(commit.commit.committer.date).toISOString() };
}

async function run(args: string[], cwd?: string) {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]} ${args[1] ?? ""} failed: ${(error || output).trim().split("\n").at(-1)}`);
}

// Downloads and installs the target into <root>/try/<label>-<commit>, unless it is there already.
// The folder gets a version.json, so the hi-res host can tell its build from the release's. Its
// time is the start time, set again at each start.
export async function installTry(target: TryTarget, root: string, status: (text: string) => void = () => {}) {
  const tries = join(root, "try"), dir = join(tries, `${target.label}-${target.sha.slice(0, 7)}`);
  if (!existsSync(join(dir, "version.json"))) {
    status(`Downloading ${target.label} (${target.sha.slice(0, 7)})...`);
    const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${target.sha}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Could not download ${target.label}: HTTP ${response.status}.`);
    const partial = `${dir}.${process.pid}.partial`, file = join(tmpdir(), `peel-try-${process.pid}.tar.gz`);
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    try {
      await writeFile(file, new Uint8Array(await response.arrayBuffer()));
      // GitHub's archive holds one top folder named after the repository and commit.
      const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      await run([tar, "-xzf", file, "-C", partial, "--strip-components=1"]);
      status(`Installing ${target.label}...`);
      await run([process.execPath, "install", "--frozen-lockfile", "--production"], partial);
      const pkg = JSON.parse(await readFile(join(partial, "package.json"), "utf8")) as { version?: string };
      const build = { version: `${pkg.version ?? "0.0.0"}-${target.label}.${target.sha.slice(0, 7)}`, channel: "try", commit: target.sha, date: target.time.slice(0, 10), time: target.time };
      await writeFile(join(partial, "version.json"), JSON.stringify(build, null, 2) + "\n");
      await rename(partial, dir).catch(error => { if (!existsSync(join(dir, "version.json"))) throw error; });
    } finally {
      await rm(partial, { recursive: true, force: true });
      await rm(file, { force: true });
    }
  }
  const now = new Date(), info = join(dir, "version.json");
  const build = JSON.parse(await readFile(info, "utf8")) as Record<string, unknown>;
  await writeFile(info, JSON.stringify({ ...build, date: now.toISOString().slice(0, 10), time: now.toISOString() }, null, 2) + "\n");
  await utimes(dir, now, now).catch(() => {});
  await prune(tries, dir);
  return dir;
}

// Keeps the test builds used last. A folder a running test build uses was touched when it started.
async function prune(tries: string, using: string) {
  const names = (await readdir(tries).catch(() => [] as string[])).filter(name => !name.endsWith(".partial"));
  const folders = await Promise.all(names.map(async name => ({ path: join(tries, name), time: (await stat(join(tries, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  folders.sort((a, b) => b.time - a.time);
  for (const { path } of folders.slice(keep)) if (path !== using) await rm(path, { recursive: true, force: true }).catch(() => {});
}

// Runs the test build in this terminal and returns its exit code.
export async function runTry(args: string[]) {
  const { target, rest } = tryArgument(args);
  const status = (text: string) => console.log(text);
  const resolved = await resolveTarget(target);
  status(`Peel test build: ${resolved.label === "main" ? "main" : `pull request #${resolved.label.slice(2)}`}, ${resolved.title} (${resolved.sha.slice(0, 7)})`);
  const dir = await installTry(resolved, installRoot(appDir) ?? defaultRoot(), status);
  const child = Bun.spawn([process.execPath, "src/index.ts", ...rest], { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
  const code = await child.exited;
  await releaseHost(dir);
  console.log("The test build closed. peel starts your installed Peel again.");
  return code;
}

// Stops a hi-res host that runs the test build's code once no Peel uses it, so the installed
// Peel starts its own host next time instead of keeping the test build's.
async function releaseHost(dir: string) {
  const hires = new Hires();
  const state = await hires.state().catch(() => undefined);
  if (!state?.build || state.build.hash !== hiresBuild(dir).hash || state.others) return;
  console.log("Stopping the test build's hi-res playback...");
  await hires.quit().catch(() => {});
}
