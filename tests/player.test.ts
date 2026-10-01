import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Cider } from "../src/cider";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import { type Media } from "../src/types";
import { defaults, readPreferences, saveJson } from "../src/config";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixture } from "./fixture";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });


async function setup(width = 120, height = 36) {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const setup = await createTestRenderer({ width, height }); cleanup.push(() => setup.renderer.destroy());
  const saved: unknown[] = [];
  const model = new Model(api.player, structuredClone(defaults), async value => { saved.push(structuredClone(value)); });
  const ui = new PeelUI(setup.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await setup.flush();
  return { ...setup, ...api, model, ui, saved };
}

export async function click(setup: TestRendererSetup, id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing click target ${id}`);
  await setup.mockMouse.click(target.x + Math.min(1, target.width - 1), target.y);
}

async function waitFor(predicate: () => boolean) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error("Expected state did not arrive");
}

describe("the rendered player", () => {
  test("shows search, tagged favourites first, playlists, and one player strip", async () => {
    const app = await setup();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Search songs and albums");
    expect(frame.indexOf("Favourite Songs")).toBeLessThan(frame.indexOf("Background Chill"));
    expect(frame).toContain("Previous [p]"); expect(frame).toContain("1  Soma");
    expect(app.model.items[0].type).toBe("library-songs");
  });

  test("mouse and keyboard both change the observed playback state", async () => {
    const app = await setup();
    await click(app, "play-pause"); await waitFor(() => app.model.playback.state === "playing");
    await app.flush(); expect(app.captureCharFrame()).toContain("Pause [Space]");
    app.mockInput.pressKey(" "); await waitFor(() => app.model.playback.state === "paused");
    await app.flush(); expect(app.captureCharFrame()).toContain("Paused");
    for (const [id, path, key] of [["previous", "/playback/previous", "p"], ["next", "/playback/next", "n"], ["shuffle", "/playback/shuffle/toggle", "s"], ["repeat", "/playback/repeat/toggle", "r"]]) {
      const before = app.calls.filter(call => call.path === path).length;
      await click(app, id); app.mockInput.pressKey(key);
      await waitFor(() => app.calls.filter(call => call.path === path).length === before + 2);
    }
  });

  test("selecting a playlist track starts only that song and retains the collection order", async () => {
    const app = await setup();
    await click(app, "tracks:row:1");
    await waitFor(() => app.calls.some(call => call.path === "/queue/move"));
    expect(app.audible).toEqual(["i.selected"]);
    expect(app.calls.some(call => call.path === "/playback/play-collection")).toBe(false);
    expect(app.calls.find(call => call.path === "/queue/add-later")?.body).toEqual({ id: "p.favourites", type: "library-playlists" });
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 1, total: 3 });
  });

  test("a double-click activates its song once without playing the collection's first song", async () => {
    const app = await setup();
    await click(app, "tracks:row:1");
    await app.flush();
    await click(app, "tracks:row:1");
    await waitFor(() => app.calls.some(call => call.path === "/queue/move"));
    await Bun.sleep(20);
    expect(app.audible).toEqual(["i.selected"]);
    expect(app.calls.filter(call => call.path === "/playback/play-item")).toHaveLength(1);
    expect(app.calls.filter(call => call.path === "/queue/add-later")).toHaveLength(1);
    expect(await app.player.queuePosition()).toEqual({ position: 1, total: 3 });
  });

  test("different rapid selections finish in order without interleaving queue construction", async () => {
    const app = await setup();
    await Promise.all([app.model.activate(app.model.items[1]), app.model.activate(app.model.items[2])]);
    expect(app.audible).toEqual(["i.selected", "i.last"]);
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 2, total: 3 });
  });

  test("selecting the first track retains one copy of it in its collection", async () => {
    const app = await setup();
    await app.model.activate(app.model.items[0]);
    expect(app.audible).toEqual(["i.soma"]);
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 0, total: 3 });
  });

  test("manual skips in repeat-one mode use the actual queue position", async () => {
    const app = await setup();
    await app.model.act("/playback/repeat/toggle");
    app.mockInput.pressKey("n");
    await waitFor(() => app.calls.some(call => call.path === "/queue/jump"));
    expect(app.calls.find(call => call.path === "/queue/jump")?.body).toEqual({ index: 2 });
    expect(app.model.playback.repeatMode).toBe("one");
    await click(app, "previous");
    await waitFor(() => app.calls.filter(call => call.path === "/queue/jump").length === 2);
    expect(app.calls.filter(call => call.path === "/queue/jump").at(-1)?.body).toEqual({ index: 1 });
    expect(app.model.playback.repeatMode).toBe("one");
  });

  test("search accepts shortcut characters and spaces without controlling playback", async () => {
    const app = await setup();
    app.mockInput.pressKey("f", { ctrl: true });
    await app.mockInput.typeText("n p s r q / a song");
    expect(app.ui.search.value).toBe("n p s r q / a song");
    expect(app.calls.filter(call => call.method !== "GET")).toHaveLength(0);
    app.mockInput.pressEnter(); await waitFor(() => app.model.items[0]?.name === "Search result");
    await app.flush(); expect(app.captureCharFrame()).toContain("An album");
    await click(app, "tracks:row:0");
    await waitFor(() => app.calls.some(call => call.path === "/playback/play-item"));
    expect(app.calls.find(call => call.path === "/playback/play-item")?.body).toEqual({ id: "123", type: "songs" });
  });

  test("clicking the search field focuses it, and Tab and Escape navigate", async () => {
    const app = await setup();
    await click(app, "search"); await app.mockInput.typeText("hello world");
    expect(app.ui.search.value).toBe("hello world");
    app.mockInput.pressTab(); expect(app.ui.sidebar.focused).toBe(true);
    app.mockInput.pressTab(); expect(app.ui.tracks.focused).toBe(true);
    app.mockInput.pressTab({ shift: true }); expect(app.ui.sidebar.focused).toBe(true);
    app.mockInput.pressEscape(); await waitFor(() => app.ui.tracks.focused); expect(app.ui.tracks.focused).toBe(true);
  });

  test("click and keyboard seek and volume write correct units and clamp values", async () => {
    const app = await setup();
    app.mockInput.pressArrow("right"); await waitFor(() => app.model.playback.time.currentTime === 40);
    const seek = app.renderer.root.findDescendantById("seek")!;
    await app.mockMouse.click(seek.x + 5 + 49, seek.y);
    await waitFor(() => app.model.playback.time.currentTime > 90 && app.model.playback.time.currentTime < 120);
    await click(app, "volume-down"); await waitFor(() => Math.abs(app.model.playback.volume - 0.45) < 0.001);
    app.mockInput.pressKey("+"); await waitFor(() => Math.abs(app.model.playback.volume - 0.5) < 0.001);
    app.model.playback.volume = 1; await app.model.volume(0.05);
    expect(app.calls.filter(call => call.path === "/audio/volume").at(-1)).toEqual({ path: "/audio/volume", method: "PATCH", body: { volume: 1 } });
  });

  test("layout editor changes the actual sidebar and saves preferences", async () => {
    const app = await setup();
    await click(app, "layout"); await app.flush();
    await click(app, "move-down"); await waitFor(() => app.model.navigation()[0].id === "playlist:p.chill");
    await app.flush();
    expect(app.captureCharFrame().indexOf("Background Chill")).toBeLessThan(app.captureCharFrame().indexOf("Favourite Songs"));
    await click(app, "hide"); await waitFor(() => !app.model.navigation().some(row => row.id === "favourites"));
    expect(app.saved.length).toBe(2);
    app.mockInput.pressEscape(); await waitFor(() => !app.model.layout); await app.flush(); expect(app.model.layout).toBe(false);
  });

  test("playback bars change only during confirmed playback", async () => {
    const app = await setup();
    await app.model.act("/playback/play"); await app.flush(); const playing = app.captureCharFrame();
    app.ui.animate(); await app.flush(); expect(app.captureCharFrame()).not.toBe(playing);
    await app.model.act("/playback/pause"); await app.flush(); const paused = app.captureCharFrame();
    app.ui.animate(); await app.flush(); expect(app.captureCharFrame()).toBe(paused);
    await app.model.bars(); await app.flush(); expect(app.captureCharFrame()).not.toContain("▁▁▁▁▁▁");
  });

  test.each([48, 60, 80, 120])("search and essential controls remain visible at %i columns", async width => {
    const app = await setup(width, 28);
    const frame = app.captureCharFrame();
    expect(frame).toContain("Search songs and albums");
    for (const id of ["search", "previous", "play-pause", "next", "volume-down", "volume-up", "shuffle", "repeat"]) {
      const target = app.renderer.root.findDescendantById(id)!;
      expect(target.width).toBeGreaterThan(0);
      expect(target.x).toBeGreaterThanOrEqual(0); expect(target.x + target.width).toBeLessThanOrEqual(width);
      expect(target.y).toBeGreaterThanOrEqual(0); expect(target.y + target.height).toBeLessThanOrEqual(28);
      if (!["search"].includes(id)) {
        const panel = app.renderer.root.findDescendantById("player-panel")!;
        expect(target.y).toBeGreaterThan(panel.y); expect(target.y + target.height).toBeLessThan(panel.y + panel.height);
      }
    }
    await click(app, "play-pause"); await waitFor(() => app.model.playback.state === "playing");
  });

  test("the interface fits the documented minimum size and survives resizing", async () => {
    const app = await setup(48, 24);
    expect(app.captureCharFrame()).toContain("1  Soma");
    expect(app.captureCharFrame()).toContain("Vol +");
    app.resize(120, 36); await app.flush();
    expect(app.captureCharFrame()).toContain("Favourite Songs");
    expect(app.captureCharFrame()).toContain("1  Soma");
    app.resize(48, 24); await app.flush();
    expect(app.captureCharFrame()).toContain("1  Soma");
    await click(app, "play-pause"); await waitFor(() => app.model.playback.state === "playing");
  });

  test("disconnected player reports the required connection instead of claiming playback", async () => {
    const setup = await createTestRenderer({ width: 90, height: 28 }); cleanup.push(() => setup.renderer.destroy());
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const model = new Model(new Cider(`http://127.0.0.1:${api.server.port}`, "wrong-token"));
    const ui = new PeelUI(setup.renderer, model); cleanup.push(() => ui.dispose());
    await model.start(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Disconnected");
    expect(model.status).toContain("bun run connect");
  });
});

test("collection queue construction waits for the selected decoder to begin playback", async () => {
  const api = fixture({ waitForDecoder: true }); cleanup.push(() => api.server.stop(true));
  const items = await api.player.songs("p.favourites");
  const starting = api.player.playCollectionTrack({ id: "p.favourites", type: "library-playlists" }, items.items[1], 1);
  await waitFor(() => api.calls.some(call => call.path === "/playback") && api.playback.nowPlaying?.name === "Selected song");
  expect(api.playback.time.currentTime).toBe(0);
  expect(api.calls.some(call => call.path === "/queue/add-later")).toBe(false);
  api.beginPlayback();
  await starting;
  expect(api.audible).toEqual(["i.selected"]);
  expect(await api.player.queuePosition()).toEqual({ position: 1, total: 3 });
});

test("layout preferences survive a restart and use private file permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-test-")); cleanup.push(() => rm(dir, { recursive: true }));
  const value = { order: ["queue", "favourites"], hidden: ["albums"], playbackBars: false };
  await saveJson("layout.json", value, dir);
  expect(await readPreferences(dir)).toEqual(value);
  expect((await stat(join(dir, "layout.json"))).mode & 0o777).toBe(0o600);
});

test("a slow earlier search cannot overwrite a later search", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const player = api.player;
  let resolve!: (items: Media[]) => void;
  player.search = term => term === "old" ? new Promise(done => { resolve = done; }) : Promise.resolve([{ id: "new", type: "songs", name: "New result", artist: "", album: "", duration: 0 }]);
  const model = new Model(player);
  const old = model.search("old"); await model.search("new"); resolve([{ id: "old", type: "songs", name: "Old result", artist: "", album: "", duration: 0 }]); await old;
  expect(model.items[0].id).toBe("new");
});
