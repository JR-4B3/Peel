import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostState, installTry, releaseHost, resolveTarget, sharedHost, takeHost, tryArgument, type TryTarget } from "../src/try";
import { endTestRun, recordTestRun, testLabel, testRuns, testVersion } from "../src/try-runs";
import { repository } from "../src/update";
import { createTestRenderer } from "@opentui/core/testing";
import { defaults } from "../src/config";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import { fixture } from "./fixture";
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
test("a closed test build stops its host unless a test build of that version still runs", async () => {
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
    // A window opened while the test build ran still uses it. A window of a version from before
    // peel --try would keep the test build's code running, so the host stops anyway, and that
    // window starts its own with its next command.
    fake = host(version, [1, 1, 1, 1]);
    await releaseHost(version, fake, runs, 100);
    expect(fake.calls).toEqual(["quit"]);
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

// GitHub's answers for pull requests, as resolveTarget asks for them. Each pull request's branch
// is in the repository named, or in a deleted fork for null.
function github(pulls: { number: number; repo: string | null }[]) {
  const asked: string[] = [];
  const pull = ({ number, repo }: { number: number; repo: string | null }) => ({ number, title: `Change ${number}`, head: { sha: String(number % 10).repeat(40), repo: repo && { full_name: repo } } });
  const get = async <T>(path: string): Promise<T> => {
    asked.push(path);
    if (path.startsWith("/pulls?")) return pulls.map(pull) as T;
    const number = /^\/pulls\/(\d+)$/.exec(path)?.[1];
    if (number) return pull(pulls.find(entry => entry.number === Number(number))!) as T;
    if (path.startsWith("/commits/")) return { commit: { committer: { date: "2026-11-16T12:00:00Z" } } } as T;
    throw new Error(`Unexpected ${path}`);
  };
  return { get, asked };
}

test("peel --try runs only pull requests whose branch is in this repository", async () => {
  const fork = "someone/Peel";
  const { get, asked } = github([{ number: 7, repo: fork }, { number: 6, repo: null }, { number: 5, repo: repository }, { number: 4, repo: repository }]);
  // A fork's pull request, named by number, does not run, and nothing is downloaded.
  await expect(resolveTarget("7", get)).rejects.toThrow(`Pull request #7 comes from the fork ${fork}.`);
  await expect(resolveTarget("6", get)).rejects.toThrow("Pull request #6 comes from a deleted fork.");
  expect(asked.filter(path => path.startsWith("/commits/"))).toEqual([]);
  // Without a number, it takes the newest pull request from a branch of this repository.
  expect(await resolveTarget(undefined, get)).toMatchObject({ label: "pr5", sha: "5".repeat(40), title: "Change 5" });
  expect(await resolveTarget("4", get)).toMatchObject({ label: "pr4", sha: "4".repeat(40) });
  // When every open pull request comes from a fork, there is nothing to run.
  await expect(resolveTarget(undefined, github([{ number: 7, repo: fork }]).get)).rejects.toThrow("There is no open pull request from a branch of");
});

// A hi-res host for hostState to ask, in a folder of its own. Each answer comes from reply.
async function stubHost(reply: () => Response | Promise<Response>) {
  const home = await mkdtemp(join(tmpdir(), "peel-try-shared-")), asked: { owner: string | null; path: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    asked.push({ owner: request.headers.get("x-peel-owner"), path: new URL(request.url).pathname });
    if (request.headers.get("x-peel-key") !== "secret") return Response.json({ error: "Wrong engine key" }, { status: 403 });
    return reply();
  } });
  await writeFile(join(home, "key.json"), JSON.stringify({ port: server.port, key: "secret" }));
  return { home, server, asked, async stop() { server.stop(true); await rm(home, { recursive: true, force: true }); } };
}

test("peel --try starts only while no other Peel uses the hi-res host", async () => {
  let others: number | undefined = 2;
  const host = await stubHost(() => Response.json({ ready: true, build: { hash: "h", version: "0.1.1", time: "" }, others }));
  const empty = await mkdtemp(join(tmpdir(), "peel-try-none-"));
  try {
    // No host runs: there is no key file, it names no port, or nothing listens on the port.
    expect(await hostState(empty)).toBeUndefined();
    await writeFile(join(empty, "key.json"), JSON.stringify({ key: "secret" }));
    expect(await hostState(empty)).toBeUndefined();
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = closed.port;
    closed.stop(true);
    await writeFile(join(empty, "key.json"), JSON.stringify({ port, key: "secret" }));
    expect(await hostState(empty)).toBeUndefined();
    expect(sharedHost(undefined)).toBeUndefined();
    // Two installed Peel windows use it. peel --try asks without joining them.
    expect(await hostState(host.home)).toEqual({ version: "0.1.1", others: 2 });
    expect(host.asked.every(request => request.owner === null)).toBe(true);
    expect(sharedHost(await hostState(host.home))).toStartWith("2 other Peel windows use hi-res playback");
    others = 1;
    expect(sharedHost(await hostState(host.home))).toStartWith("Another Peel window uses hi-res playback");
    // A host that does not say how many Peels use it counts as used.
    others = undefined;
    expect(sharedHost(await hostState(host.home))).toStartWith("Other Peel windows use");
    // A host that nobody uses any more lets the test build start.
    others = 0;
    expect(sharedHost(await hostState(host.home))).toBeUndefined();
  } finally {
    await host.stop();
    await rm(empty, { recursive: true, force: true });
  }
});

// A host that runs but gives no state may have users, so peel --try does not start.
test("peel --try does not start while the hi-res host runs but gives no state", async () => {
  let reply: () => Response | Promise<Response> = () => new Response("Starting", { status: 503 });
  const host = await stubHost(() => reply());
  try {
    expect(await hostState(host.home)).toEqual({ unreadable: "it answered HTTP 503" });
    expect(sharedHost(await hostState(host.home))).toStartWith("peel --try could not ask the hi-res host on this computer which Peels use it: it answered HTTP 503. Run peel --try again in a moment.");
    // A host that restarted wrote a new key, which key.json does not hold yet.
    await writeFile(join(host.home, "key.json"), JSON.stringify({ port: host.server.port, key: "old" }));
    expect(await hostState(host.home)).toEqual({ unreadable: "it did not take the key in key.json" });
    await writeFile(join(host.home, "key.json"), JSON.stringify({ port: host.server.port, key: "secret" }));
    // A host that waits for Android answers late.
    reply = () => Bun.sleep(6000).then(() => Response.json({ others: 0 }));
    expect(await hostState(host.home)).toEqual({ unreadable: "it did not answer within 5 seconds" });
    expect(sharedHost({ unreadable: "it did not answer within 5 seconds" })).toContain("close other Peel windows");
    reply = () => new Response("not json");
    expect(await hostState(host.home)).toEqual({ unreadable: "its answer was not a state" });
  } finally { await host.stop(); }
}, 15000);

// A Peel window that opens while the test build downloads uses the host by the time peel --try
// would take it over.
test("peel --try asks again before it takes the hi-res host over, and leaves a used host alone", async () => {
  let others = 0;
  const host = await stubHost(() => Response.json({ ready: true, build: { hash: "h", version: "0.1.1", time: "" }, others }));
  const started: string[] = [];
  const start = async (dir: string) => { started.push(dir); };
  try {
    // Before the download, nobody uses the host.
    expect(sharedHost(await hostState(host.home))).toBeUndefined();
    // A window opens during the download.
    others = 1;
    const refused = await takeHost("/try/pr1-1111111", () => {}, () => hostState(host.home), start);
    expect(refused).toStartWith("Another Peel window uses hi-res playback");
    expect(started).toEqual([]);
    // peel --try only asked for the state, so the host still runs for that window.
    expect(host.asked.map(request => request.path)).toEqual(["/state", "/state"]);
    // Once the window closed, the test build takes the host over.
    others = 0;
    expect(await takeHost("/try/pr1-1111111", () => {}, () => hostState(host.home), start)).toBeUndefined();
    expect(started).toEqual(["/try/pr1-1111111"]);
  } finally { await host.stop(); }
});

test("a test build names its pull request and commit in the status line", async () => {
  expect(testLabel("0.1.0-try.pr118.be400a9")).toBe("Test build #118 be400a9");
  expect(testLabel("0.1.1-try.main.1a2b3c4")).toBe("Test build main 1a2b3c4");
  expect(testLabel("0.1.1-nightly.20261115.abcdef0")).toBeUndefined();
  expect(testLabel(undefined)).toBeUndefined();
});

// Narrow windows shorten the label, then drop it, so the key hints keep their place.
for (const [width, label] of [[30, undefined], [40, "#118"], [50, "#118 be400a9"], [60, "Test build #118 be400a9"], [80, "Test build #118 be400a9"], [120, "Test build #118 be400a9"]] as const) {
  test(`the test build's label leaves the key hints in place at ${width} columns`, async () => {
    const api = fixture(), setup = await createTestRenderer({ width, height: 36 });
    const model = new Model(api.library, api.player, structuredClone(defaults), async () => {}, { read: async () => undefined, write: async () => {} });
    model.testBuild = testLabel("0.1.0-try.pr118.be400a9");
    const ui = new PeelUI(setup.renderer, model);
    try {
      await model.start(); await model.releases;
      model.status = "Added to the queue: Soma"; model.changed();
      await setup.flush();
      const footer = setup.captureCharFrame().trimEnd().split("\n").at(-1)!;
      expect(footer).toEndWith("? more keys  q quit");
      if (label) expect(footer).toStartWith(`  ${label}  Add`);
      else expect(footer).not.toContain("#118");
      // The status message gets the room that is left, all of it in a wide window.
      if (width >= 120) expect(footer).toContain("Added to the queue: Soma");
      // A window made wider or narrower fits the label again.
      setup.resize(width === 40 ? 120 : 40, 36); await setup.flush();
      const resized = setup.captureCharFrame().trimEnd().split("\n").at(-1)!;
      expect(resized).toEndWith("? more keys  q quit");
      expect(resized).toStartWith(width === 40 ? "  Test build #118 be400a9  Add" : "  #118  Add");
    } finally {
      ui.dispose(); setup.renderer.destroy(); api.server.stop(true);
    }
  });
}
