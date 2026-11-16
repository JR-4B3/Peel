// peel --try [PR number | main]: starts Peel from the code of a pull request, or of main before the
// nightly release has it, without changing the installed Peel. Without a number it takes the open
// pull request that changed last. Each build is downloaded from GitHub once into <root>/try. The
// three used last are kept, and so is each build that runs or whose code the hi-res host runs.
// A test build never updates itself.
//
// Before the test build starts, peel --try starts the hi-res host from the test build's code,
// also for a branch older than the installed release, and records the test build as running
// (src/try-runs.ts). While it runs, the installed Peel's windows leave that host alone. When the
// test build closes and no other Peel uses that host, the host is stopped. Otherwise the next
// command of the installed Peel restarts it into the installed code (outdated in src/hires.ts).
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hiresBuild } from "./build";
import { readPreferences } from "./config";
import { ensureHires, Hires, hiresHome, hiresSelected, launchHost, testRunsDir } from "./hires";
import { endTestRun, recordTestRun, testRuns } from "./try-runs";
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

// Where installTry keeps its records, and how it asks which build the hi-res host runs. Tests pass
// their own.
export interface TryPlaces { runs?: string; hostVersion?: () => Promise<string | undefined> }

// Downloads and installs the target into <root>/try/<label>-<commit>, unless it is there already.
// The folder gets a version.json, so the hi-res host can tell its build from the release's. Its
// version says it is a test build, and its time is the start time, set again at each start.
// Before it removes the folders of older test builds, it records this one as running.
export async function installTry(target: TryTarget, root: string, status: (text: string) => void = () => {}, places: TryPlaces = {}) {
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
      const build = { channel: "try", commit: target.sha, date: target.time.slice(0, 10), time: target.time };
      await writeFile(join(partial, "version.json"), JSON.stringify(build, null, 2) + "\n");
      await rename(partial, dir).catch(error => { if (!existsSync(join(dir, "version.json"))) throw error; });
    } finally {
      await rm(partial, { recursive: true, force: true });
      await rm(file, { force: true });
    }
  }
  const now = new Date(), info = join(dir, "version.json");
  const build = JSON.parse(await readFile(info, "utf8")) as Record<string, unknown>;
  const pkg = await readFile(join(dir, "package.json"), "utf8").then(text => JSON.parse(text) as { version?: string }, () => ({ version: undefined }));
  const version = `${pkg.version ?? "0.0.0"}-try.${target.label}.${target.sha.slice(0, 7)}`;
  await writeFile(info, JSON.stringify({ ...build, version, date: now.toISOString().slice(0, 10), time: now.toISOString() }, null, 2) + "\n");
  await utimes(dir, now, now).catch(() => {});
  const runs = places.runs ?? testRunsDir;
  await recordTestRun(runs, { dir, version, pids: [process.pid] });
  await prune(tries, runs, await (places.hostVersion ?? hostVersion)());
  return { dir, version };
}

// Keeps the test builds used last, the ones that run, and the one whose code the hi-res host runs.
// A running test build's process may still load a module or start the host from its folder. It
// removes the records of test builds that ended, after a crash too.
async function prune(tries: string, runs: string, host?: string) {
  const { live, ended } = testRuns(runs);
  await Promise.all(ended.map(file => rm(file, { force: true }).catch(() => {})));
  const running = new Set(live.map(run => resolve(run.dir)));
  const names = (await readdir(tries).catch(() => [] as string[])).filter(name => !name.endsWith(".partial"));
  const folders = await Promise.all(names.map(async name => ({ path: join(tries, name), time: (await stat(join(tries, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  folders.sort((a, b) => b.time - a.time);
  for (const { path } of folders.slice(keep)) {
    if (running.has(resolve(path))) continue;
    const version = await readFile(join(path, "version.json"), "utf8").then(text => JSON.parse(text).version as unknown, () => undefined);
    if (host && version === host) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

// The version of the code the hi-res host runs. It asks without the x-peel-owner header, which
// would make peel --try one of the Peels that keep the host running.
async function hostVersion(home = hiresHome): Promise<string | undefined> {
  try {
    const { port, key } = JSON.parse(await readFile(join(home, "key.json"), "utf8")) as { port: number; key: string };
    const response = await fetch(`http://127.0.0.1:${port}/state`, { headers: { "x-peel-key": key }, signal: AbortSignal.timeout(5000) });
    const build = (await response.json() as { build?: { version?: unknown } } | null)?.build;
    return typeof build?.version === "string" ? build.version : undefined;
  } catch { return undefined; }
}

// Runs the test build in this terminal and returns its exit code.
export async function runTry(args: string[]) {
  const { target, rest } = tryArgument(args);
  const status = (text: string) => console.log(text);
  const resolved = await resolveTarget(target);
  status(`Peel test build: ${resolved.label === "main" ? "main" : `pull request #${resolved.label.slice(2)}`}, ${resolved.title} (${resolved.sha.slice(0, 7)})`);
  const { dir, version } = await installTry(resolved, installRoot(appDir) ?? defaultRoot(), status);
  let code: number;
  try {
    // A test build that controls another computer starts no host here, unless one runs already.
    const local = rest.includes("--local") || (!rest.includes("--remote") && !(await readPreferences()).remote);
    if (hiresSelected() && (local || await hostVersion())) await useOwnHost(dir, status).catch(error => status(`The test build's hi-res playback did not start: ${error instanceof Error ? error.message : error}`));
    const child = Bun.spawn([process.execPath, "src/index.ts", ...rest], { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
    // The test build counts as running while it or peel --try runs.
    await recordTestRun(testRunsDir, { dir, version, pids: [process.pid, child.pid] });
    code = await child.exited;
  } finally { await endTestRun(testRunsDir); }
  await releaseHost(version);
  console.log("The test build closed. peel starts your installed Peel again.");
  return code;
}

// Starts the hi-res host from the test build's code. A branch from before peel --try only
// restarts a host that is older by release number, so a branch older than the installed release
// would keep the installed Peel's host. peel --try runs this Peel's ordering instead, in which a
// running test build is newer than any other build.
async function useOwnHost(dir: string, status: (text: string) => void) {
  const code = join(dir, "src", "hires.ts");
  if (!existsSync(code)) return;
  const { hash, version, time } = hiresBuild(dir);
  await ensureHires(new Hires(), status, undefined, { build: { hash, version, time }, launch: () => launchHost(code) });
}

// Once the test build closed, a hi-res host that runs its code stops when no other Peel uses it,
// so the installed Peel starts its own host next time. A test build of the same version that
// still runs keeps it. A Peel that still uses it restarts it with its next command, as the
// test build ended. The test build's process leaves the host's list of users within a second.
// Tests pass a stand-in for the host, their records' folder and a shorter wait.
export async function releaseHost(version: string, hires: Pick<Hires, "state" | "quit" | "release"> = new Hires(), runs = testRunsDir, wait = 2000) {
  let state = await hires.state().catch(() => undefined);
  if (state?.build?.version !== version) return;
  for (let until = Date.now() + wait; state?.others && Date.now() < until;) {
    await sleep(250);
    state = await hires.state().catch(() => undefined);
  }
  if (!state || state.build?.version !== version) return;
  if (state.others || testRuns(runs).live.some(run => run.version === version)) { await hires.release().catch(() => {}); return; }
  console.log("Stopping the test build's hi-res playback...");
  await hires.quit().catch(() => {});
}
