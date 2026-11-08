import { afterEach, describe, expect, test } from "bun:test";
import { ImageRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { AppleMusic } from "../src/apple";
import { Engine } from "../src/engine";
import { Model, parseFilter } from "../src/model";
import { PeelUI } from "../src/ui";
import { type Home, type Media } from "../src/types";
import { icon } from "../src/theme";
import { artworkUrl } from "../src/artwork";
import { defaults, readPreferences, saveJson } from "../src/config";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixture } from "./fixture";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });


async function setup(width = 120, height = 36, view?: string, cached?: Home) {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const setup = await createTestRenderer({ width, height }); cleanup.push(() => setup.renderer.destroy());
  const saved: unknown[] = [];
  const stored: Home[] = [];
  const model = new Model(api.library, api.player, structuredClone(defaults), async value => { saved.push(structuredClone(value)); },
    { read: async () => cached, write: async value => { stored.push(structuredClone(value)); } });
  const ui = new PeelUI(setup.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await model.releases;
  if (view) await model.open(view);
  await setup.flush();
  return { ...setup, ...api, model, ui, saved, stored };
}

export async function click(setup: TestRendererSetup, id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing click target ${id}`);
  await setup.mockMouse.click(target.x + Math.min(1, target.width - 1), target.y);
}

// The engine methods Peel called with this name.
const called = (app: { commands: { method: string; args: any[] }[] }, method: string) => app.commands.filter(call => call.method === method);
// The song the last play command started, and how many songs it queued.
const started = (app: { commands: { method: string; args: any[] }[] }) => {
  const play = called(app, "play").at(-1);
  return play && { id: play.args[0][play.args[1]]?.id, type: play.args[0][play.args[1]]?.type, queued: play.args[0].length };
};

async function waitFor(predicate: () => boolean) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error("Expected state did not arrive");
}

describe("the rendered player", () => {
  test("shows search, tagged favourites first, playlists, and one player strip", async () => {
    const app = await setup(120, 36, "favourites");
    const frame = app.captureCharFrame();
    expect(frame).toContain("Search Apple Music");
    const sidebar = frame.split("\n").map(line => line.slice(0, 30)).join("\n");
    expect(sidebar.indexOf("Home")).toBeLessThan(sidebar.indexOf("Favourite Songs"));
    expect(sidebar.indexOf("Favourite Songs")).toBeLessThan(sidebar.indexOf("Background Chill"));
    expect(frame).toContain(icon.previous); expect(frame).toContain("Soma");
    expect(app.model.items[0].type).toBe("library-songs");
  });

  test("mouse and keyboard both change the observed playback state", async () => {
    const app = await setup();
    await click(app, "play-pause"); await waitFor(() => app.model.playback.state === "playing");
    await app.flush(); expect(app.captureCharFrame()).toContain(`${icon.pause} space`);
    app.mockInput.pressKey(" "); await waitFor(() => app.model.playback.state === "paused");
    await app.flush(); expect(app.captureCharFrame()).toContain("Paused");
    for (const [id, method, key] of [["previous", "previous", "p"], ["next", "next", "n"], ["shuffle", "toggleShuffle", "s"], ["repeat", "toggleRepeat", "r"]]) {
      const before = called(app, method).length;
      await click(app, id); app.mockInput.pressKey(key);
      await waitFor(() => called(app, method).length === before + 2);
    }
  });

  test("selecting a playlist track queues the playlist and starts at that song", async () => {
    const app = await setup(120, 36, "favourites");
    await click(app, "tracks:row:1");
    await waitFor(() => app.audible.length === 1);
    expect(app.audible).toEqual(["i.selected"]);
    const [play] = called(app, "play");
    expect(play!.args[0].map((item: Media) => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(play!.args[1]).toBe(1);
    expect(await app.player.queuePosition()).toEqual({ position: 1, total: 3 });
  });

  test("e queues the highlighted song after the added ones, Shift+E after the playing song, and u lists the queue", async () => {
    const app = await setup(120, 36, "favourites");
    await click(app, "tracks:row:0");
    await waitFor(() => app.audible.length === 1);
    app.mockInput.pressKey("j"); app.mockInput.pressKey("j");
    app.mockInput.pressKey("e");
    await waitFor(() => app.model.status.startsWith("Added to the queue"));
    app.mockInput.pressKey("k");
    app.mockInput.pressKey("E", { shift: true });
    await waitFor(() => app.model.status.startsWith("Plays next"));
    expect(called(app, "enqueue").map(call => [call.args[0].map((item: Media) => item.id), call.args[1]])).toEqual([[["i.last"], false], [["i.selected"], true]]);
    expect(app.queue().map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last", "i.selected", "i.last"]);
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["i.selected", "i.last"]);
    app.mockInput.pressKey("u");
    await waitFor(() => app.model.view === "queue" && app.model.items.length === 2);
  });

  test("the queue moves a song with Shift+Down and Shift+E, removes it with x, and names those keys", async () => {
    const app = await setup();
    const queued = ["q.one", "q.two", "q.three"].map(id => ({ id, type: "songs", name: id, artist: "Artist", album: "Album", duration: 100 }));
    await app.player.enqueue(queued, false);
    await app.model.open("queue"); await app.flush();
    await waitFor(() => app.model.view === "queue" && app.model.items.length === 3);
    expect(app.captureCharFrame()).toContain("⇧↑↓ move");
    app.mockInput.pressArrow("down", { shift: true });
    await waitFor(() => called(app, "move").length === 1);
    expect(called(app, "move")[0]!.args).toEqual([1, 2, "q.one", "q.two"]);
    expect(app.ui.tracks.index).toBe(1);
    app.mockInput.pressKey("E", { shift: true });
    await waitFor(() => called(app, "move").length === 2);
    expect(called(app, "move")[1]!.args).toEqual([2, 1, "q.one", "q.two"]);
    app.mockInput.pressKey("x");
    await waitFor(() => called(app, "remove").length === 1);
    expect(called(app, "remove")[0]!.args).toEqual([1, "q.one"]);
    await waitFor(() => app.model.items.length === 2);
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["q.two", "q.three"]);
  });

  test("a double-click activates its song once", async () => {
    const app = await setup(120, 36, "favourites");
    await click(app, "tracks:row:1");
    await app.flush();
    await click(app, "tracks:row:1");
    await waitFor(() => app.audible.length === 1);
    await Bun.sleep(20);
    expect(app.audible).toEqual(["i.selected"]);
    expect(called(app, "play")).toHaveLength(1);
    expect(await app.player.queuePosition()).toEqual({ position: 1, total: 3 });
  });

  test("different rapid selections finish in order", async () => {
    const app = await setup(120, 36, "favourites");
    await Promise.all([app.model.activate(app.model.items[1]), app.model.activate(app.model.items[2])]);
    expect(app.audible).toEqual(["i.selected", "i.last"]);
    expect(app.queue().map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 2, total: 3 });
  });

  test("selecting the first track starts the collection at its start", async () => {
    const app = await setup(120, 36, "favourites");
    await app.model.activate(app.model.items[0]);
    expect(app.audible).toEqual(["i.soma"]);
    expect(app.queue().map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 0, total: 3 });
  });

  test("manual skips in repeat-one mode use the actual queue position", async () => {
    const app = await setup();
    await app.model.act("/playback/repeat/toggle");
    app.mockInput.pressKey("n");
    await waitFor(() => called(app, "jump").length === 1);
    expect(called(app, "jump")[0]!.args).toEqual([1]);
    expect(app.model.playback.repeatMode).toBe("one");
    await click(app, "previous");
    await waitFor(() => called(app, "jump").length === 2);
    expect(called(app, "jump")[1]!.args).toEqual([0]);
    expect(app.model.playback.repeatMode).toBe("one");
  });

  test("search accepts shortcut characters and spaces without controlling playback", async () => {
    const app = await setup();
    app.mockInput.pressKey("f", { ctrl: true });
    await app.mockInput.typeText("n p s r q / a song");
    expect(app.ui.search.value).toBe("n p s r q / a song");
    expect(app.commands.filter(call => call.method !== "quality")).toHaveLength(0);
    app.mockInput.pressEnter(); await waitFor(() => app.model.items[0]?.name === "Search result");
    await app.flush(); expect(app.captureCharFrame()).toContain("An album");
    // Songs form the list. Albums and artists are shelves of covers.
    expect(app.model.shelves.map(shelf => [shelf.title, shelf.items[0]?.id])).toEqual([["Albums", "456"], ["Artists", "100"]]);
    await click(app, "tracks:row:0");
    await waitFor(() => called(app, "play").length === 1);
    expect(called(app, "play")[0]!.args[0].map((item: Media) => [item.id, item.type])).toEqual([["123", "songs"]]);
  });

  test("End and Home jump to the ends of a song list", async () => {
    const app = await setup(120, 36, "favourites");
    app.ui.tracks.focus();
    app.mockInput.pressKey("END"); await app.flush();
    expect(app.ui.tracks.index).toBe(2);
    app.mockInput.pressKey("HOME"); await app.flush();
    expect(app.ui.tracks.index).toBe(0);
  });

  test("a long list loads 500 songs on its own, then a page more near its end", async () => {
    const app = await setup(120, 36, "favourites");
    const offsets: number[] = [];
    (app.model as any).loader = async (offset: number) => {
      offsets.push(offset);
      return { items: Array.from({ length: 100 }, (_, n): Media => ({ id: `i.${offset + n}`, type: "library-songs", name: `Song ${offset + n}`, artist: "", album: "", duration: 1, loved: false })), more: offset < 900 };
    };
    await app.model.load(false);
    expect(offsets).toEqual([0, 100, 200, 300, 400]);
    expect(app.model.items.length).toBe(500);
    await app.flush();
    expect(offsets.length).toBe(5);
    app.ui.tracks.focus();
    app.mockInput.pressKey("END");
    await waitFor(() => app.model.items.length === 600 && !app.model.loading);
    expect(offsets.at(-1)).toBe(500);
  });

  test("clicking the search field focuses it, and Tab and Escape navigate", async () => {
    const app = await setup();
    await click(app, "search"); await app.mockInput.typeText("hello world");
    expect(app.ui.search.value).toBe("hello world");
    app.mockInput.pressTab(); expect(app.ui.sidebar.focused).toBe(true);
    app.mockInput.pressTab(); expect(app.ui.grid.focused).toBe(true);
    app.mockInput.pressTab({ shift: true }); expect(app.ui.sidebar.focused).toBe(true);
    app.mockInput.pressEscape(); await waitFor(() => app.ui.grid.focused); expect(app.ui.grid.focused).toBe(true);
  });

  test("click and keyboard seek and volume write correct units and clamp values", async () => {
    const app = await setup(120, 36, "favourites");
    app.mockInput.pressArrow("right"); await waitFor(() => app.model.playback.time.currentTime === 40);
    const seek = app.renderer.root.findDescendantById("seek")!;
    await app.mockMouse.click(seek.x + 5 + 49, seek.y);
    await waitFor(() => app.model.playback.time.currentTime > 90 && app.model.playback.time.currentTime < 120);
    await click(app, "volume-down"); await waitFor(() => Math.abs(app.model.playback.volume - 0.45) < 0.001);
    app.mockInput.pressKey("+"); await waitFor(() => Math.abs(app.model.playback.volume - 0.5) < 0.001);
    app.model.playback.volume = 1; await app.model.volume(0.05);
    expect(called(app, "volume").at(-1)!.args).toEqual([1]);
  });

  test("the mouse wheel over the player changes the volume, and lists still scroll", async () => {
    const app = await setup(120, 36, "favourites");
    const volume = app.renderer.root.findDescendantById("volume")!;
    await app.mockMouse.scroll(volume.x, volume.y, "up"); await waitFor(() => Math.abs(app.model.playback.volume - 0.55) < 0.001);
    const title = app.renderer.root.findDescendantById("now-playing")!;
    await app.mockMouse.scroll(title.x, title.y, "down"); await app.mockMouse.scroll(title.x, title.y, "down");
    await waitFor(() => Math.abs(app.model.playback.volume - 0.45) < 0.001);
    expect(called(app, "volume").at(-1)!.args).toEqual([0.45]);
    // Sideways scrolling leaves it alone, and a list under the wheel scrolls instead.
    await app.mockMouse.scroll(title.x, title.y, "left"); await app.mockMouse.scroll(app.ui.grid.x + 2, app.ui.grid.y + 2, "down");
    await app.flush(); await Bun.sleep(50);
    expect(Math.abs(app.model.playback.volume - 0.45)).toBeLessThan(0.001);
  });

  test("a burst of seek arrows runs as one more seek, and Previous then Next cancel out", async () => {
    const app = await setup(120, 36, "favourites");
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const command = app.player.command.bind(app.player);
    let first = true;
    app.player.command = async (path, body, method) => {
      if (path === "/playback/seek" && first) { first = false; started(); await held; }
      return command(path, body, method);
    };
    app.mockInput.pressArrow("left");
    await firstStarted;
    try {
      for (let index = 0; index < 20; index++) app.mockInput.pressArrow("left");
      app.mockInput.pressKey("p"); app.mockInput.pressKey("n");
    } finally { release(); }
    // Waiting for a later control also waits for the keyboard commands ahead of it.
    await app.model.volume(0.05);
    expect(app.commands.filter(call => call.method !== "volume" && call.method !== "quality").map(call => call.method)).toEqual(["seek", "seek"]);
  });

  test("the sidebar shows hidden entries only while editing, and Enter shows or hides them", async () => {
    const app = await setup();
    expect(app.renderer.root.findDescendantById("layout")).toBeFalsy();
    await app.model.hide("albums"); await app.flush();
    // Focusing the sidebar alone keeps hidden entries out of the way.
    app.ui.sidebar.focus(); await app.flush();
    expect(app.captureCharFrame()).not.toContain("Albums");
    expect(app.captureCharFrame()).not.toContain("show or hide");
    app.mockInput.pressKey("e"); await app.flush();
    expect(app.captureCharFrame()).toContain("Albums");
    expect(app.captureCharFrame()).toContain("show or hide");
    app.ui.sidebar.selectKey("favourites");
    app.mockInput.pressArrow("down", { shift: true }); await waitFor(() => app.model.entries()[0].id === "playlist:p.chill");
    await app.flush();
    expect(app.captureCharFrame().indexOf("Background Chill")).toBeLessThan(app.captureCharFrame().indexOf("Favourite Songs"));
    expect(app.ui.sidebar.selectedId()).toBe("favourites");
    // Enter hides the entry instead of opening it. It stays listed so it can be shown again.
    app.mockInput.pressEnter(); await waitFor(() => !app.model.navigation().some(row => row.id === "favourites"));
    expect(app.model.view).toBe("home");
    await app.flush(); expect(app.captureCharFrame()).toContain("Favourite Songs");
    app.ui.sidebar.selectKey("albums"); app.mockInput.pressEnter();
    await waitFor(() => app.model.navigation().some(row => row.id === "albums"));
    expect(app.saved.length).toBe(4);
    // e again finishes editing.
    app.mockInput.pressKey("e"); await app.flush();
    expect(app.captureCharFrame()).not.toContain("Favourite Songs");
    expect(app.captureCharFrame()).toContain("Albums");
    expect(app.captureCharFrame()).not.toContain("show or hide");
  });

  test("the mouse edits the sidebar through Edit and Done, and editing ends when focus moves on", async () => {
    const app = await setup();
    await click(app, "sidebar-edit"); await app.flush();
    expect(app.ui.sidebar.focused).toBe(true);
    expect(app.captureCharFrame()).toContain("Done");
    await click(app, "sidebar:row:favourites"); await waitFor(() => !app.model.navigation().some(row => row.id === "favourites"));
    expect(app.model.view).toBe("home");
    await click(app, "sidebar:row:favourites"); await waitFor(() => app.model.navigation().some(row => row.id === "favourites"));
    await click(app, "sidebar-edit"); await app.flush();
    expect(app.captureCharFrame()).toContain("Edit");
    await click(app, "sidebar:row:favourites"); await waitFor(() => app.model.view === "favourites");
    // Leaving the sidebar ends editing.
    await click(app, "sidebar-edit"); await app.model.hide("albums"); await app.flush();
    expect(app.captureCharFrame()).toContain("Albums");
    app.ui.tracks.focus(); await app.flush();
    expect(app.captureCharFrame()).not.toContain("Albums");
    expect(app.captureCharFrame()).not.toContain("show or hide");
  });

  test.each([48, 60, 80, 120])("search and essential controls remain visible at %i columns", async width => {
    const app = await setup(width, 28);
    const frame = app.captureCharFrame();
    expect(frame).toContain("Search Apple Music");
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

  // Issue #79: every button that shows is whole, inside each box around it, and apart from the others.
  test.each([76, 100, 140])("no button is cut off or overlaps another at %i columns", async width => {
    const app = await setup(width, 30, "albums");
    const visible = (node: any) => { for (let n = node; n; n = n.parent) if (n.visible === false) return false; return true; };
    const check = async (page: string) => {
      await app.flush();
      const buttons = ((app.ui as any).buttons as any[]).filter(button => visible(button) && button.width > 0);
      expect(buttons.length).toBeGreaterThan(5);
      for (const button of buttons) {
        const where = `${button.id} on ${page} at ${width} columns`;
        // The whole label fits in the button's own width.
        expect(Bun.stringWidth(button.plainText), where).toBeLessThanOrEqual(button.width);
        // Every box around it contains it, so nothing hides part of it.
        for (let box = button.parent; box && box !== app.renderer.root; box = box.parent) {
          expect(button.x >= box.x && button.x + button.width <= box.x + box.width, `${where}: sideways in ${box.id}`).toBe(true);
          expect(button.y >= box.y && button.y + button.height <= box.y + box.height, `${where}: vertically in ${box.id}`).toBe(true);
        }
        expect(button.x + button.width).toBeLessThanOrEqual(width);
        for (const other of buttons) {
          if (other === button) continue;
          const apart = button.x + button.width <= other.x || other.x + other.width <= button.x || button.y + button.height <= other.y || other.y + other.height <= button.y;
          expect(apart, `${where} overlaps ${other.id}`).toBe(true);
        }
      }
    };
    await check("albums");
    await click(app, "grid:tile:albums:0");
    await waitFor(() => app.model.detail?.id === "l.soma");
    await check("an album");
    // The heart and play buttons still answer a click at every width.
    await click(app, "favourite-album");
    await waitFor(() => app.model.status === "Added SOMA to favourite albums");
    await app.model.open("favourites");
    await check("favourite songs");
  });

  test("the interface fits the documented minimum size and survives resizing", async () => {
    const app = await setup(48, 24);
    expect(app.captureCharFrame()).toContain("SOMA");
    expect(app.captureCharFrame()).toContain("50%");
    app.resize(120, 36); await app.flush();
    expect(app.captureCharFrame()).toContain("Favourite Songs");
    expect(app.captureCharFrame()).toContain("Recently played");
    app.resize(48, 24); await app.flush();
    expect(app.captureCharFrame()).toContain("SOMA");
    await click(app, "play-pause"); await waitFor(() => app.model.playback.state === "playing");
  });

  test("without a running engine the library still shows, and playing reports why", async () => {
    const setup = await createTestRenderer({ width: 90, height: 28 }); cleanup.push(() => setup.renderer.destroy());
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const model = new Model(api.library, new Engine(join(tmpdir(), "peel-no-engine")));
    const ui = new PeelUI(setup.renderer, model); cleanup.push(() => ui.dispose());
    await model.start(); await setup.flush();
    expect(model.playlists.map(item => item.name)).toContain("Background Chill");
    expect(setup.captureCharFrame()).toContain("Stopped");
    await click(setup, "play-pause");
    await waitFor(() => model.status.includes("engine is not running"));
    expect(model.connected).toBe(false);
  });

  test("browsing loads while the engine starts, and the first song waits for it once", async () => {
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const model = new Model(api.library, api.player);
    let wakes = 0, open!: () => void;
    const ready = new Promise<void>(done => { open = done; });
    model.wake = async () => { wakes++; await ready; };
    // The engine has not answered yet.
    const snapshot = api.player.snapshot.bind(api.player);
    let up = false;
    api.player.snapshot = () => up ? snapshot() : Promise.reject(new Error("The playback engine is starting."));
    await model.start();
    expect(model.playlists.length).toBe(2);
    expect(model.home.recent.length).toBeGreaterThan(0);
    expect(model.connected).toBe(false);
    expect(model.status).not.toContain("engine is starting");
    await model.open("songs");
    const first = model.activate(model.items[0]!), second = model.act("/playback/next");
    await Bun.sleep(20);
    expect(model.starting).toBe(true);
    expect(api.commands).toHaveLength(0);
    up = true; open();
    await Promise.all([first, second]);
    expect(wakes).toBe(1);
    expect(model.connected).toBe(true);
    expect(api.commands.filter(call => call.method === "play" || call.method === "next").map(call => call.method)).toEqual(["play", "next"]);
  });
});

test("Apple Music renews a rejected developer token once and a rejected user token through the engine", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  // Like the real cache, a refreshed developer token is kept for later requests.
  const refreshes: boolean[] = [];
  let current = "stale";
  const library = new AppleMusic("expired", {
    base: api.library.base, developerToken: async refresh => { refreshes.push(refresh); if (refresh) current = "dev-token"; return current; },
    renewUser: async () => "user-token",
  });
  expect((await library.playlists()).length).toBe(2);
  expect(refreshes).toEqual([false, true, false]);
  const rejected = new AppleMusic("expired", { base: api.library.base, developerToken: async () => "dev-token" });
  await expect(rejected.playlists()).rejects.toThrow("peel --connect");
  await expect(new AppleMusic("", { base: api.library.base, developerToken: async () => "dev-token" }).playlists()).rejects.toThrow("no Apple Music sign-in");
});

test("layout preferences survive a restart and use private file permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-test-")); cleanup.push(() => rm(dir, { recursive: true }));
  const value = { order: ["queue", "favourites"], hidden: ["albums"], heartsInFavourites: true, channel: "nightly" as const, quality: "standard" as const, textSize: 14 };
  await saveJson("layout.json", value, dir);
  expect(await readPreferences(dir)).toEqual(value);
  // A layout from an older Peel, without the newer settings, gets their defaults.
  await saveJson("layout.json", { order: [], hidden: [], heartsInFavourites: false }, dir);
  expect(await readPreferences(dir)).toMatchObject({ channel: "stable", quality: "high", textSize: 0 });
  // A text size Peel doesn't offer falls back to Ghostty's own.
  await saveJson("layout.json", { textSize: "18; rm -rf /" }, dir);
  expect((await readPreferences(dir)).textSize).toBe(0);
  // Windows has no Unix file modes. Its user profile folders are private already.
  if (process.platform !== "win32") expect((await stat(join(dir, "layout.json"))).mode & 0o777).toBe(0o600);
});

test("a slow earlier search cannot overwrite a later search", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const library = api.library;
  let resolve!: (items: Media[]) => void;
  library.search = term => term === "old" ? new Promise(done => { resolve = done; }) : Promise.resolve([{ id: "new", type: "songs", name: "New result", artist: "", album: "", duration: 0 }]);
  const model = new Model(library, api.player);
  const old = model.search("old"); await model.search("new"); resolve([{ id: "old", type: "songs", name: "Old result", artist: "", album: "", duration: 0 }]); await old;
  expect(model.items[0].id).toBe("new");
});

describe("home, albums, and favourites", () => {
  test("home shows recently played collections and recent releases from favourite artists", async () => {
    const app = await setup();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Recently played"); expect(frame).toContain("New from your favourite artists");
    expect(app.model.home.recent.map(item => item.id)).toEqual(["a.soma", "pl.mix"]);
    expect(app.model.home.releases.map(item => item.id)).toEqual(["a.soon", "a.new"]);
    expect(frame).toContain("Out ");
    expect(app.stored.at(-1)?.releases).toHaveLength(2);
  });

  test("a fresh cached home is shown without scanning artists again", async () => {
    const cached: Home = { recent: [], releases: [{ id: "a.cached", type: "albums", name: "Cached Album", artist: "Someone", album: "", duration: 0, releaseDate: "2026-01-01" }], updated: Date.now() };
    const app = await setup(120, 36, undefined, cached);
    expect(app.captureCharFrame()).toContain("Cached");
    expect(app.model.home.releases.map(item => item.id)).toEqual(["a.cached"]);
    // The sidebar's Artists list is read ahead, so the scan shows as its catalog request.
    expect(app.calls.some(call => call.path === "/v1/catalog/de/artists")).toBe(false);
    expect(app.model.home.recent.map(item => item.id)).toEqual(["a.soma", "pl.mix"]);
  });

  test("favourite songs show a heart before their title, and every song in Favourite Songs does", async () => {
    const app = await setup(120, 36, "songs");
    await waitFor(() => app.model.items.every(item => item.loved !== undefined)); await app.flush();
    expect(app.model.items.map(item => [item.id, item.loved])).toEqual([["i.soma", false], ["i.selected", true], ["i.last", false]]);
    const lines = app.captureCharFrame().split("\n");
    expect(lines.find(line => line.includes("Selected song"))).toContain(icon.heart);
    expect(lines.find(line => line.includes("Last song"))).not.toContain(icon.heart);
    await app.model.open("favourites"); await app.flush();
    expect(app.model.items.every(item => item.loved)).toBe(true);
    // Every song there is a favourite, so the rows show no heart unless the preference asks for them.
    expect(app.captureCharFrame()).not.toContain(icon.heart + " Selected song");
    app.model.preferences = { ...app.model.preferences, heartsInFavourites: true }; app.model.changed(); await app.flush();
    expect(app.captureCharFrame()).toContain(icon.heart + " Selected song");
    expect(app.calls.filter(call => call.path.startsWith("/v1/me/ratings/")).length).toBe(1);
  });

  test("song lists filter by words, sort, show favourites only, and play a filtered song", async () => {
    const app = await setup(120, 36, "songs");
    await waitFor(() => app.model.items.every(item => item.loved !== undefined));
    app.ui.tracks.focus();
    app.mockInput.pressKey("F", { shift: true }); await app.flush();
    expect(app.ui.filterInput.focused).toBe(true);
    await app.mockInput.typeText("LAST");
    await waitFor(() => app.model.shown.length === 1);
    expect(app.model.shown[0]!.name).toBe("Last song");
    // The row keeps its playlist number, and selecting it plays that song.
    app.mockInput.pressEnter(); await app.flush();
    await click(app, "tracks:row:0");
    await waitFor(() => called(app, "play").length === 1);
    expect(started(app)).toEqual({ id: "i.last", type: "library-songs", queued: 1 });
    app.mockInput.pressEscape(); await waitFor(() => app.model.shown.length === 3);
    app.mockInput.pressKey("o"); await app.flush();
    expect(app.model.filter.sort).toBe("title");
    expect(app.model.shown.map(item => item.name)).toEqual(["Last song", "Selected song", "Soma"]);
    app.mockInput.pressKey("*"); await app.flush();
    expect(app.model.shown.map(item => item.name)).toEqual(["Selected song"]);
  });

  test("filter text understands year ranges, decades, and bounds", () => {
  expect(parseFilter("kanye 2004 - 2010")).toEqual({ words: ["kanye"], years: [[2004, 2010]], either: [] });
  expect(parseFilter(">2018 <=2020 90s 1980s 2015+ 2016").years).toEqual([[2019, 9999], [0, 2020], [1990, 1999], [1980, 1989], [2015, 9999]]);
  expect(parseFilter("2016").either).toEqual([2016]);
});

test("year filters, year sorting, and reversed order work on the loaded songs", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const song = (id: string, year: string, name = id): Media => ({ id, type: "library-songs", name, artist: "", album: "", duration: 1, releaseDate: `${year}-01-01` });
  const model = new Model(api.library, api.player);
  model.items = [song("a", "1995"), song("b", "2016", "Song 1999"), song("c", "2021"), song("d", "1999")];
  await model.setFilter({ text: "90s" });
  expect(model.shown.map(item => item.id)).toEqual(["a", "d"]);
  // A bare year matches the release year or a title.
  await model.setFilter({ text: "1999" });
  expect(model.shown.map(item => item.id)).toEqual(["b", "d"]);
  await model.setFilter({ text: "", sort: "year", descending: true });
  expect(model.shown.map(item => item.id)).toEqual(["c", "b", "d", "a"]);
  await model.setFilter({ sort: "playlist" });
  expect(model.shown.map(item => item.id)).toEqual(["d", "c", "b", "a"]);
});

test("filtering loads the rest of the list first", async () => {
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const pages = [0, 100].map(offset => Array.from({ length: 100 }, (_, n): Media => ({ id: `i.${offset + n}`, type: "library-songs", name: `Song ${offset + n}`, artist: "", album: "", duration: 1 })));
    const model = new Model(api.library, api.player);
    model.view = "songs";
    (model as any).loader = async (offset: number) => ({ items: pages[offset / 100] ?? [], more: offset === 0 });
    // Filtering starts while the background load is still running, and waits for it.
    void model.load(false);
    expect(model.loading).toBe(true);
    await model.setFilter({ text: "song 150" });
    expect(model.items.length).toBe(200);
    expect(model.shown.map(item => item.id)).toEqual(["i.150"]);
  });

  test("clicking an album cover opens the album, and Escape returns to the same cover", async () => {
    const app = await setup(120, 36, "albums");
    expect(app.captureCharFrame()).toContain("Other Album");
    await click(app, "grid:tile:albums:1");
    await waitFor(() => app.model.detail?.id === "l.other" && app.model.items.length === 3);
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Other Album"); expect(frame).toContain("3 songs"); expect(frame).toContain("Back");
    await click(app, "tracks:row:1");
    await waitFor(() => called(app, "play").length === 1);
    expect(started(app)).toEqual({ id: app.model.items[1]!.id, type: app.model.items[1]!.type, queued: 3 });
    app.mockInput.pressEscape(); await waitFor(() => app.model.view === "albums");
    expect(app.ui.grid.selected()?.media.id).toBe("l.other");
    expect(app.ui.grid.focused).toBe(true);
  });

  test("a recently played catalog playlist opens its tracks", async () => {
    const app = await setup();
    app.ui.grid.select("pl.mix"); app.mockInput.pressEnter();
    await waitFor(() => app.model.items.length === 3);
    expect(app.model.title).toBe("Favourites Mix");
    expect(app.calls.some(call => call.path === "/v1/catalog/de/playlists/pl.mix/tracks")).toBe(true);
  });

  test("arrow keys move through covers, and Shift seeks", async () => {
    const app = await setup();
    app.mockInput.pressArrow("right"); await app.flush();
    expect(app.ui.grid.selected()?.media.id).toBe("pl.mix");
    app.mockInput.pressArrow("down"); await app.flush();
    expect(app.ui.grid.selected()?.media.id).toBe("a.new");
    expect(called(app, "seek")).toHaveLength(0);
    app.mockInput.pressArrow("right", { shift: true });
    await waitFor(() => called(app, "seek").length > 0);
  });

  test("the heart favourites the playing song and confirms the stored rating", async () => {
    const app = await setup();
    expect(app.captureCharFrame()).toContain(icon.heartOutline);
    await click(app, "favourite");
    await waitFor(() => app.model.status === "Added to Favourite Songs");
    expect(called(app, "rate")[0]!.args[0]).toBe(1);
    await app.flush(); expect(app.captureCharFrame()).toContain(icon.heart);
    app.mockInput.pressKey("f");
    await waitFor(() => app.model.status === "Removed from Favourite Songs");
    expect(called(app, "rate").at(-1)!.args[0]).toBe(0);
    expect(app.model.favourite).toBe(false);
  });

  test("a song the player has not rated yet is looked up with Apple right away", async () => {
    const api = fixture({ silentRating: true }); cleanup.push(() => api.server.stop(true));
    api.playback.nowPlaying = { name: "Selected song", artistName: "Skrillex", playParams: { id: "i.selected" } };
    const model = new Model(api.library, api.player);
    await model.start(); await model.refresh();
    await waitFor(() => model.favourite === true);
    api.playback.nowPlaying = { name: "Soma", artistName: "Skrillex", playParams: { id: "i.other" } };
    await model.refresh();
    await waitFor(() => model.favourite === false);
  });

  test("an open album's heart favourites it through its catalog album, and l removes it", async () => {
    const app = await setup(120, 36, "albums");
    await click(app, "grid:tile:albums:0");
    await waitFor(() => app.model.albumFavourite === false); await app.flush();
    expect(app.captureCharFrame()).toContain("Favourite  l");
    await click(app, "favourite-album");
    await waitFor(() => app.model.status === "Added SOMA to favourite albums");
    expect([...app.lovedAlbums]).toEqual(["1440"]);
    await app.flush(); expect((app.renderer.root.findDescendantById("favourite-album") as any)?.plainText).toContain(icon.heart);
    app.mockInput.pressKey("l");
    await waitFor(() => app.model.status === "Removed SOMA from favourite albums");
    expect(app.lovedAlbums.size).toBe(0);
    expect(app.model.albumFavourite).toBe(false);
  });
});

describe("the enlarged cover", () => {
  // A valid 2 by 2 PNG exercises decoding and image ownership.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOUi1rAwMDAxMDAwMDAAAAMyAEcmM2rsQAAAABJRU5ErkJggg==", "base64");

  test("growing the window requests a sharper cover and restores the full caption", async () => {
    const requested: string[] = [];
    const art = Bun.serve({ port: 0, fetch: request => { requested.push(new URL(request.url).pathname); return new Response(png); } });
    cleanup.push(() => art.stop(true));
    const app = await setup(60, 36, "albums");
    Object.defineProperty(app.renderer, "resolution", { get: () => ({ width: app.renderer.terminalWidth * 10, height: app.renderer.terminalHeight * 20 }) });
    await click(app, "grid:tile:albums:0");
    await waitFor(() => app.model.detail?.id === "l.soma");
    const name = "An album with a title longer than the narrow window can display in one line";
    app.model.detail!.name = name;
    app.model.detail!.artwork = `http://127.0.0.1:${art.port}/resize/{w}x{h}bb.{f}`;
    app.model.changed(); await app.flush();
    await click(app, "collection-cover"); await app.flush();
    const image = app.renderer.root.findDescendantById("cover-view-image") as ImageRenderable;
    await waitFor(() => requested.includes("/resize/600x600bb.jpg") && image.image?.width === 2 && !image.loading);
    expect(image.loadError).toBeNull();
    expect(app.captureCharFrame()).not.toContain(name);
    app.resize(120, 60); await app.flush();
    await waitFor(() => requested.includes("/resize/1100x1100bb.jpg"));
    await waitFor(() => !image.loading);
    expect(image.image?.width).toBe(2);
    expect(app.captureCharFrame()).toContain(name);
  });

  test("a slower smaller download cannot replace the sharper image after resizing", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let smallerFinished = false;
    const art = Bun.serve({ port: 0, async fetch(request) {
      if (new URL(request.url).pathname.includes("600x600")) { await pending; smallerFinished = true; }
      return new Response(png);
    } });
    cleanup.push(() => { release(); art.stop(true); });
    const app = await setup(60, 36);
    Object.defineProperty(app.renderer, "resolution", { get: () => ({ width: app.renderer.terminalWidth * 10, height: app.renderer.terminalHeight * 20 }) });
    app.model.playback.nowPlaying!.artwork = { url: `http://127.0.0.1:${art.port}/slow/{w}x{h}bb.{f}` };
    app.model.changed(); await app.flush();
    const listeners = app.renderer.listenerCount("resize");
    await click(app, "player-cover"); await app.flush();
    const image = app.renderer.root.findDescendantById("cover-view-image") as ImageRenderable;
    await waitFor(() => image.image?.width === 2);
    const small = image.source;
    app.resize(120, 60); await app.flush();
    await waitFor(() => image.source !== small && !image.loading);
    const sharp = image.source;
    release(); await waitFor(() => smallerFinished); await Bun.sleep(20); await app.flush();
    expect(image.source).toBe(sharp);
    expect(image.image?.width).toBe(2);
    const before = called(app, "toggle").length;
    app.mockInput.pressKey(" ");
    await waitFor(() => called(app, "toggle").length === before + 1);
    expect(app.renderer.root.findDescendantById("cover-view")).toBeDefined();
    await click(app, "cover-view-image"); await app.flush();
    expect(app.renderer.root.findDescendantById("cover-view")).toBeUndefined();
    expect(app.renderer.listenerCount("resize")).toBe(listeners);
  });

  test("clicking an album's cover fills the window with it at the window's pixel size, and Escape closes it", async () => {
    const requested: string[] = [];
    const art = Bun.serve({ port: 0, fetch: request => { requested.push(new URL(request.url).pathname); return new Response("", { status: 404 }); } });
    cleanup.push(() => art.stop(true));
    const app = await setup(120, 36, "albums");
    await click(app, "grid:tile:albums:0");
    await waitFor(() => app.model.detail?.id === "l.soma" && app.model.items.length === 3);
    app.model.detail!.artwork = `http://127.0.0.1:${art.port}/cover/{w}x{h}bb.{f}`;
    app.model.changed(); await app.flush();
    await click(app, "collection-cover"); await app.flush();
    let frame = app.captureCharFrame();
    expect(frame).toContain("Esc or click to close"); expect(frame).toContain("SOMA"); expect(frame).not.toContain("Search Apple Music");
    // The small cached cover first, then one sized to the window, rounded up to whole hundreds.
    await waitFor(() => requested.length >= 2);
    expect(requested).toContain("/cover/240x240bb.jpg");
    expect(requested.some(path => /^\/cover\/([6-9]|[1-3]\d)00x\d+bb\.jpg$/.test(path))).toBe(true);
    app.mockInput.pressEscape();
    await waitFor(() => !app.renderer.root.findDescendantById("cover-view")); await app.flush();
    frame = app.captureCharFrame();
    expect(frame).toContain("Search Apple Music"); expect(app.model.detail?.id).toBe("l.soma");
    app.mockInput.pressKey("c"); await app.flush();
    expect(app.captureCharFrame()).toContain("Esc or click to close");
    await click(app, "cover-view"); await app.flush();
    expect(app.captureCharFrame()).not.toContain("Esc or click to close");
  });
});

describe("artists", () => {
  test("an album's artist opens a page with top songs and every release shelf, and Escape returns", async () => {
    const app = await setup(120, 36, "albums");
    await click(app, "grid:tile:albums:0");
    await waitFor(() => app.model.detail?.id === "l.soma" && app.model.items.length === 3); await app.flush();
    await click(app, "collection-artist");
    await waitFor(() => app.model.display === "sections" && !app.model.loading); await app.flush();
    const frame = app.captureCharFrame();
    for (const text of ["Artist", "Skrillex", "Dance", "Top songs", "Top song 1", "Albums", "1 album", "1 single or EP"]) expect(frame).toContain(text);
    expect(app.ui.grid.shelves.map(shelf => shelf.title)).toEqual(["Albums", "Singles and EPs", "Appears on"]);
    expect(app.ui.grid.shelves.find(shelf => shelf.id === "singles")?.tiles[0].caption).toBe("CONTRABAND");
    // Shelves that do not fit scroll into view, each with its heading.
    app.ui.grid.move(0, 1); await app.flush();
    expect(app.captureCharFrame()).toContain("Singles and EPs");
    app.ui.grid.move(0, -1); await app.flush();
    expect(app.model.items).toHaveLength(6);
    expect(app.calls.some(call => call.path === "/v1/me/library/albums/l.soma/artists")).toBe(true);
    await click(app, "tracks:row:0");
    await waitFor(() => called(app, "play").length === 1);
    expect(started(app)).toMatchObject({ id: "t1", type: "songs" });
    app.mockInput.pressEscape(); await waitFor(() => app.model.detail?.id === "l.soma");
    expect(app.model.items).toHaveLength(3);
  });

  test("arrow keys move from top songs into the album shelves and back", async () => {
    const app = await setup(120, 36, "albums");
    app.ui.grid.select("l.soma"); app.mockInput.pressEnter();
    await waitFor(() => app.model.detail?.id === "l.soma" && !app.model.loading); await app.flush();
    await click(app, "collection-artist");
    await waitFor(() => app.model.display === "sections" && !app.model.loading); await app.flush();
    app.ui.grid.focus();
    app.mockInput.pressArrow("up"); expect(app.ui.tracks.focused).toBe(true);
    for (let row = 0; row < 6; row++) app.mockInput.pressArrow("down");
    expect(app.ui.grid.focused).toBe(true);
    expect(app.ui.grid.selected()?.media.id).toBe("a.soma");
    app.mockInput.pressArrow("down"); expect(app.ui.grid.selected()?.media.id).toBe("a.single");
    app.mockInput.pressEnter(); await waitFor(() => app.model.detail?.id === "a.single");
    app.mockInput.pressEscape(); await waitFor(() => app.model.display === "sections");
    expect(app.ui.grid.focused).toBe(true); expect(app.ui.grid.selected()?.media.id).toBe("a.single");
  });

  test("the player's artist name and the Artists section open artist pages", async () => {
    const app = await setup(120, 36);
    await click(app, "now-playing-artist");
    await waitFor(() => app.model.view === "artist:100" && !app.model.loading);
    expect(app.calls.some(call => call.path === "/v1/catalog/de/search")).toBe(true);
    await app.model.open("artists"); await app.flush();
    expect(app.captureCharFrame()).toContain("Skrillex");
    expect(app.model.items[0]).toMatchObject({ id: "100", type: "artists", genre: "Dance" });
    await click(app, "grid:tile:artists:0");
    await waitFor(() => app.model.view === "artist:100" && !app.model.loading);
    app.mockInput.pressEscape(); await waitFor(() => app.model.view === "artists");
  });

  test("an artist page fits the minimum terminal size", async () => {
    const app = await setup(48, 24);
    await app.model.openArtist({ id: "100", type: "artists", name: "Skrillex", artist: "", album: "", duration: 0 }); await app.flush();
    expect(app.captureCharFrame()).toContain("Top songs");
    expect(app.captureCharFrame()).toContain("50%");
  });
});

test("artwork templates request a fixed square JPEG", () => {
  expect(artworkUrl("https://example.test/a.jpg/{w}x{h}bb.{f}")).toBe("https://example.test/a.jpg/240x240bb.jpg");
  expect(artworkUrl("https://example.test/a.jpg/600x600bb.png")).toBe("https://example.test/a.jpg/240x240bb.jpg");
});
