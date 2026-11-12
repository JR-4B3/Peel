// Which build of the hi-res host's code a Peel folder holds, and which of two builds is newer.
// The host reports its build, and a Peel restarts a host only when the host is older than the
// Peel itself (ensureHires in src/hires.ts). Several Peels can share one host: windows of
// different versions after an update, and Peels on other computers through the SSH helper.
// Ordering the builds, instead of restarting any host that differs, keeps two of them from
// restarting the host back and forth.
//
// This file must not import Peel's other modules, since the host runs without them.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// hash covers the code. version and time order builds. A release's version.json gives its
// version and its commit time, or only its build date for releases from before the time was
// recorded. A source folder gives package.json's version and the time its newest file changed.
export interface HostBuild { hash: string; version: string; time: string }

// The host's code in dir: src/hires.ts, the modules it imports, and the peel-hires script it runs.
export function hiresBuild(dir: string): HostBuild & { files: string[] } {
  const hasher = new Bun.CryptoHasher("sha256"), files = [join(dir, "src", "hires.ts")];
  let newest = 0;
  for (let at = 0; at < files.length; at++) {
    const file = files[at]!;
    if (!existsSync(file)) { files.splice(at--, 1); continue; }
    const text = readFileSync(file, "utf8");
    hasher.update(text);
    newest = Math.max(newest, statSync(file).mtimeMs);
    for (const [, path] of text.matchAll(/^import [^;]*? from "(\.{1,2}\/[^"]+)";/gm)) {
      const imported = resolve(dirname(file), path!.endsWith(".ts") ? path! : `${path}.ts`);
      if (!files.includes(imported)) files.push(imported);
    }
  }
  const script = join(dir, "hires", "bin", "peel-hires");
  if (existsSync(script)) {
    hasher.update(readFileSync(script));
    newest = Math.max(newest, statSync(script).mtimeMs);
    files.push(script);
  }
  const read = (name: string) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return undefined; } };
  const release = read("version.json") as { version?: string; time?: string; date?: string } | undefined;
  const order = release?.version
    ? { version: release.version, time: release.time ?? release.date ?? "" }
    : { version: String(read("package.json")?.version ?? "0.0.0"), time: newest ? new Date(newest).toISOString() : "" };
  return { hash: hasher.digest("hex"), ...order, files };
}

// Positive when a is newer than b, negative when it is older, and 0 when neither is known to be
// newer. The release number decides first, then the time. Nightly versions end in a commit hash,
// which semver would compare as text, so only the part before the first "-" counts. Times
// compare as far as both go, so a build date alone ties with any time on the same day.
export function compareBuilds(a: { version: string; time?: string }, b: { version: string; time?: string }) {
  let order = 0;
  try { order = Bun.semver.order(a.version.split("-")[0]!, b.version.split("-")[0]!); } catch {}
  if (order) return order;
  const length = Math.min(a.time?.length ?? 0, b.time?.length ?? 0);
  const x = a.time?.slice(0, length) ?? "", y = b.time?.slice(0, length) ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}
