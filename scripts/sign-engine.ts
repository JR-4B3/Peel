// For Peel's maintainer: signs castlabs' Electron for Widevine through castlabs EVS and publishes
// it as the engine-<version> release, which Peel downloads on Windows and macOS. Run it once per
// Electron version on a Mac, for both Mac architectures, and once on Windows. It needs the gh CLI,
// signed in with access to the repository, and castlabs-evs with an EVS account:
//   python3 -m pip install --upgrade castlabs-evs
//   python3 -m castlabs_evs.account signup
// PEEL_PYTHON overrides the Python command, for example with a virtual environment's python.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, download, electronVersion, engineTag, signedName } from "../src/engine";

const platform = process.platform;
if (platform !== "darwin" && platform !== "win32") throw new Error("Sign the engine on macOS or Windows. Linux uses castlabs' build unsigned.");
const python = process.env.PEEL_PYTHON ? [process.env.PEEL_PYTHON] : platform === "win32" ? (Bun.which("py") ? ["py", "-3"] : ["python"]) : ["python3"];
const repository = "JR-4B3/Peel";

async function run(args: string[], interactive = true) {
  const result = await command(args, interactive);
  if (result.code) throw new Error(`${args.join(" ")} failed. ${result.error.trim()}`);
  return result.output;
}

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
    await run([...python, "-m", "castlabs_evs.vmp", "verify-pkg", dir]);
    await run(platform === "darwin" ? ["ditto", "-c", "-k", dir, archive] : ["tar", "-a", "-c", "-f", archive, "-C", dir, "."]);
    sums[name] = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
  }

  // The release holds both systems' builds. Keep the other system's checksums when updating it.
  const exists = (await command(["gh", "release", "view", engineTag, "-R", repository])).code === 0;
  if (exists) {
    const previous = await command(["gh", "release", "download", engineTag, "-R", repository, "-p", "SHASUMS256.txt", "-O", "-"]);
    for (const line of previous.output.split("\n")) {
      const [hash, file] = line.trim().split(/\s+/);
      if (hash && file && !(file in sums)) sums[file] = hash;
    }
  } else {
    await run(["gh", "release", "create", engineTag, "-R", repository, "--title", `Playback engine ${electronVersion}`,
      "--notes", `castlabs' Electron ${electronVersion}, signed for Widevine through castlabs EVS. Peel downloads it on Windows and macOS.`], false);
  }
  await Bun.write(join(work, "SHASUMS256.txt"), Object.entries(sums).map(([file, hash]) => `${hash}  ${file}`).join("\n") + "\n");
  const files = [...Object.keys(sums).filter(file => file.includes(`-${platform}-`)).map(file => join(work, file)), join(work, "SHASUMS256.txt")];
  await run(["gh", "release", "upload", engineTag, "-R", repository, "--clobber", ...files], false);
  console.log(`Published the signed ${platform} engine to the ${engineTag} release.`);
} finally { await rm(work, { recursive: true, force: true }); }
