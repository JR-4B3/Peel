import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { AppleMusic } from "../src/apple";
import { Cider } from "../src/cider";
import { Model } from "../src/model";
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
    for (const [id, path, key] of [["previous", "/playback/previous", "p"], ["next", "/playback/next", "n"], ["shuffle", "/playback/shuffle/toggle", "s"], ["repeat", "/playback/repeat/toggle", "r"]]) {
      const before = app.calls.filter(call => call.path === path).length;
      await click(app, id); app.mockInput.pressKey(key);
      await waitFor(() => app.calls.filter(call => call.path === path).length === before + 2);
    }
  });

  test("selecting a playlist track starts only that song and retains the collection order", async () => {
    const app = await setup(120, 36, "favourites");
    await click(app, "tracks:row:1");
    await waitFor(() => app.calls.some(call => call.path === "/queue/move"));
    expect(app.audible).toEqual(["i.selected"]);
    expect(app.calls.some(call => call.path === "/playback/play-collection")).toBe(false);
    expect(app.calls.find(call => call.path === "/queue/add-later")?.body).toEqual({ id: "p.favourites", type: "library-playlists" });
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 1, total: 3 });
  });

  test("a double-click activates its song once without playing the collection's first song", async () => {
    const app = await setup(120, 36, "favourites");
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
    const app = await setup(120, 36, "favourites");
    await Promise.all([app.model.activate(app.model.items[1]), app.model.activate(app.model.items[2])]);
    expect(app.audible).toEqual(["i.selected", "i.last"]);
    expect((await app.player.queue()).items.map(item => item.id)).toEqual(["i.soma", "i.selected", "i.last"]);
    expect(await app.player.queuePosition()).toEqual({ position: 2, total: 3 });
  });

  test("selecting the first track retains one copy of it in its collection", async () => {
    const app = await setup(120, 36, "favourites");
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
    // Songs form the list. Albums and artists are shelves of covers.
    expect(app.model.shelves.map(shelf => [shelf.title, shelf.items[0]?.id])).toEqual([["Albums", "456"], ["Artists", "100"]]);
    await click(app, "tracks:row:0");
    await waitFor(() => app.calls.some(call => call.path === "/playback/play-item"));
    expect(app.calls.find(call => call.path === "/playback/play-item")?.body).toEqual({ id: "123", type: "songs" });
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
    expect(app.calls.filter(call => call.path === "/audio/volume").at(-1)).toEqual({ path: "/audio/volume", method: "PATCH", body: { volume: 1 } });
  });

  test("layout editor changes the actual sidebar and saves preferences", async () => {
    const app = await setup();
    await click(app, "layout"); await app.flush();
    await click(app, "move-down"); await waitFor(() => app.model.entries()[0].id === "playlist:p.chill");
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

  test("an unauthorised Cider still shows the library, and playing reports the required connection", async () => {
    const setup = await createTestRenderer({ width: 90, height: 28 }); cleanup.push(() => setup.renderer.destroy());
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const model = new Model(api.library, new Cider(`http://127.0.0.1:${api.server.port}`, "wrong-token"));
    const ui = new PeelUI(setup.renderer, model); cleanup.push(() => ui.dispose());
    await model.start(); await setup.flush();
    expect(model.playlists.map(item => item.name)).toContain("Background Chill");
    expect(setup.captureCharFrame()).toContain("Stopped");
    await click(setup, "play-pause");
    await waitFor(() => model.status.includes("bun run connect"));
    expect(model.connected).toBe(false);
  });

  test("browsing loads while Cider starts, and the first song waits for Cider once", async () => {
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const model = new Model(api.library, api.player);
    let wakes = 0, open!: () => void;
    const ready = new Promise<void>(done => { open = done; });
    model.wake = async () => { wakes++; await ready; };
    // Cider has not opened its API yet.
    const snapshot = api.player.snapshot.bind(api.player);
    let up = false;
    api.player.snapshot = () => up ? snapshot() : Promise.reject(new Error("Cannot reach Cider."));
    await model.start();
    expect(model.playlists.length).toBe(2);
    expect(model.home.recent.length).toBeGreaterThan(0);
    expect(model.connected).toBe(false);
    expect(model.status).not.toContain("Cannot reach Cider");
    await model.open("songs");
    const first = model.activate(model.items[0]!), second = model.act("/playback/next");
    await Bun.sleep(20);
    expect(model.starting).toBe(true);
    expect(api.calls.some(call => call.path === "/playback/play-item")).toBe(false);
    up = true; open();
    await Promise.all([first, second]);
    expect(wakes).toBe(1);
    expect(model.connected).toBe(true);
    expect(api.calls.filter(call => call.path === "/playback/play-item" || call.path === "/playback/next").map(call => call.path)).toEqual(["/playback/play-item", "/playback/next"]);
  });
});

test("collection queue construction waits for the selected decoder to begin playback", async () => {
  const api = fixture({ waitForDecoder: true }); cleanup.push(() => api.server.stop(true));
  const items = await api.library.songs("p.favourites");
  const starting = api.player.playCollectionTrack({ id: "p.favourites", type: "library-playlists" }, items.items[1], 1);
  await waitFor(() => api.calls.some(call => call.path === "/playback") && api.playback.nowPlaying?.name === "Selected song");
  expect(api.playback.time.currentTime).toBe(0);
  expect(api.calls.some(call => call.path === "/queue/add-later")).toBe(false);
  api.beginPlayback();
  await starting;
  expect(api.audible).toEqual(["i.selected"]);
  expect(await api.player.queuePosition()).toEqual({ position: 1, total: 3 });
});

test("Apple Music renews a rejected developer token once and a rejected user token from Cider", async () => {
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
  await expect(rejected.playlists()).rejects.toThrow("bun run connect");
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
    expect(app.calls.some(call => call.path === "/v1/me/library/artists")).toBe(false);
    expect(app.model.home.recent.map(item => item.id)).toEqual(["a.soma", "pl.mix"]);
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
    await waitFor(() => app.calls.some(call => call.path === "/queue/move"));
    expect(app.calls.find(call => call.path === "/queue/add-later")?.body).toEqual({ id: "l.other", type: "library-albums" });
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
    expect(app.calls.some(call => call.path === "/playback/seek")).toBe(false);
    app.mockInput.pressArrow("right", { shift: true });
    await waitFor(() => app.calls.some(call => call.path === "/playback/seek"));
  });

  test("the heart favourites the playing song and confirms Cider's stored rating", async () => {
    const app = await setup();
    expect(app.captureCharFrame()).toContain(icon.heartOutline);
    await click(app, "favourite");
    await waitFor(() => app.model.status === "Added to Favourite Songs");
    expect(app.calls.find(call => call.path === "/library/now-playing/rating")).toMatchObject({ method: "PUT", body: { rating: 1 } });
    await app.flush(); expect(app.captureCharFrame()).toContain(icon.heart);
    app.mockInput.pressKey("f");
    await waitFor(() => app.model.status === "Removed from Favourite Songs");
    expect(app.calls.filter(call => call.path === "/library/now-playing/rating").at(-1)?.method).toBe("DELETE");
    expect(app.model.favourite).toBe(false);
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
    await waitFor(() => app.calls.some(call => call.path === "/playback/play-item"));
    expect(app.calls.find(call => call.path === "/playback/play-item")?.body).toEqual({ id: "t1", type: "songs" });
    app.mockInput.pressEscape(); await waitFor(() => app.model.detail?.id === "l.soma");
    expect(app.model.items).toHaveLength(3);
  });

  test("arrow keys move from top songs into the album shelves and back", async () => {
    const app = await setup(120, 36, "albums");
    app.ui.grid.select("l.soma"); app.mockInput.pressKey("a");
    await waitFor(() => app.model.display === "sections" && !app.model.loading); await app.flush();
    expect(app.ui.grid.focused).toBe(true);
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
