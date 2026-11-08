import { afterEach, expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { Model } from "../src/model";
import { fixture } from "./fixture";
import { stopped } from "../src/types";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

// A player whose first command hangs until release, as a slow remote device or a busy engine
// would. Every later key press arrives while it waits.
function slowApp() {
  const api = fixture();
  cleanup.push(() => api.server.stop(true));
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  cleanup.push(() => release());
  const calls: { method: string; args: any[] }[] = [];
  let fail = false;
  const playback = { ...structuredClone(stopped), state: "playing" as const, time: { currentTime: 30, duration: 600 }, nowPlaying: { name: "First", playParams: { id: "1" } } };
  const player = new Engine(undefined, async (path, body: any) => {
    if (path === "/state") return { ready: true, playback: structuredClone(playback) };
    const { method, args } = body;
    if (method === "position") return { position: 0, total: 5 };
    calls.push({ method, args });
    if (calls.length === 1) { started(); await held; if (fail) throw new Error("The device did not answer."); }
    if (method === "seek") playback.time.currentTime = args[0];
    if (method === "volume") playback.volume = args[0];
    if (["next", "previous", "jump"].includes(method)) { playback.time.currentTime = 0; playback.nowPlaying = { name: "Other", playParams: { id: `after-${calls.length}` } }; }
    return null;
  });
  const model = new Model(api.library, player);
  model.connected = true; model.playback = structuredClone(playback);
  return { model, calls, playback, firstStarted, release: () => release(), failFirst: () => { fail = true; } };
}

test("twenty seek presses during a slow seek run as one more seek, at the sum of the presses", async () => {
  const app = slowApp();
  const first = app.model.seek(-10);
  await app.firstStarted;
  const burst = Array.from({ length: 20 }, () => app.model.seek(-10));
  app.release();
  await Promise.all([first, ...burst]);
  expect(app.calls.map(call => [call.method, call.args[0]])).toEqual([["seek", 20], ["seek", 0]]);
});

test("waiting skips add up into one jump, and Previous then Next skip nothing", async () => {
  const app = slowApp();
  const first = app.model.act("/playback/pause");
  await app.firstStarted;
  const pending = [app.model.skip(1), app.model.skip(1), app.model.skip(1), app.model.skip(-1)];
  app.release();
  await Promise.all([first, ...pending]);
  // Two skips are one jump, two songs ahead.
  expect(app.calls.map(call => [call.method, call.args[0]])).toEqual([["pause", undefined], ["jump", 2]]);
  const again = slowApp();
  const busy = again.model.act("/playback/pause");
  await again.firstStarted;
  const cancelled = [again.model.skip(-1), again.model.skip(1)];
  again.release();
  await Promise.all([busy, ...cancelled]);
  expect(again.calls.map(call => call.method)).toEqual(["pause"]);
});

test("play/pause pressed twice while waiting cancels out, three times toggles once", async () => {
  const app = slowApp();
  const first = app.model.seek(5);
  await app.firstStarted;
  const twice = [app.model.act("/playback/toggle"), app.model.act("/playback/toggle")];
  app.release();
  await Promise.all([first, ...twice]);
  expect(app.calls.map(call => call.method)).toEqual(["seek"]);
  const again = slowApp();
  const busy = again.model.seek(5);
  await again.firstStarted;
  const thrice = [again.model.act("/playback/toggle"), again.model.act("/playback/toggle"), again.model.act("/playback/toggle")];
  again.release();
  await Promise.all([busy, ...thrice]);
  expect(again.calls.map(call => call.method)).toEqual(["seek", "toggle"]);
});

test("volume presses while waiting become one change, and other commands keep their order", async () => {
  const app = slowApp();
  const first = app.model.seek(5);
  await app.firstStarted;
  const pending = [app.model.volume(0.05), app.model.volume(0.05), app.model.act("/playback/pause"), app.model.volume(0.05)];
  app.release();
  await Promise.all([first, ...pending]);
  expect(app.calls.map(call => call.method)).toEqual(["seek", "volume", "pause"]);
  expect(app.calls[1]!.args[0]).toBeCloseTo(0.65);
});

test("a seek meant for a song that stopped playing is dropped", async () => {
  const app = slowApp();
  const first = app.model.skip(1);
  await app.firstStarted;
  const seek = app.model.seek(30);
  app.release();
  await Promise.all([first, seek]);
  expect(app.calls.map(call => call.method)).toEqual(["next"]);
});

test("a failed command does not stop later presses from running", async () => {
  const app = slowApp();
  app.failFirst();
  const first = app.model.seek(10);
  await app.firstStarted;
  app.release();
  expect(await first).toBe(false);
  expect(await app.model.seek(10)).toBe(true);
  expect(app.calls.map(call => call.method)).toEqual(["seek", "seek"]);
});

test("twenty Next presses during a slow command are one jump, so a later Pause is not held up", async () => {
  const app = slowApp();
  const first = app.model.act("/playback/pause");
  await app.firstStarted;
  const presses = Array.from({ length: 20 }, () => app.model.skip(1));
  const pause = app.model.act("/playback/pause");
  app.release();
  await Promise.all([first, ...presses, pause]);
  // The queue has five songs, so twenty skips stop at the last one.
  expect(app.calls.map(call => [call.method, call.args[0]])).toEqual([["pause", undefined], ["jump", 4], ["pause", undefined]]);
});

test("a seek or volume press builds on the change still running", async () => {
  const app = slowApp();
  const first = app.model.seek(10);
  await app.firstStarted;
  const second = app.model.seek(10), louder = [app.model.volume(0.05)];
  app.release();
  await Promise.all([first, second, ...louder]);
  expect(app.calls.filter(call => call.method === "seek").map(call => call.args[0])).toEqual([40, 50]);
  const again = slowApp();
  const busy = again.model.volume(0.05);
  await again.firstStarted;
  const next = again.model.volume(0.05);
  again.release();
  await Promise.all([busy, next]);
  expect(again.calls[0]!.args[0]).toBeCloseTo(0.55);
  expect(again.calls[1]!.args[0]).toBeCloseTo(0.6);
});

test("a seek target for one song never carries over to the next song", async () => {
  const app = slowApp();
  const first = app.model.seek(10);
  await app.firstStarted;
  // Another song starts at five seconds while the first seek still runs.
  app.playback.nowPlaying = { name: "Second", playParams: { id: "second" } }; app.playback.time.currentTime = 5;
  app.model.playback = structuredClone(app.playback);
  const second = app.model.seek(10);
  app.release();
  await Promise.all([first, second]);
  expect(app.calls.map(call => call.args[0])).toEqual([40, 15]);
});
