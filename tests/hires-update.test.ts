// A hi-res host started by an older Peel keeps running its old code after Peel updates itself.
// Several Peels share one host: windows of two versions after an update, and Peels on other
// computers through the SSH helper. A Peel restarts the host only when the host is older.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBuilds, hiresBuild, type HostBuild } from "../src/build";
import { ensureHires, hostBuild, watchHost, type HiresStart } from "../src/hires";

const older: HostBuild = { hash: "a".repeat(64), version: "0.2.0-nightly.20261110.aaaaaaa", time: "2026-11-10T21:00:00.000Z" };
const newer: HostBuild = { hash: "b".repeat(64), version: "0.2.0-nightly.20261111.bbbbbbb", time: "2026-11-11T21:00:00.000Z" };

// One host and the Peels that share it. The host answers until a Peel asks it to quit. It then
// stops Android for a few checks, during which its /state answers as before, as a real host's
// does until its controller lock holds it, and then it is gone until a Peel starts a new one.
// When stalls is set, its /state fails while it stops, as a real one's times out.
// Starting a host runs the starting Peel's build. Nothing here starts or stops a real host.
// A host from before hosts said who uses them leaves others out.
// race runs another Peel's work at one moment: when the old host is gone, or when a Peel starts
// a host. A start finds the host that the race started, as systemd-run fails on the busy unit
// while the port answers, and returns without starting one.
type Race = { at: "gone" | "launch"; times: number; run: () => Promise<unknown> };
function computer(build: HostBuild | undefined, options: { others?: number; playing?: boolean; stalls?: boolean } = {}) {
  const others = "others" in options ? options.others : 0, { playing = false, stalls = false } = options;
  let host: { build?: HostBuild; instance: number } | undefined = { build, instance: 1 }, stopping = 0, instances = 1;
  const counts = { quits: 0, starts: 0, statusChecks: 0 };
  const machine = { race: undefined as Race | undefined, peel, counts, build: () => host?.build };
  const race = async (at: Race["at"]) => {
    const next = machine.race;
    if (next?.at !== at || next.times <= 0) return;
    next.times--;
    await next.run();
  };
  function peel(mine: HostBuild, remote = false) {
    const messages: string[] = [];
    const engine = {
      async state() {
        if (!host || stopping && stalls) throw new Error("Peel's playback engine is not running.");
        return { ready: true, signIn: false, version: "hires", build: host.build, instance: String(host.instance), others, playback: { state: playing ? "playing" : "paused" } };
      },
      async quit() { counts.quits++; stopping = 3; },
    };
    const start: HiresStart = {
      remote, build: mine,
      launch: async () => {
        await race("launch");
        if (host) return;
        counts.starts++; host = { build: mine, instance: ++instances };
      },
      // The host that runs when the watch begins runs as long as it is there. A host started
      // afterwards has a new key, as a real one's key.json does.
      watch: async () => {
        const watched = host?.instance;
        return async () => {
          counts.statusChecks++;
          if (stopping && --stopping === 0) { host = undefined; await race("gone"); }
          return !!host && host.instance === watched;
        };
      },
    };
    return { messages, ensure: () => ensureHires(engine as any, text => messages.push(text), AbortSignal.timeout(4000), start) };
  }
  return machine;
}

test("a newer window restarts an older host once", async () => {
  const machine = computer(older), window = machine.peel(newer);
  await window.ensure();
  expect(machine.counts).toMatchObject({ quits: 1, starts: 1 });
  expect(machine.build()).toEqual(newer);
  expect(window.messages).toContain("Restarting hi-res playback to load an update...");
  await window.ensure();
  expect(machine.counts).toMatchObject({ quits: 1, starts: 1 });
});

test("an older window leaves a newer host alone", async () => {
  const machine = computer(newer), window = machine.peel(older);
  await window.ensure();
  expect(machine.counts).toMatchObject({ quits: 0, starts: 0 });
  expect(machine.build()).toEqual(newer);
});

test("two windows of different builds do not restart their shared host back and forth", async () => {
  const machine = computer(older), before = machine.peel(older), after = machine.peel(newer);
  // Each command, and each request another device sends, ensures the host first.
  for (let round = 0; round < 4; round++) { await after.ensure(); await before.ensure(); }
  expect(machine.counts).toMatchObject({ quits: 1, starts: 1 });
  expect(machine.build()).toEqual(newer);
});

test("two builds that do not order leave the host alone", async () => {
  // Two releases built the same day, from before releases recorded a commit time.
  const day = { ...older, time: "2026-11-10" }, other = { ...newer, version: older.version, time: "2026-11-10" };
  const machine = computer(day);
  await machine.peel(other).ensure();
  expect(machine.counts.quits).toBe(0);
});

test("a host from before hosts reported their build restarts", async () => {
  const machine = computer(undefined);
  await machine.peel(older).ensure();
  expect(machine.counts).toMatchObject({ quits: 1, starts: 1 });
});

test("a host of this build keeps running", async () => {
  const machine = computer(hostBuild());
  await machine.peel(hostBuild()).ensure();
  expect(machine.counts.quits).toBe(0);
});

test("the SSH helper does not restart an older host that another Peel uses or that plays", async () => {
  // A window on this computer has not restarted into the update the helper already runs.
  let machine = computer(older, { others: 1 });
  await machine.peel(newer, true).ensure();
  expect(machine.counts.quits).toBe(0);
  machine = computer(older, { playing: true });
  await machine.peel(newer, true).ensure();
  expect(machine.counts.quits).toBe(0);
  // A host from before hosts said who uses them might be in use too.
  machine = computer(undefined, { others: undefined });
  await machine.peel(newer, true).ensure();
  expect(machine.counts.quits).toBe(0);
  // Nobody else uses this one, and it is paused.
  machine = computer(older);
  await machine.peel(newer, true).ensure();
  expect(machine.counts).toMatchObject({ quits: 1, starts: 1 });
});

// A newer window restarts the host an older window started. While the old host stops, the older
// window loses its connection, and a key press makes it start a host from its own code.
test("a host another window starts from older code during a restart is restarted too", async () => {
  for (const at of ["gone", "launch"] as const) {
    const machine = computer(older), before = machine.peel(older), after = machine.peel(newer);
    machine.race = { at, times: 1, run: () => before.ensure() };
    await after.ensure();
    expect(machine.build()).toEqual(newer);
    // The window's own host and the one the older window started were both restarted.
    expect(machine.counts).toMatchObject({ quits: 2, starts: 2 });
    // The older window then leaves the newer host alone.
    await before.ensure();
    expect(machine.counts).toMatchObject({ quits: 2, starts: 2 });
  }
}, 20000);

test("restarts stop after a few tries when an older window keeps starting the host", async () => {
  const machine = computer(older), before = machine.peel(older), after = machine.peel(newer);
  machine.race = { at: "gone", times: Infinity, run: () => before.ensure() };
  await expect(after.ensure()).rejects.toThrow("still runs code older than this Peel after 3 tries");
  expect(machine.counts.quits).toBe(3);
  expect(machine.build()).toEqual(older);
});

test("a host that stops Android is waited for, although its /state does not answer", async () => {
  const machine = computer(older, { stalls: true });
  await machine.peel(newer).ensure();
  // The host was checked until it was gone, and only then was a new one started.
  expect(machine.counts).toMatchObject({ quits: 1, starts: 1, statusChecks: 3 });
  expect(machine.build()).toEqual(newer);
});

test("the build covers the modules the host imports and changes with them", async () => {
  const own = hiresBuild(join(import.meta.dir, ".."));
  for (const name of ["hires.ts", "build.ts", "engine.ts", "config.ts", "apple.ts", "types.ts"]) expect(own.files).toContain(join(import.meta.dir, "..", "src", name));
  expect(own.files).toContain(join(import.meta.dir, "..", "hires", "bin", "peel-hires"));
  // The controller that peel-hires compiles and starts inside Android.
  expect(own.files).toContain(join(import.meta.dir, "..", "hires", "android", "control", "Control.java"));
  expect(own.hash).toBe(hostBuild().hash);

  const dir = await mkdtemp(join(tmpdir(), "peel-hires-build-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "hires.ts"), 'import { helper } from "./helper";\nimport type { Shape } from "./shape";\nhelper();\n');
    await writeFile(join(dir, "src", "helper.ts"), 'export const helper = () => 1;\n');
    await writeFile(join(dir, "src", "shape.ts"), 'export interface Shape { size: number }\n');
    await writeFile(join(dir, "src", "unused.ts"), 'export const unused = 1;\n');
    const first = hiresBuild(dir);
    expect(first.files.map(file => file.slice(dir.length).replaceAll("\\", "/"))).toEqual(["/src/hires.ts", "/src/helper.ts", "/src/shape.ts"]);
    // A module the host does not import does not count.
    await writeFile(join(dir, "src", "unused.ts"), 'export const unused = 2;\n');
    expect(hiresBuild(dir).hash).toBe(first.hash);
    await writeFile(join(dir, "src", "shape.ts"), 'export interface Shape { size: number; colour: string }\n');
    const second = hiresBuild(dir);
    expect(second.hash).not.toBe(first.hash);
    await writeFile(join(dir, "src", "helper.ts"), 'export const helper = () => 2;\n');
    const third = hiresBuild(dir);
    expect(third.hash).not.toBe(second.hash);
    // A release that changes only the controller changes the build.
    await mkdir(join(dir, "hires", "android", "control"), { recursive: true });
    await writeFile(join(dir, "hires", "android", "control", "Control.java"), "class Control {}\n");
    const controller = hiresBuild(dir);
    expect(controller.files.map(file => file.slice(dir.length).replaceAll("\\", "/"))).toContain("/hires/android/control/Control.java");
    expect(controller.hash).not.toBe(third.hash);
    await writeFile(join(dir, "hires", "android", "control", "Control.java"), "class Control { int version = 2; }\n");
    expect(hiresBuild(dir).hash).not.toBe(controller.hash);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("builds order by release number, then commit time or build date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-hires-order-"));
  try {
    // A source folder: package.json's version and the time its newest host file changed.
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(dir, "src", "hires.ts"), "export {};\n");
    const changed = new Date("2026-11-12T08:00:00.000Z");
    await utimes(join(dir, "src", "hires.ts"), changed, changed);
    expect(hiresBuild(dir)).toMatchObject({ version: "0.2.0", time: changed.toISOString() });
    // A release: its version.json, whatever the files' times are.
    await writeFile(join(dir, "version.json"), JSON.stringify({ version: "0.2.0-nightly.20261111.bbbbbbb", date: "2026-11-11" }));
    expect(hiresBuild(dir)).toMatchObject({ version: "0.2.0-nightly.20261111.bbbbbbb", time: "2026-11-11" });
  } finally { await rm(dir, { recursive: true, force: true }); }
  expect(compareBuilds(newer, older)).toBeGreaterThan(0);
  expect(compareBuilds(older, newer)).toBeLessThan(0);
  expect(compareBuilds({ version: "0.3.0", time: "2026-01-01" }, newer)).toBeGreaterThan(0);
  // A build date ties with any time on the same day, and with a missing one.
  expect(compareBuilds({ version: "0.2.0", time: "2026-11-11" }, newer)).toBe(0);
  expect(compareBuilds({ version: "0.2.0" }, newer)).toBe(0);
});

// A host that exited leaves its systemd unit behind for a moment. A unit that stays while no host
// answers is an error, instead of a start that seems to work and a three-minute wait.
test.skipIf(process.platform !== "linux" || !existsSync("/run/systemd/system"))("a hi-res service that stays without a host fails the start", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "peel-hires-unit-"));
  try {
    const bin = join(temporary, "bin"), runtime = join(temporary, "runtime");
    await mkdir(bin);
    await mkdir(join(runtime, "systemd"), { recursive: true });
    await writeFile(join(bin, "systemd-run"), '#!/bin/sh\necho "Failed to start transient service unit: Unit peel-hires-host.service was already loaded or has a fragment file." >&2\nexit 1\n', { mode: 0o700 });
    await writeFile(join(bin, "systemctl"), '#!/bin/sh\necho loaded\n', { mode: 0o700 });
    const port = Bun.serve({ port: 0, fetch: () => new Response() }); const free = port.port; port.stop(true);
    const source = `
      import { ensureHires } from ${JSON.stringify(new URL("../src/hires.ts", import.meta.url).pathname)};
      try { await ensureHires({ state: async () => { throw new Error("offline"); } } as any, () => {}, AbortSignal.timeout(5000)); console.log("started"); }
      catch (error) { console.log(error.message); }
    `;
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: runtime, PEEL_HIRES_HOME: join(temporary, "host"), PEEL_HIRES_PORT: String(free), PEEL_HIRES_UNIT_WAIT: "300" };
    const child = Bun.spawn([process.execPath, "-e", source], { env, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(output).toContain("the service peel-hires-host from an earlier hi-res player is still there");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

// git, kept away from the user's settings, with a fixed committer.
function git(dir: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Peel", "-c", "user.email=peel@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "..", "no-git-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_DATE: "2026-11-01T10:00:00+01:00", GIT_AUTHOR_DATE: "2026-11-01T10:00:00+01:00" },
    stdout: "pipe", stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

test.skipIf(!Bun.which("git"))("a source checkout takes its commit's time, so checking out an old branch does not make it new", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-hires-git-"));
  const committed = "2026-11-01T09:00:00.000Z", later = new Date("2026-11-05T08:00:00.000Z");
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(dir, "src", "hires.ts"), 'import { helper } from "./helper";\nhelper();\n');
    await writeFile(join(dir, "src", "helper.ts"), "export const helper = () => 1;\n");
    await writeFile(join(dir, "src", "unused.ts"), "export const unused = 1;\n");
    // Not a repository yet: the newest file's time.
    for (const name of ["hires.ts", "helper.ts"]) await utimes(join(dir, "src", name), later, later);
    expect(hiresBuild(dir).time).toBe(later.toISOString());
    // A repository without a commit has no commit time either.
    git(dir, "init", "-q");
    expect(hiresBuild(dir).time).toBe(later.toISOString());
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Build");
    // A checkout or a clone writes the files now. The commit's time counts, in the format
    // scripts/package.ts records.
    const now = new Date();
    for (const name of ["hires.ts", "helper.ts"]) await utimes(join(dir, "src", name), now, now);
    expect(hiresBuild(dir).time).toBe(committed);
    // A file the host does not import changes nothing.
    await writeFile(join(dir, "src", "unused.ts"), "export const unused = 2;\n");
    expect(hiresBuild(dir).time).toBe(committed);
    // A changed host file counts with its own time.
    // The new text has another length. Git compares a file's size and time with its index
    // before it reads the file, and this test sets the time the index already holds.
    await writeFile(join(dir, "src", "helper.ts"), "export const helper = () => 22;\n");
    await utimes(join(dir, "src", "helper.ts"), later, later);
    expect(hiresBuild(dir).time).toBe(later.toISOString());
    // A changed file older than the commit leaves the commit's time.
    const earlier = new Date("2026-10-01T00:00:00.000Z");
    await utimes(join(dir, "src", "helper.ts"), earlier, earlier);
    expect(hiresBuild(dir).time).toBe(committed);
    // A new file the host imports counts although git does not track it yet.
    await writeFile(join(dir, "src", "hires.ts"), 'import { helper } from "./helper";\nimport { extra } from "./extra";\nhelper(); extra();\n');
    await writeFile(join(dir, "src", "extra.ts"), "export const extra = () => 1;\n");
    for (const name of ["hires.ts", "extra.ts"]) await utimes(join(dir, "src", name), earlier, earlier);
    await utimes(join(dir, "src", "extra.ts"), later, later);
    expect(hiresBuild(dir).time).toBe(later.toISOString());
    git(dir, "checkout", "-q", "--", "src/hires.ts");
    await rm(join(dir, "src", "extra.ts"));
    git(dir, "checkout", "-q", "--", "src/helper.ts");
    // A folder inside another repository is not a checkout of its own: its files' times count.
    const inner = join(dir, "inner");
    await mkdir(join(inner, "src"), { recursive: true });
    await writeFile(join(inner, "src", "hires.ts"), "export {};\n");
    await utimes(join(inner, "src", "hires.ts"), later, later);
    expect(hiresBuild(inner).time).toBe(later.toISOString());
    // Without git, the files' times count too.
    const path = process.env.PATH;
    process.env.PATH = join(dir, "no-git");
    try {
      for (const name of ["hires.ts", "helper.ts"]) await utimes(join(dir, "src", name), later, later);
      expect(hiresBuild(dir).time).toBe(later.toISOString());
    } finally { process.env.PATH = path; }
    expect(hiresBuild(dir).time).toBe(committed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// While the old host stops, its /state waits for Android, so Peel looks at its port and its key.
test("a host counts as running while its port answers and key.json holds its key", async () => {
  const home = await mkdtemp(join(tmpdir(), "peel-hires-watch-"));
  const free = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port!; server.stop(true); return port; };
  let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  try {
    // key.json names the port the host listens on. The port this Peel would use differs.
    await writeFile(join(home, "key.json"), JSON.stringify({ port: server.port, key: "old" }));
    let running = await watchHost(home, free());
    expect(await running()).toBe(true);
    // A host another Peel starts writes a new key.
    await writeFile(join(home, "key.json"), JSON.stringify({ port: server.port, key: "new" }));
    expect(await running()).toBe(false);
    // A closed port means the host has gone.
    await writeFile(join(home, "key.json"), JSON.stringify({ port: server.port, key: "old" }));
    expect(await running()).toBe(true);
    const port = server.port!;
    server.stop(true);
    expect(await running()).toBe(false);
    // Without a key file the port this Peel uses counts.
    await rm(join(home, "key.json"));
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    running = await watchHost(home, port);
    expect(await running()).toBe(true);
    server.stop(true);
    expect(await running()).toBe(false);
  } finally { server.stop(true); await rm(home, { recursive: true, force: true }); }
});
