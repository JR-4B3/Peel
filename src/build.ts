// Which build of the hi-res host's code a Peel folder holds, and which of two builds is newer.
// The host reports its build, and a Peel restarts a host only when the host is older than the
// Peel itself (ensureHires in src/hires.ts). Several Peels can share one host: windows of
// different versions after an update, and Peels on other computers through the SSH helper.
// Ordering the builds, instead of restarting any host that differs, keeps two of them from
// restarting the host back and forth.
//
// This file must not import Peel's other modules, since the host runs without them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// hash covers the code. version and time order builds. A release's version.json gives its
// version and its commit time, or only its build date for releases from before the time was
// recorded. A source folder gives package.json's version and the time of its code (sourceTime).
export interface HostBuild { hash: string; version: string; time: string }

// The host's code in dir: src/hires.ts and the modules it imports, the peel-hires script it runs,
// and the controller that script compiles and starts inside Android. A controller of another
// build is replaced only when the host asks for a new one, which a restarted host does.
export function hiresBuild(folder: string): HostBuild & { files: string[] } {
  const dir = resolve(folder), hasher = new Bun.CryptoHasher("sha256"), files = [join(dir, "src", "hires.ts")];
  for (let at = 0; at < files.length; at++) {
    const file = files[at]!;
    if (!existsSync(file)) { files.splice(at--, 1); continue; }
    const text = readFileSync(file, "utf8");
    hasher.update(text);
    for (const [, path] of text.matchAll(/^import [^;]*? from "(\.{1,2}\/[^"]+)";/gm)) {
      const imported = resolve(dirname(file), path!.endsWith(".ts") ? path! : `${path}.ts`);
      if (!files.includes(imported)) files.push(imported);
    }
  }
  const control = join(dir, "hires", "android", "control");
  const java = existsSync(control) ? readdirSync(control).filter(name => name.endsWith(".java")).sort().map(name => join(control, name)) : [];
  for (const file of [join(dir, "hires", "bin", "peel-hires"), ...java]) {
    if (!existsSync(file)) continue;
    // The name goes in too, so moving code from one file to another changes the hash.
    hasher.update(relative(dir, file).replaceAll("\\", "/"));
    hasher.update(readFileSync(file));
    files.push(file);
  }
  const read = (name: string) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return undefined; } };
  const release = read("version.json") as { version?: string; time?: string; date?: string } | undefined;
  const order = release?.version
    ? { version: release.version, time: release.time ?? release.date ?? "" }
    : { version: String(read("package.json")?.version ?? "0.0.0"), time: sourceTime(dir, files) };
  return { hash: hasher.digest("hex"), ...order, files };
}

// The time of the code in a source folder, in the format scripts/package.ts records. In a git
// checkout it is the time of the commit HEAD names: checking out a branch or cloning sets the
// files' modification times to the moment it happened, so an old branch would count as new. A
// hashed file that git reports as changed or untracked counts with its modification time, when
// that is later. A folder that is not the top of a git checkout, or a computer without git,
// gives the time the newest hashed file changed. This runs git, so callers read it once.
function sourceTime(dir: string, files: string[]) {
  const modified = (list: string[]) => Math.max(0, ...list.map(file => statSync(file).mtimeMs));
  const git = (...args: string[]) => {
    try {
      // A git hook's settings would point git at another repository.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].includes(name)));
      const run = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "ignore" });
      return run.exitCode === 0 ? run.stdout.toString() : undefined;
    } catch { return undefined; }
  };
  let newest = 0;
  // The prefix is empty at the top of a checkout.
  const top = git("rev-parse", "--show-prefix")?.trim() === "";
  const committed = top ? Date.parse(git("log", "-1", "--format=%cI", "HEAD")?.trim() ?? "") : NaN;
  const status = Number.isNaN(committed) ? undefined : git("status", "--porcelain", "-z", "--untracked-files=all", "--", ...files.map(file => relative(dir, file).replaceAll("\\", "/")));
  if (status !== undefined) {
    // Each entry is two status letters, a space and the path. A renamed file's old path follows
    // as its own entry, which matches no hashed file.
    const changed = new Set(status.split("\0").map(entry => join(dir, entry.slice(3))));
    newest = Math.max(committed, modified(files.filter(file => changed.has(file))));
  } else newest = modified(files);
  return newest ? new Date(newest).toISOString() : "";
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
