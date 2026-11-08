// For Peel's maintainer: signs castlabs' Electron for Widevine through castlabs EVS and publishes
// it as the engine-<version> release, which Peel downloads on Windows and macOS. Run it once per
// Electron version on a Mac, which signs both Mac architectures, and again with --windows, on the
// Mac or on Windows, for both Windows architectures. EVS signs Windows builds from any system, but
// the Mac signature needs codesign, so the Mac builds need a Mac. It needs the gh CLI,
// signed in with access to the repository, and castlabs-evs with an EVS account:
//   python3 -m pip install --upgrade castlabs-evs
//   python3 -m castlabs_evs.account signup
// PEEL_PYTHON overrides the Python command, for example with a virtual environment's python.
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { command, download, electronVersion, engineTag, signedName } from "../src/engine";

const repository = "JR-4B3/Peel";
type Command = (args: string[], interactive?: boolean) => Promise<{ output: string; error: string; code: number }>;

// Reads the checksums already published with the release. A release without SHASUMS256.txt
// starts empty. A list that exists but cannot be read, or has a line that is not a checksum,
// stops the publication, so one system's upload never drops the other system's checksums.
export async function publishedSums(exec: Command, tag = engineTag) {
  const view = await exec(["gh", "release", "view", tag, "-R", repository, "--json", "assets", "-q", ".assets[].name"]);
  if (view.code) throw new Error(`Could not list the ${tag} release's files. ${view.error.trim()}`);
  if (!view.output.split("\n").map(line => line.trim()).includes("SHASUMS256.txt")) return {};
  const previous = await exec(["gh", "release", "download", tag, "-R", repository, "-p", "SHASUMS256.txt", "-O", "-"]);
  if (previous.code) throw new Error(`Could not download the ${tag} release's SHASUMS256.txt. Nothing was published. ${previous.error.trim()}`);
  const sums: Record<string, string> = {};
  for (const line of previous.output.split("\n").map(line => line.trim()).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (!match) throw new Error(`The ${tag} release's SHASUMS256.txt has a line that is not a checksum, so nothing was published: ${line}`);
    sums[match[2]!] = match[1]!;
  }
  if (!Object.keys(sums).length) throw new Error(`The ${tag} release's SHASUMS256.txt is empty, so nothing was published.`);
  return sums;
}

// Only one publication may change the release at a time. The lock is a release file, which
// gh refuses to upload a second time without --clobber.
async function withReleaseLock<T>(exec: Command, work: string, tag: string, task: () => Promise<T>) {
  const lock = join(work, "publishing.lock");
  await Bun.write(lock, `${hostname()} process ${process.pid} since ${new Date().toISOString()}\n`);
  const taken = await exec(["gh", "release", "upload", tag, "-R", repository, lock]);
  if (taken.code) throw new Error(`Another publication of ${tag} is running, or one stopped without finishing. If none is running, delete publishing.lock from the release and run this again. ${taken.error.trim()}`);
  try { return await task(); } finally { await exec(["gh", "release", "delete-asset", tag, "publishing.lock", "-R", repository, "-y"]); }
}

// Publishes this system's signed archives, which lie in work, with their checksums merged into
// the release's list. The list is read back afterwards to confirm every checksum arrived.
export async function publish(exec: Command, work: string, platform: string, sums: Record<string, string>, tag = engineTag) {
  const run = async (args: string[]) => {
    const result = await exec(args, false);
    if (result.code) throw new Error(`${args.join(" ")} failed. ${result.error.trim()}`);
  };
  if ((await exec(["gh", "release", "view", tag, "-R", repository])).code) {
    await run(["gh", "release", "create", tag, "-R", repository, "--title", `Playback engine ${electronVersion}`,
      "--notes", `castlabs' Electron ${electronVersion}, signed for Widevine through castlabs EVS. Peel downloads it on Windows and macOS.`]);
  }
  await withReleaseLock(exec, work, tag, async () => {
    const merged = { ...await publishedSums(exec, tag), ...sums };
    await Bun.write(join(work, "SHASUMS256.txt"), Object.entries(merged).map(([file, hash]) => `${hash}  ${file}`).join("\n") + "\n");
    const files = [...Object.keys(sums).filter(file => file.includes(`-${platform}-`)).map(file => join(work, file)), join(work, "SHASUMS256.txt")];
    await run(["gh", "release", "upload", tag, "-R", repository, "--clobber", ...files]);
    const after = await publishedSums(exec, tag);
    const missing = Object.keys(merged).filter(file => after[file] !== merged[file]);
    if (missing.length) throw new Error(`The release's SHASUMS256.txt is missing or has other checksums for ${missing.join(", ")}. Run this again.`);
  });
}

if (import.meta.main) {
  const platform = process.argv.includes("--windows") ? "win32" : process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("Sign the Mac engine on macOS, or the Windows engine with --windows. Linux uses castlabs' build unsigned.");
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("Run this on macOS or Windows. The archives are packed with ditto or Windows' tar.");
  const python = process.env.PEEL_PYTHON ? [process.env.PEEL_PYTHON] : process.platform === "win32" ? (Bun.which("py") ? ["py", "-3"] : ["python"]) : ["python3"];
  const run = async (args: string[], interactive = true) => {
    const result = await command(args, interactive);
    if (result.code) throw new Error(`${args.join(" ")} failed. ${result.error.trim()}`);
    return result.output;
  };
  const work = await mkdtemp(join(tmpdir(), "peel-sign-"));
  try {
    const sums: Record<string, string> = {};
    for (const arch of ["arm64", "x64"]) {
      const dir = join(work, arch), name = signedName(platform, arch), archive = join(work, name);
      await download(console.log, dir, platform, arch, false);
      console.log(`Signing ${platform} ${arch} with castlabs EVS. The first run asks for your EVS sign-in.`);
      await run([...python, "-m", "castlabs_evs.vmp", "sign-pkg", dir]);
      // On macOS the VMP signature comes first. It changes files inside the app bundle, which macOS
      // then refuses to run until the bundle is signed again. An ad hoc signature is enough for
      // a bundle that Peel downloads itself, since such files carry no quarantine flag.
      if (platform === "darwin") await run(["codesign", "--force", "--deep", "--sign", "-", join(dir, "Electron.app")]);
      // Prints how long the signature stays valid. Sign and publish again before it runs out.
      // Peel compares checksums once a day and downloads the renewed build by itself.
      await run([...python, "-m", "castlabs_evs.vmp", "verify-pkg", dir]);
      await run(process.platform === "darwin" ? ["ditto", "-c", "-k", dir, archive] : ["tar", "-a", "-c", "-f", archive, "-C", dir, "."]);
      sums[name] = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
    }
    await publish(command, work, platform, sums);
    console.log(`Published the signed ${platform} engine to the ${engineTag} release.`);
  } finally { await rm(work, { recursive: true, force: true }); }
}
