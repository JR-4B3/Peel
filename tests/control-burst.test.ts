import { afterEach, expect, spyOn, test } from "bun:test";
import { Engine } from "../src/engine";
import { Model } from "../src/model";
import { fixture } from "./fixture";
import { stopped } from "../src/types";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function controller() {
  const api = fixture();
  cleanup.push(() => api.server.stop(true));
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  cleanup.push(release);
  const calls: { method: string; args: any[]; target: string }[] = [];
  let now = Date.now(), target = "local", fail = false;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const playback = {
    ...structuredClone(stopped), state: "playing" as const, time: { currentTime: 30, duration: 600 },
    nowPlaying: { name: "First", playParams: { id: "1" } },
  };
  const player = new Engine(undefined, async (path, body: any) => {
    if (path === "/state") return { ready: true, playback: structuredClone(playback) };
    const { method, args } = body;
    if (method === "position") return { position: 0, total: 5 };
    calls.push({ method, args, target });
    if (calls.length === 1) { started(); await held; if (fail) throw new Error("The device did not answer."); }
    if (method === "seek") playback.time.currentTime = args[0];
    if (["next", "previous", "jump"].includes(method)) {
      playback.time.currentTime = 0;
      playback.nowPlaying = { name: "Other", playParams: { id: method === "previous" ? "0" : "2" } };
    }
    return null;
  });
  const model = new Model(api.library, player);
  model.connected = true; model.playback = structuredClone(playback);
  return {
    model, playback, calls, release, firstStarted,
    elapse: (ms: number) => { now += ms; }, fail: () => { fail = true; },
    setTarget: (name: string) => { target = name; },
  };
}

test("a burst of seek keys does not replay every intermediate position after a slow seek", async () => {
  const app = controller();
  const first = app.model.seek(10);
  await app.firstStarted;
  const burst = Array.from({ length: 20 }, () => app.model.seek(10));
  app.release();
  await Promise.all([first, ...burst]);
  expect(app.playback.time.currentTime).toBe(240);
  expect(app.calls.map(call => call.args[0])).toEqual([40, 240]);
});

test("skipping discards pending seeks for the old song and preserves a short skip sequence", async () => {
  const app = controller();
  const first = app.model.seek(-10);
  await app.firstStarted;
  const burst = Array.from({ length: 20 }, () => app.model.seek(-10));
  const previous = app.model.skip(-1), next = app.model.skip(1);
  app.release();
  await Promise.all([first, ...burst, previous, next]);
  expect(app.calls.map(call => call.method)).toEqual(["seek", "previous", "next"]);
  expect(app.playback.time.currentTime).toBe(0);
  await app.model.seek(10);
  expect(app.playback.time.currentTime).toBe(10);
});

test("controls older than one second are dropped while queue edits and fresh controls still work", async () => {
  const app = controller();
  const first = app.model.seek(-10);
  await app.firstStarted;
  const pending = [app.model.seek(-10), app.model.skip(-1), app.model.skip(1), app.model.act("/playback/toggle"), app.model.volume(0.05)];
  const edit = app.model.act("/queue/items/3", {}, "DELETE");
  app.elapse(1001); app.release();
  await Promise.all([first, ...pending, edit]);
  expect(app.calls.map(call => call.method)).toEqual(["seek", "remove"]);
  await app.model.skip(1);
  expect(app.calls.map(call => call.method)).toEqual(["seek", "remove", "next"]);
});

test("a failed control cancels the queued gestures and allows a fresh attempt", async () => {
  const app = controller();
  const first = app.model.seek(-10);
  await app.firstStarted;
  const pending = [app.model.seek(-10), app.model.skip(-1), app.model.skip(1)];
  app.fail(); app.release();
  await Promise.all([first, ...pending]);
  expect(app.calls.map(call => call.method)).toEqual(["seek"]);
  expect(app.model.status).toContain("did not answer");
  await app.model.skip(1);
  expect(app.calls.map(call => call.method)).toEqual(["seek", "next"]);
});

test("switching devices cancels old pending controls and sends new controls to the new target", async () => {
  const app = controller();
  const first = app.model.seek(-10);
  await app.firstStarted;
  const old = app.model.skip(1);
  app.model.onOutput = async host => app.setTarget(host!);
  const switching = app.model.selectOutput("main");
  const fresh = app.model.skip(-1);
  app.release();
  await Promise.all([first, old, switching, fresh]);
  expect(app.calls.map(call => [call.method, call.target])).toEqual([["seek", "local"], ["quality", "main"], ["previous", "main"]]);
});

test("a seek is discarded if the song changes while it waits", async () => {
  const app = controller();
  const first = app.model.act("/playback/toggle");
  await app.firstStarted;
  const seeking = app.model.seekTo(50);
  app.playback.nowPlaying.playParams.id = "another";
  app.release();
  await Promise.all([first, seeking]);
  expect(app.calls.map(call => call.method)).toEqual(["toggle"]);
});

test("absolute seeks use the latest position and relative seeks clamp each press", async () => {
  const app = controller();
  const first = app.model.seekTo(20);
  await app.firstStarted;
  const pending = [app.model.seekTo(300), app.model.seekTo(590), app.model.seek(30), app.model.seek(-10)];
  app.release();
  await Promise.all([first, ...pending]);
  expect(app.calls.map(call => call.args[0])).toEqual([20, 590]);
});

test("the first control can start a cold engine while old gestures behind it expire", async () => {
  const app = controller();
  let ready!: () => void, waking!: () => void;
  const startup = new Promise<void>(resolve => { ready = resolve; });
  const started = new Promise<void>(resolve => { waking = resolve; });
  app.model.connected = false;
  app.model.wake = async () => { waking(); await startup; };
  const first = app.model.act("/playback/toggle");
  await started;
  const old = app.model.skip(1);
  app.elapse(5000); ready(); app.release();
  await Promise.all([first, old]);
  expect(app.calls.map(call => call.method)).toEqual(["quality", "toggle"]);
});

test("relative seeks keep their accumulated position across an intervening volume change", async () => {
  const app = controller();
  const first = app.model.seek(10);
  await app.firstStarted;
  const volume = app.model.volume(0.05), second = app.model.seek(10);
  app.release();
  await Promise.all([first, volume, second]);
  expect(app.calls.map(call => [call.method, call.args[0]])).toEqual([["seek", 40], ["volume", 0.55], ["seek", 50]]);
});
