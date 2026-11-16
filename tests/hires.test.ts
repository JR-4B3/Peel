import { expect, test } from "bun:test";

// hires/tests/offline needs bash, python3 and a C compiler, but no Waydroid or audio hardware.
// The pipeline is Linux-only, and its scripts use GNU tools such as timeout, so CI's macOS and
// Windows runners skip it.
const ready = process.platform === "linux" && ["bash", "python3", "cc", "timeout"].every(name => Bun.which(name));

// The suite takes about 3 seconds on a desktop. With a JDK it also compiles and starts the
// controller, which takes longer on a shared CI runner. GNU timeout runs the suite in its own
// process group and stops the whole group, so a hung javac or test binary does not outlive it.
// The test's own budget leaves room for timeout's grace period and for reading the output.
const suiteSeconds = 90;
const killAfterSeconds = 5;
const testBudgetMs = (suiteSeconds + killAfterSeconds + 15) * 1000;

test.skipIf(!ready)("the hi-res pipeline's offline tests pass", () => {
  const script = new URL("../hires/tests/offline/run.sh", import.meta.url).pathname;
  const run = Bun.spawnSync(["timeout", "--kill-after", `${killAfterSeconds}s`, `${suiteSeconds}s`, "bash", script]);
  const output = run.stdout.toString() + run.stderr.toString();
  // timeout exits with 124 when it stops the suite, and with 137 when the suite also ignored SIGTERM.
  const stopped = run.exitCode === 124 || run.exitCode === 137;
  if (run.exitCode !== 0 || output.includes("FAIL"))
    console.error(`${stopped ? `run.sh did not finish within ${suiteSeconds} s. ` : ""}run.sh exited with ${run.exitCode}. Its output:\n${output}`);
  expect(output).not.toContain("FAIL");
  expect(run.exitCode).toBe(0);
}, testBudgetMs);
