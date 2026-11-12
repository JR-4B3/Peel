// Builds the release archive that every system installs: the committed files at HEAD plus
// version.json. Peel runs on Bun, so one archive serves Linux, macOS, and Windows, and each
// machine installs its own native packages after unpacking it (src/update.ts).
//   bun scripts/package.ts --channel stable|nightly [--out dist]
// A stable build's version is package.json's, and a v<version> tag being built must match it.
// A nightly build's version adds the date and commit: 0.2.0-nightly.20261107.1a2b3c4.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const option = (name: string) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const channel = option("--channel");
if (channel !== "stable" && channel !== "nightly") throw new Error("Pass --channel stable or --channel nightly.");
const out = resolve(option("--out") ?? "dist");

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

const base = (await Bun.file("package.json").json()).version as string;
const commit = git("rev-parse", "HEAD").toString().trim();
const date = new Date().toISOString().slice(0, 10);
// The commit's time orders two builds from the same day, for example when a Peel decides whether
// the hi-res host runs older code than itself (src/build.ts).
const time = new Date(git("show", "-s", "--format=%cI", "HEAD").toString().trim()).toISOString();
const version = channel === "nightly" ? `${base}-nightly.${date.replaceAll("-", "")}.${commit.slice(0, 7)}` : base;
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (channel === "stable" && tag && tag !== `v${version}`) throw new Error(`The tag ${tag} does not match package.json's version ${version}. Tag v${version}, or change the version first.`);

const staging = await mkdtemp(join(tmpdir(), "peel-package-"));
try {
  // git archive leaves out what .gitattributes marks export-ignore, such as the tests.
  const tar = join(staging, "source.tar"), tree = join(staging, "peel");
  await writeFile(tar, git("archive", "--format=tar", "HEAD"));
  await mkdir(tree);
  if (Bun.spawnSync(["tar", "-xf", tar, "-C", tree]).exitCode) throw new Error("Could not unpack git's archive.");
  const build = { version, channel, commit, date, time };
  await writeFile(join(tree, "version.json"), JSON.stringify(build, null, 2) + "\n");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const archive = join(out, "peel.tar.gz");
  if (Bun.spawnSync(["tar", "-czf", archive, "-C", tree, "."]).exitCode) throw new Error("Could not pack the release archive.");
  const sum = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
  await writeFile(join(out, "SHASUMS256.txt"), `${sum}  peel.tar.gz\n`);
  await writeFile(join(out, "version.json"), JSON.stringify(build, null, 2) + "\n");
  console.log(`Packaged Peel ${version} into ${out}`);
  // GitHub Actions reads step outputs from this file.
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
} finally { await rm(staging, { recursive: true, force: true }); }
