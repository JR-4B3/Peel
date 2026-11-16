import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTry, releaseHost, tryArgument, type TryTarget } from "../src/try";
import { endTestRun, recordTestRun, testRuns, testVersion } from "../src/try-runs";
import { checkForUpdate } from "../src/update";

test("--try takes a pull request number, main, or nothing, and passes the other arguments on", () => {
  expect(tryArgument(["--try", "118"])).toEqual({ target: "118", rest: [] });
  expect(tryArgument(["--try", "#118", "--local"])).toEqual({ target: "118", rest: ["--local"] });
  expect(tryArgument(["--try", "main"])).toEqual({ target: "main", rest: [] });
  expect(tryArgument(["--try"])).toEqual({ target: undefined, rest: [] });
  expect(tryArgument(["--remote", "box", "--try"])).toEqual({ target: undefined, rest: ["--remote", "box"] });
  expect(tryArgument(["--try", "--local"])).toEqual({ target: undefined, rest: ["--local"] });
});

test("a test build never updates itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-try-"));
  try {
    await writeFile(join(dir, "version.json"), JSON.stringify({ version: "0.1.1-pr118.be400a9", channel: "try", commit: "be400a9", date: "2026-11-15", time: "2026-11-15T12:00:00.000Z" }));
    const result = await checkForUpdate("nightly", true, Date.now(), dir);
    expect(result.message).toContain("never updates");
    expect(result.ready).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A cached test build folder, as installTry leaves one, last used `age` seconds ago.
async function cached(root: string, name: string, age: number) {
  const dir = join(root, "try", name);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await writeFile(join(dir, "version.json"), JSON.stringify({ version: `0.1.0-try.${name.replace("-", ".")}`, channel: "try", commit: name, date: "2026-11-15", time: "2026-11-15T12:00:00.000Z" }));
  await writeFile(join(dir, "src", "lazy.ts"), "export const value = 1;\n");
  const time = new Date(Date.now() - age * 1000);
  await utimes(dir, time, time);
  return dir;
}

const target = (label: string, sha: string): TryTarget => ({ label, sha: sha.repeat(40), time: "2026-11-16T12:00:00.000Z", title: label });

// #123: a test build that still runs loads modules later, and its hi-res host starts files from
// its folder. Starting more test builds removes only folders nobody uses.
test("starting more test builds keeps the folder of one that still runs, and a crashed one's record goes", async () => {
  const root = await mkdtemp(join(tmpdir(), "peel-try-cache-")), runs = join(root, "runs");
  // A test build that runs, as runTry starts it: its process loads a module when told to.
  const running = await cached(root, "pr1-1111111", 100);
  const lazy = join(running, "src", "lazy.ts");
  const child = Bun.spawn([process.execPath, "-e", `console.log("ready"); process.stdin.once("data", async () => { console.log((await import(${JSON.stringify(lazy)})).value); process.exit(0); });`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
    await recordTestRun(runs, { dir: running, version: "0.1.0-try.pr1.1111111", pids: [child.pid] }, child.pid);
    // A test build whose peel --try and test build crashed: their processes are gone.
    const crashed = await cached(root, "pr0-0000000", 200);
    const gone = Bun.spawn([process.execPath, "-e", ""]);
    await gone.exited;
    await recordTestRun(runs, { dir: crashed, version: "0.1.0-try.pr0.0000000", pids: [gone.pid] }, gone.pid);
    await cached(root, "pr2-2222222", 90);
    await cached(root, "pr3-3333333", 80);
    await cached(root, "pr4-4444444", 70);

    const { dir, version } = await installTry(target("pr4", "4"), root, () => {}, { runs, hostVersion: async () => undefined });
    expect(dir).toBe(join(root, "try", "pr4-4444444"));
    expect(version).toBe("0.1.0-try.pr4.4444444");
    // The three used last, and the running one. The crashed one's folder and record are gone.
    expect((await readdir(join(root, "try"))).sort()).toEqual(["pr1-1111111", "pr2-2222222", "pr3-3333333", "pr4-4444444"]);
    expect(existsSync(join(runs, `${gone.pid}.json`))).toBe(false);
    // This peel --try recorded its own test build before removing others.
    expect(testRuns(runs).live.map(run => run.version).sort()).toEqual(["0.1.0-try.pr1.1111111", "0.1.0-try.pr4.4444444"]);

    // The running test build still loads its modules.
    child.stdin.write("continue\n");
    child.stdin.end();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("1");
    expect(await child.exited).toBe(0);

    // Once it exited, its folder is old enough to go at the next start.
    await installTry(target("pr4", "4"), root, () => {}, { runs, hostVersion: async () => undefined });
    expect((await readdir(join(root, "try"))).sort()).toEqual(["pr2-2222222", "pr3-3333333", "pr4-4444444"]);
    expect(existsSync(join(runs, `${child.pid}.json`))).toBe(false);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("starting more test builds keeps the folder whose code the hi-res host runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "peel-try-host-")), runs = join(root, "runs");
  try {
    // The test build ended, and a window of the installed Peel still uses the host it started.
    await cached(root, "pr1-1111111", 100);
    await cached(root, "pr2-2222222", 90);
    await cached(root, "pr3-3333333", 80);
    await cached(root, "pr4-4444444", 70);
    await installTry(target("pr4", "4"), root, () => {}, { runs, hostVersion: async () => "0.1.0-try.pr1.1111111" });
    expect((await readdir(join(root, "try"))).sort()).toEqual(["pr1-1111111", "pr2-2222222", "pr3-3333333", "pr4-4444444"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a test build's version says it is one, also in a folder downloaded before", async () => {
  const root = await mkdtemp(join(tmpdir(), "peel-try-version-")), runs = join(root, "runs");
  try {
    const dir = await cached(root, "pr118-be400a9", 0);
    await writeFile(join(dir, "version.json"), JSON.stringify({ version: "0.1.0-pr118.be400a9", channel: "try", commit: "be400a9", date: "2026-11-15", time: "2026-11-15T12:00:00.000Z" }));
    const before = Date.now();
    await installTry({ ...target("pr118", "0"), sha: "be400a9".padEnd(40, "0") }, root, () => {}, { runs, hostVersion: async () => undefined });
    const build = JSON.parse(await readFile(join(dir, "version.json"), "utf8"));
    expect(build).toMatchObject({ version: "0.1.0-try.pr118.be400a9", channel: "try" });
    expect(testVersion(build.version)).toBe(true);
    expect(Date.parse(build.time)).toBeGreaterThanOrEqual(before - 1000);
    expect(testVersion("0.1.1-nightly.20261115.abcdef0")).toBe(false);
    expect(testVersion("0.1.1")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// #124: the installed Peel gets its own host code back once the test build closed.
test("a closed test build stops its host unless another Peel or a test build of that version uses it", async () => {
  const runs = await mkdtemp(join(tmpdir(), "peel-try-release-")), version = "0.1.0-try.pr1.abcdef0";
  const host = (build: string, others: number[]) => {
    const calls: string[] = [];
    return {
      calls,
      async state() { return { ready: true, signIn: false, build: { hash: "h", version: build, time: "" }, others: others.shift() ?? 0 } as any; },
      async quit() { calls.push("quit"); },
      async release() { calls.push("release"); },
    };
  };
  try {
    // Nobody else uses it, after the test build's own process left.
    let fake = host(version, [1, 0]);
    await releaseHost(version, fake, runs, 1000);
    expect(fake.calls).toEqual(["quit"]);
    // A window of the installed Peel uses it. That window restarts it with its next command.
    fake = host(version, [1, 1, 1, 1]);
    await releaseHost(version, fake, runs, 100);
    expect(fake.calls).toEqual(["release"]);
    // The host runs other code: nothing to do.
    fake = host("0.1.1", []);
    await releaseHost(version, fake, runs, 100);
    expect(fake.calls).toEqual([]);
    // Another test build of this version still runs.
    await recordTestRun(runs, { dir: "/elsewhere", version, pids: [process.pid] });
    fake = host(version, []);
    await releaseHost(version, fake, runs, 100);
    expect(fake.calls).toEqual(["release"]);
    await endTestRun(runs);
    expect(testRuns(runs).live).toEqual([]);
  } finally { await rm(runs, { recursive: true, force: true }); }
});
