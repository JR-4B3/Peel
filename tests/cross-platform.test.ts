// Tests for the engine installer, release publication, and macOS launcher fixes (GitHub issues #5, #12, #13, #14).
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish, publishedSums } from "../scripts/sign-engine";
import { electronVersion, engineTag, renewSignature, signedName, unzip } from "../src/engine";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "peel-xp-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A stored (uncompressed) zip with Unix modes, as Electron's archives use.
type Entry = { name: string; data?: string; link?: string };
function zip(entries: Entry[]) {
  const encoder = new TextEncoder(), locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name), data = encoder.encode(entry.link ?? entry.data ?? "");
    const mode = entry.link !== undefined ? 0o120777 : entry.name.endsWith("/") ? 0o040755 : 0o100644;
    const local = new Uint8Array(30 + name.length + data.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true); local.set(name, 30); local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x031e, true); c.setUint16(6, 20, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(38, mode << 16 >>> 0, true); c.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const size = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end], bytes = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of all) { bytes.set(part, at); at += part.length; }
  return bytes;
}

test("#5 a symlink that points out of the engine folder is refused, and nothing is written outside", async () => {
  const dir = await temporary(), target = join(dir, "engine"), outside = join(dir, "outside");
  await mkdir(target); await mkdir(outside);
  await expect(unzip(zip([{ name: "escape", link: "../outside" }, { name: "escape/result.txt", data: "marker" }]), target)).rejects.toThrow("unsafe");
  await expect(unzip(zip([{ name: "absolute", link: outside }]), join(dir, "second"))).rejects.toThrow("unsafe");
  await expect(unzip(zip([{ name: "drive", link: "C:\\Users" }]), join(dir, "third"))).rejects.toThrow("unsafe");
  await expect(unzip(zip([{ name: "back", link: "..\\outside" }]), join(dir, "fourth"))).rejects.toThrow("unsafe");
  expect(existsSync(join(outside, "result.txt"))).toBe(false);
});

test("#5 no entry is written through a symlink, even one that points inside", async () => {
  const dir = await temporary(), target = join(dir, "engine");
  await mkdir(target);
  await expect(unzip(zip([{ name: "lib/", }, { name: "here", link: "lib" }, { name: "here/file.txt", data: "x" }]), target)).rejects.toThrow("unsafe");
  expect(existsSync(join(target, "lib", "file.txt"))).toBe(false);
  // A later entry with an earlier entry's name would replace it, or write through it.
  await expect(unzip(zip([{ name: "a.txt", data: "first" }, { name: "a.txt", data: "second" }]), join(dir, "twice"))).rejects.toThrow();
});

test("#5 files, folders, and in-folder symlinks unpack as before", async () => {
  const dir = await temporary(), target = join(dir, "engine");
  await mkdir(target);
  await unzip(zip([{ name: "resources/" }, { name: "resources/app.txt", data: "app" }, { name: "libfoo.so.1", data: "lib" }, { name: "libfoo.so", link: "libfoo.so.1" }, { name: "resources/current", link: "app.txt" }]), target);
  expect(await readFile(join(target, "resources", "app.txt"), "utf8")).toBe("app");
  expect(await readlink(join(target, "libfoo.so"))).toBe("libfoo.so.1");
  expect(await readFile(join(target, "resources", "current"), "utf8")).toBe("app");
});

// A stand-in for the release: fetch answers with this archive and checksum list.
function serveRelease(archive: Uint8Array<ArrayBuffer>, platform: string, arch: string, sum = new Bun.CryptoHasher("sha256").update(archive).digest("hex")) {
  const original = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url); requests.push(path);
    if (path.endsWith("SHASUMS256.txt")) return new Response(`${sum}  ${signedName(platform, arch)}\n`);
    if (path.endsWith(".zip")) return new Response(archive);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  cleanup.push(() => { globalThis.fetch = original; });
  return { requests, sum };
}

async function installedSigned(target: string, sum = "0".repeat(64)) {
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "old.txt"), "old build");
  await writeFile(join(target, ".vmp-signed"), `${electronVersion}\n${sum}\n`);
}

test("#13 an installed engine downloads a renewed signature for the same Electron version", async () => {
  const dir = await temporary(), target = join(dir, ".electron");
  await installedSigned(target);
  const { requests, sum } = serveRelease(zip([{ name: "new.txt", data: "renewed build" }]), "darwin", "arm64");
  expect(await renewSignature(() => {}, target, "darwin", "arm64")).toBe(true);
  expect(await readFile(join(target, "new.txt"), "utf8")).toBe("renewed build");
  expect(existsSync(join(target, "old.txt"))).toBe(false);
  expect((await readFile(join(target, ".vmp-signed"), "utf8")).split("\n")).toEqual([electronVersion, sum, ""]);
  // Checked again only a day later.
  const asked = requests.length;
  expect(await renewSignature(() => {}, target, "darwin", "arm64")).toBe(false);
  expect(requests.length).toBe(asked);
  expect(await renewSignature(() => {}, target, "darwin", "arm64", Date.now() + 25 * 60 * 60 * 1000)).toBe(false);
  expect(requests.length).toBe(asked + 1);
});

test("#13 a renewal that fails its checksum keeps the working engine", async () => {
  const dir = await temporary(), target = join(dir, ".electron");
  await installedSigned(target);
  serveRelease(zip([{ name: "new.txt", data: "renewed build" }]), "win32", "x64", "f".repeat(64));
  expect(await renewSignature(() => {}, target, "win32", "x64")).toBe(false);
  expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old build");
  expect(existsSync(join(target, "new.txt"))).toBe(false);
});

test("#13 an engine whose signed build is current downloads nothing", async () => {
  const dir = await temporary(), target = join(dir, ".electron");
  const archive = zip([{ name: "new.txt", data: "same" }]);
  const sum = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
  await installedSigned(target, sum);
  const { requests } = serveRelease(archive, "darwin", "x64");
  expect(await renewSignature(() => {}, target, "darwin", "x64")).toBe(false);
  expect(requests.every(url => url.endsWith("SHASUMS256.txt"))).toBe(true);
  expect(existsSync(join(target, "old.txt"))).toBe(true);
});

// A stand-in for gh against one release, with its files and a manifest.
function fakeRelease(options: { manifest?: string; failDownload?: boolean; lockHeld?: boolean } = {}) {
  let manifest = options.manifest, locked = options.lockHeld ?? false;
  const uploads: string[][] = [];
  const exec = async (args: string[]) => {
    const ok = (output = "") => ({ output, error: "", code: 0 }), fail = (error: string) => ({ output: "", error, code: 1 });
    const [, , verb] = args;
    if (verb === "view" && args.includes("--json")) return ok([...(manifest !== undefined ? ["SHASUMS256.txt"] : []), ...(locked ? ["publishing.lock"] : [])].join("\n"));
    if (verb === "view") return ok();
    if (verb === "download") return options.failDownload ? fail("HTTP 503") : ok(manifest);
    if (verb === "delete-asset") { locked = false; return ok(); }
    if (verb === "upload" && !args.includes("--clobber")) { if (locked) return fail("asset under the same name already exists"); locked = true; return ok(); }
    if (verb === "upload") {
      uploads.push(args);
      manifest = await readFile(args.at(-1)!, "utf8");
      return ok();
    }
    return fail(`unexpected ${args.join(" ")}`);
  };
  return { exec, uploads, manifest: () => manifest, locked: () => locked };
}

const mac = `${"a".repeat(64)}  ${signedName("darwin", "arm64")}\n${"b".repeat(64)}  ${signedName("darwin", "x64")}\n`;
const windows = { [signedName("win32", "arm64")]: "c".repeat(64), [signedName("win32", "x64")]: "d".repeat(64) };

test("#12 publishing Windows keeps the Mac checksums already on the release", async () => {
  const work = await temporary(), release = fakeRelease({ manifest: mac });
  await publish(release.exec, work, "win32", windows);
  const sums = await publishedSums(release.exec, engineTag);
  expect(Object.keys(sums).sort()).toEqual([signedName("darwin", "arm64"), signedName("darwin", "x64"), signedName("win32", "arm64"), signedName("win32", "x64")].sort());
  expect(release.locked()).toBe(false);
});

test("#12 a failed read of the existing checksums publishes nothing", async () => {
  const work = await temporary(), release = fakeRelease({ manifest: mac, failDownload: true });
  await expect(publish(release.exec, work, "win32", windows)).rejects.toThrow("Nothing was published");
  expect(release.uploads).toEqual([]);
  expect(release.locked()).toBe(false);
});

test("#12 a damaged checksum list or a running publication stops the upload", async () => {
  const damaged = fakeRelease({ manifest: "<html>rate limited</html>\n" });
  await expect(publish(damaged.exec, await temporary(), "win32", windows)).rejects.toThrow("not a checksum");
  expect(damaged.uploads).toEqual([]);
  const busy = fakeRelease({ manifest: mac, lockHeld: true });
  await expect(publish(busy.exec, await temporary(), "win32", windows)).rejects.toThrow("Another publication");
  expect(busy.uploads).toEqual([]);
  expect(busy.manifest()).toBe(mac);
});

// The launcher is for macOS. Windows has no /bin/sh to run it.
test.skipIf(process.platform === "win32")("#14 the Mac launcher's Ghostty command keeps a home path with spaces and quotes whole", async () => {
  const script = await readFile(new URL("../scripts/install-local.sh", import.meta.url), "utf8");
  const quoting = [...script.matchAll(/^\s*((?:escaped|quoted)=.*)$/gm)].map(match => match[1]).join("\n");
  expect(quoting).toContain("quoted=");
  const dir = await temporary(), home = join(dir, "Example User's Mac", "bin");
  await mkdir(home, { recursive: true });
  const launcher = join(home, "peel");
  await writeFile(launcher, "#!/bin/sh\necho launched\n", { mode: 0o755 });
  const built = Bun.spawnSync(["bash", "-c", `${quoting}; printf %s "exec $quoted"`], { env: { launcher } });
  const commandLine = built.stdout.toString();
  // Ghostty hands the command to a shell, as sh -c does here.
  const run = Bun.spawnSync(["sh", "-c", commandLine]);
  expect({ code: run.exitCode, output: run.stdout.toString().trim() }).toEqual({ code: 0, output: "launched" });
});
