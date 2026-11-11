// A hi-res host started by an older Peel keeps running its old code after Peel updates itself.
// Peel compares the host's build with its own files and restarts a host that differs.
import { expect, test } from "bun:test";
import { ensureHires, hostBuild } from "../src/hires";

// A stand-in for the host's client. The old host answers twice more after quit, while it stops
// Android, and then a host of this build answers, as one that another Peel started meanwhile would.
// A host that stops answering is started by Peel, which tests/hires-launch.test.ts covers.
function host(build: string | undefined) {
  let quits = 0, stopping = 2, current = build;
  return {
    quits: () => quits,
    async state() {
      if (quits && current === build && stopping-- <= 0) current = hostBuild();
      return { ready: true, signIn: false, version: "hires", build: current };
    },
    async quit() { quits++; },
  };
}

test("a host from another build restarts", async () => {
  const engine = host("an older build"), messages: string[] = [];
  await ensureHires(engine as any, text => messages.push(text));
  expect(engine.quits()).toBe(1);
  expect(messages).toContain("Restarting hi-res playback to load an update...");
});

test("a host from before builds were reported restarts", async () => {
  const engine = host(undefined);
  await ensureHires(engine as any);
  expect(engine.quits()).toBe(1);
});

test("a host from this build keeps running", async () => {
  const engine = host(hostBuild());
  await ensureHires(engine as any);
  expect(engine.quits()).toBe(0);
});

test("the build covers the modules the host imports", () => {
  expect(hostBuild()).toMatch(/^[0-9a-f]{64}$/);
  expect(hostBuild()).toBe(hostBuild());
});
