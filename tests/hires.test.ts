import { expect, test } from "bun:test";

// hires/tests/offline needs bash, python3 and a C compiler, but no Waydroid or audio hardware.
// The pipeline is Linux-only, and its scripts use GNU tools such as timeout, so CI's macOS and
// Windows runners skip it.
const ready = process.platform === "linux" && ["bash", "python3", "cc"].every(name => Bun.which(name));

test.skipIf(!ready)("the hi-res pipeline's offline tests pass", () => {
  const run = Bun.spawnSync(["bash", new URL("../hires/tests/offline/run.sh", import.meta.url).pathname]);
  const output = run.stdout.toString() + run.stderr.toString();
  expect(output).not.toContain("FAIL");
  expect(run.exitCode).toBe(0);
});
