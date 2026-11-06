// The settings page, the engine's stream quality, and release updates.
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, type Preferences } from "../src/config";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import { fixture } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function settings(engine: boolean) {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const qualities: string[] = [];
  // The fixture plays through Cider. Peel's engine also sets the stream quality.
  if (engine) (api.player as any).setQuality = async (quality: string) => { qualities.push(quality); };
  const app = await createTestRenderer({ width: 120, height: 36 }); cleanup.push(() => app.renderer.destroy());
  const saved: Preferences[] = [];
  const model = new Model(api.library, api.player, structuredClone(defaults), async value => { saved.push(structuredClone(value)); });
  const channels: string[] = [];
  model.onChannel = () => channels.push(model.preferences.channel);
  const ui = new PeelUI(app.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await model.refresh();
  await model.open("settings"); ui.tracks.focus(); await app.flush();
  return { ...app, model, ui, saved, qualities, channels };
}

test("the settings page switches quality, update channel, and hearts, and saves each", async () => {
  const app = await settings(true);
  expect(app.model.navigation().map(item => item.id)).toContain("settings");
  let frame = app.captureCharFrame();
  for (const text of ["Audio quality", "High  256 kbps", "Updates", "Stable", "Hearts in Favourite Songs", "Hidden"]) expect(frame).toContain(text);
  app.mockInput.pressEnter();
  await Bun.sleep(20); await app.flush();
  // The saved quality goes to the player when it connects, then the change.
  expect(app.qualities).toEqual(["high", "standard"]);
  expect(app.captureCharFrame()).toContain("Standard  64 kbps");
  app.mockInput.pressKey("j"); app.mockInput.pressEnter();
  await Bun.sleep(20); await app.flush();
  expect(app.channels).toEqual(["nightly"]);
  frame = app.captureCharFrame();
  expect(frame).toContain("Nightly");
  // The update row sits between the channel and the hearts.
  app.mockInput.pressKey("j"); app.mockInput.pressKey("j"); app.mockInput.pressEnter();
  await Bun.sleep(20); await app.flush();
  expect(app.saved.at(-1)).toMatchObject({ quality: "standard", channel: "nightly", heartsInFavourites: true });
  expect(app.captureCharFrame()).toContain("Shown");
});

test("with Cider, the quality setting points to Cider and changes nothing", async () => {
  const app = await settings(false);
  expect(app.captureCharFrame()).toContain("Set in Cider");
  app.mockInput.pressEnter();
  await Bun.sleep(20);
  expect(app.saved).toEqual([]);
  expect(app.model.status).toContain("Cider");
});

test("a started engine gets the saved quality", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const qualities: string[] = [];
  (api.player as any).setQuality = async (quality: string) => { qualities.push(quality); };
  const model = new Model(api.library, api.player, { ...structuredClone(defaults), quality: "standard" });
  await model.refresh();
  expect(qualities).toEqual(["standard"]);
});

// A stand-in for GitHub's releases API, serving one release per channel from real archives.
async function releases() {
  const dir = await mkdtemp(join(tmpdir(), "peel-releases-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const builds: Record<string, { archive: Uint8Array<ArrayBuffer>; version: string; sum?: string }> = {};
  async function build(channel: string, version: string, engine = "engine") {
    const source = join(dir, `src-${version}`);
    await mkdir(join(source, "src"), { recursive: true });
    await mkdir(join(source, "engine"), { recursive: true });
    for (const name of ["engine.js", "main.js"]) await writeFile(join(source, "engine", name), `// ${engine} ${name}\n`);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "peel-fixture", version: "0.0.0", private: true }));
    await writeFile(join(source, "version.json"), JSON.stringify({ version, channel, commit: "abcdef1234", date: "2026-11-06" }));
    await writeFile(join(source, "src", "index.ts"), "console.log('peel')\n");
    if (Bun.spawnSync([process.execPath, "install"], { cwd: source }).exitCode) throw new Error("bun install failed");
    const archive = join(dir, `${version}.tar.gz`);
    if (Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]).exitCode) throw new Error("tar failed");
    builds[channel] = { archive: new Uint8Array(await Bun.file(archive).arrayBuffer()), version };
  }
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, fetch(request): Response {
    const url = new URL(request.url), [, , channel, file] = url.pathname.split("/");
    const base: string = `http://127.0.0.1:${server.port}/files`;
    if (url.pathname === "/releases/latest" || url.pathname === "/releases/tags/nightly") {
      const name = url.pathname.endsWith("nightly") ? "nightly" : "stable";
      if (!builds[name]) return new Response("", { status: 404 });
      return Response.json({ assets: ["peel.tar.gz", "SHASUMS256.txt", "version.json"].map(asset => ({ name: asset, browser_download_url: `${base}/${name}/${asset}` })) });
    }
    const release = builds[channel ?? ""];
    if (!release) return new Response("", { status: 404 });
    if (file === "peel.tar.gz") return new Response(release.archive);
    if (file === "version.json") return Response.json({ version: release.version, channel, commit: "abcdef1234", date: "2026-11-06" });
    return new Response(`${release.sum ?? new Bun.CryptoHasher("sha256").update(release.archive).digest("hex")}  peel.tar.gz\n`);
  } });
  cleanup.push(() => server.stop(true));
  process.env.PEEL_RELEASES_API = `http://127.0.0.1:${server.port}/releases`;
  const update = await import(`../src/update.ts?api=${server.port}`) as typeof import("../src/update");
  return { dir, build, builds, update };
}

test("a release installs beside the running one and becomes current, and a damaged one is refused", async () => {
  const { dir, build, builds, update } = await releases();
  await build("stable", "0.2.0"); await build("nightly", "0.3.0-nightly.20261106.abcdef1");
  const root = join(dir, "install");
  const stable = await update.latestRelease("stable");
  expect(stable.version).toBe("0.2.0");
  await update.installRelease(stable, root);
  expect(await readFile(join(root, "current"), "utf8")).toBe("0.2.0");
  expect(existsSync(join(root, "versions", "0.2.0", "src", "index.ts"))).toBe(true);
  expect(update.installRoot(join(root, "versions", "0.2.0"))).toBe(root);
  expect(update.installRoot(join(dir, "checkout"))).toBeUndefined();
  // Switching to nightly installs its build and keeps the stable one as current until it is ready.
  builds.nightly!.sum = "0".repeat(64);
  await expect(update.installRelease(await update.latestRelease("nightly"), root)).rejects.toThrow("checksum");
  expect(await readFile(join(root, "current"), "utf8")).toBe("0.2.0");
  expect(existsSync(join(root, "versions", "0.3.0-nightly.20261106.abcdef1"))).toBe(false);
  builds.nightly!.sum = undefined;
  await update.installRelease(await update.latestRelease("nightly"), root);
  expect(await readFile(join(root, "current"), "utf8")).toBe("0.3.0-nightly.20261106.abcdef1");
});

test("a channel without a release says so", async () => {
  const { update } = await releases();
  await expect(update.latestRelease("nightly")).rejects.toThrow("no nightly release");
});


test("switching channels back before reopening restores the running release", async () => {
  const { dir, build, update } = await releases();
  await build("stable", "0.2.0"); await build("nightly", "0.3.0-nightly.test");
  const root = join(dir, "install"), running = join(root, "versions", "0.2.0");
  await update.installRelease(await update.latestRelease("stable"), root);
  await update.checkForUpdate("nightly", true, Date.now(), running);
  expect(await readFile(join(root, "current"), "utf8")).toBe("0.3.0-nightly.test");
  await update.checkForUpdate("stable", true, Date.now(), running);
  expect(await readFile(join(root, "current"), "utf8")).toBe("0.2.0");
});

test("an update already running never says it starts on the next launch", async () => {
  const { dir, build, update } = await releases();
  await build("stable", "0.2.0"); await build("nightly", "0.3.0-nightly.test");
  const root = join(dir, "install");
  await update.installRelease(await update.latestRelease("stable"), root);
  await update.checkForUpdate("nightly", true, Date.now(), join(root, "versions", "0.2.0"));
  const result = await update.checkForUpdate("nightly", false, Date.now(), join(root, "versions", "0.3.0-nightly.test"));
  expect(result.message).not.toContain("next time");
  expect(result.message).toContain("newest nightly");
});

test("rapid channel changes finish with the last chosen release", async () => {
  const { dir, build, update } = await releases();
  await build("stable", "0.2.0"); await build("nightly", "0.3.0-nightly.test");
  const root = join(dir, "install"), running = join(root, "versions", "0.2.0");
  await update.installRelease(await update.latestRelease("stable"), root);
  await Promise.all([update.checkForUpdate("nightly", true, Date.now(), running), update.checkForUpdate("stable", true, Date.now(), running)]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("0.2.0");
});

test("the update row checks now, and offers a restart once a newer Peel is ready", async () => {
  const app = await settings(true);
  let checks = 0, restarts = 0;
  app.model.onCheckUpdate = () => { checks++; };
  app.model.onRestart = () => { restarts++; };
  app.model.update = { installed: true, version: "0.2.0", message: "Peel 0.2.0, the newest stable build." };
  app.model.changed(); await app.flush();
  expect(app.captureCharFrame()).toContain("Check for updates");
  app.mockInput.pressKey("j"); app.mockInput.pressKey("j"); app.mockInput.pressEnter();
  await Bun.sleep(20);
  expect(checks).toBe(1);

  app.model.update = { ...app.model.update, ready: "0.3.0", newEngine: false };
  app.model.changed(); await app.flush();
  let frame = app.captureCharFrame();
  for (const text of ["Restart to update", "0.3.0", "The music keeps playing"]) expect(frame).toContain(text);
  app.model.update = { ...app.model.update, newEngine: true };
  app.model.changed(); await app.flush();
  frame = app.captureCharFrame();
  expect(frame).toContain("The music stops and the queue clears");
  app.mockInput.pressEnter();
  await Bun.sleep(20);
  expect({ checks, restarts }).toEqual({ checks: 1, restarts: 1 });
});

test("an installed update is ready for a restart, which says whether the engine changes", async () => {
  const { dir, build, update } = await releases();
  await build("stable", "0.2.0"); await build("nightly", "0.3.0-nightly.test");
  const root = join(dir, "install"), running = join(root, "versions", "0.2.0");
  await update.installRelease(await update.latestRelease("stable"), root);
  expect(await update.readyVersion(running)).toEqual({});
  const result = await update.checkForUpdate("nightly", true, Date.now(), running);
  expect({ ready: result.ready, newEngine: result.newEngine }).toEqual({ ready: "0.3.0-nightly.test", newEngine: false });
  expect(update.restartCommand("0.3.0-nightly.test", running).cwd).toBe(join(root, "versions", "0.3.0-nightly.test"));
  // A cached check still reports it.
  expect((await update.checkForUpdate("nightly", false, Date.now(), running)).ready).toBe("0.3.0-nightly.test");

  await build("nightly", "0.4.0-nightly.test", "changed engine");
  expect(await update.checkForUpdate("nightly", true, Date.now(), running)).toMatchObject({ ready: "0.4.0-nightly.test", newEngine: true });
  // Switching back to the running release leaves nothing to restart into.
  expect((await update.checkForUpdate("stable", true, Date.now(), running)).ready).toBeUndefined();
});
