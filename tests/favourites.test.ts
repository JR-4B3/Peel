import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AppleMusic } from "../src/apple";
import type { Media } from "../src/types";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

test("a library song's favourite uses its library rating even when it has a catalog ID", async () => {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    calls.push(url.pathname);
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    const loved = url.pathname.endsWith("/library-songs") ? ["i.creep"] : ["catalog.other", "catalog.only"];
    return Response.json({ data: ids.filter(id => loved.includes(id)).map(id => ({ id, attributes: { value: 1 } })) });
  } });
  cleanup.push(() => server.stop(true));
  const library = new AppleMusic("fixture-user", { base: server.url.origin, developerToken: async () => "fixture-developer", favouriteVersions: false });
  const song = (id: string, catalogId?: string): Media => ({ id, catalogId, type: "songs", name: id, artist: "Artist", album: "Album", duration: 100 });
  const loved = await library.ratings([
    song("i.creep", "catalog.creep"),
    song("i.other", "catalog.other"),
    song("catalog.only", "catalog.only"),
    song("i.upload"),
  ]);
  expect([...loved]).toEqual(["i.creep", "catalog.only"]);
  expect(calls.sort()).toEqual(["/v1/me/ratings/library-songs", "/v1/me/ratings/songs"]);
});

// One recording under several IDs (#108).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Versions } from "../src/versions";
import { Model } from "../src/model";
import { stopped, type Library, type Page, type Playback, type Player } from "../src/types";

const track = (id: string, fields: Partial<Media> = {}): Media => ({ id, type: "songs", name: "Song", artist: "Artist", album: "Album", duration: 180, ...fields });

test("versions of one recording match by ID, by ISRC, or by title, a shared artist and length", () => {
  const versions = new Versions([
    track("i.money", { catalogId: "111", isrc: "QM0000000001", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 }),
    // Apple no longer serves this one's catalog song, so it has no ISRC.
    track("i.dark", { catalogId: "222", name: "Dark Loop", artist: "OG Keemo & GERDA", duration: 144 }),
    track("i.benzi", { catalogId: "333", name: "Benzi Box (feat. Cee Lo Green)", artist: "DANGERDOOM", duration: 180 }),
    track("i.know", { name: "I Don't Know", artist: "Slum Village", duration: 145 }),
  ]);
  // The library song itself, and its catalog song.
  expect(versions.has(track("i.money"))).toBe(true);
  expect(versions.has(track("111"))).toBe(true);
  // A re-released catalog song with a new ID and the same ISRC.
  expect(versions.has(track("999", { isrc: "QM0000000001", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 }))).toBe(true);
  // The same song credited in another order, a group credited with its members, the guests spelled
  // another way, and a typographic apostrophe.
  expect(versions.has(track("998", { name: "Dark Loop", artist: "GERDA & OG Keemo", duration: 144 }))).toBe(true);
  expect(versions.has(track("997", { name: "Benzi Box (feat. CeeLo Green)", artist: "DANGERDOOM, MF DOOM & Danger Mouse", duration: 181 }))).toBe(true);
  expect(versions.has(track("996", { name: "I Don’t Know", artist: "Slum Village", duration: 145 }))).toBe(true);
  // Another length is another version, such as a live take or an extended mix.
  expect(versions.has(track("995", { name: "Dark Loop", artist: "OG Keemo", duration: 158 }))).toBe(false);
  // The same title by other artists is another song.
  expect(versions.has(track("994", { name: "Dark Loop", artist: "Someone Else", duration: 144 }))).toBe(false);
  // Without a length nothing matches by title.
  expect(versions.has(track("993", { name: "Dark Loop", artist: "OG Keemo", duration: 0 }))).toBe(false);
  // A different ISRC with nothing else in common.
  expect(versions.has(track("992", { isrc: "QM0000000002", name: "Other", duration: 135 }))).toBe(false);
  expect(versions.of(track("998", { name: "Dark Loop", artist: "GERDA", duration: 145 })).map(song => song.id)).toEqual(["i.dark"]);
});

// A fake Apple: Favourite Songs holds two library songs. "i.money" links to catalog song 111,
// which Apple re-released as 999 with the same ISRC. "i.dark" links to catalog song 222, which
// Apple no longer serves. Only the library songs carry a favourite mark.
function apple(options: { failIsrcs?: boolean } = {}) {
  const calls: string[] = [];
  const marks = new Set(["i.money", "i.dark"]);
  const favourites = [
    { id: "i.money", type: "library-songs", attributes: { name: "$ (Money)", artistName: "JPEGMAFIA", durationInMillis: 135000, playParams: { catalogId: "111" } } },
    { id: "i.dark", type: "library-songs", attributes: { name: "Dark Loop", artistName: "OG Keemo & GERDA", durationInMillis: 144000, playParams: { catalogId: "222" } } },
  ];
  // 888 is a separate master of "$ (Money)", such as a remaster: same title, artist and length,
  // another ISRC.
  const catalog: Record<string, string> = { "111": "QM0000000001", "999": "QM0000000001", "500": "QM0000000500", "888": "QM0000000888" };
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    calls.push(`${request.method} ${path}`);
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    if (path === "/v1/me/library/playlists") return Response.json({ data: [{ id: "p.fav", type: "library-playlists", attributes: { name: "Favourite Songs", tags: ["favorited"] } }] });
    if (path === "/v1/me/library/playlists/p.fav/tracks") return Response.json(Number(url.searchParams.get("offset")) ? { data: [] } : { data: favourites });
    if (path === "/v1/catalog/de/songs" && options.failIsrcs && !ids.every(id => ["111", "222"].includes(id))) return new Response("unavailable", { status: 503 });
    if (path === "/v1/catalog/de/songs") return Response.json({ data: ids.filter(id => catalog[id]).map(id => ({ id, type: "songs", attributes: { isrc: catalog[id] } })) });
    if (path === "/v1/me/storefront") return Response.json({ data: [{ id: "de" }] });
    if (request.method === "DELETE") { marks.delete(path.split("/").at(-1)!); return new Response(null, { status: 204 }); }
    if (path.startsWith("/v1/me/ratings/")) return Response.json({ data: ids.filter(id => marks.has(id)).map(id => ({ id, attributes: { value: 1 } })) });
    return Response.json({ data: [] });
  } });
  cleanup.push(() => server.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "peel-favourites-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const library = new AppleMusic("fixture-user", { base: server.url.origin, developerToken: async () => "fixture-developer", storefront: "de", cacheDir: dir });
  return { library, calls, marks, favourites, server, dir };
}

test("a song is a favourite when another version of it is, also under a catalog ID Apple re-released", async () => {
  const { library, calls } = apple();
  const loved = await library.ratings([
    // Apple's catalog copy of Favourite Songs lists the re-released catalog song, which has no mark.
    track("999", { catalogId: "999", isrc: "QM0000000001", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 }),
    // The player reports a catalog ID without an ISRC, so Peel reads it.
    track("999b", { catalogId: "999", name: "Other title", duration: 1 }),
    // The library song's catalog song is gone, so title, artist and length decide.
    track("777", { catalogId: "777", name: "Dark Loop", artist: "GERDA & OG Keemo", duration: 144 }),
    track("500", { catalogId: "500", name: "Not a favourite", duration: 200 }),
  ]);
  expect([...loved].sort()).toEqual(["777", "999", "999b"]);
  // A second question within ten minutes reads Favourite Songs from memory.
  const reads = calls.filter(call => call.endsWith("/p.fav/tracks")).length;
  await library.ratings([track("500", { catalogId: "500" })]);
  expect(calls.filter(call => call.endsWith("/p.fav/tracks")).length).toBe(reads);
});

test("removing a favourite removes the mark from every version, and Favourite Songs read late does not bring it back", async () => {
  const { library, calls, marks } = apple();
  const playing = track("999", { catalogId: "999", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  expect(await library.ratings([playing])).toEqual(new Set(["999"]));
  await library.forgetFavourite(playing);
  expect(calls).toContain("DELETE /v1/me/ratings/library-songs/i.money");
  expect(calls).toContain("DELETE /v1/me/ratings/songs/999");
  expect(calls).toContain("DELETE /v1/me/ratings/songs/111");
  // The other favourite keeps its mark.
  expect([...marks]).toEqual(["i.dark"]);
  // Apple's Favourite Songs still lists the song for a while, so it stays out.
  expect(await library.ratings([playing])).toEqual(new Set());
});

test("a song plays under an ID without a mark: the player says no, Peel's lookup says yes, and the heart stays", async () => {
  const empty = async (): Promise<Page> => ({ items: [], more: false });
  let asked: Media[] = [];
  const library = {
    recent: async () => [], releases: async () => [], playlists: async () => [], search: async () => [],
    songs: empty, playlist: empty, album: empty, albums: empty, artists: empty,
    ratings: async (items: Media[]) => { asked = items; return new Set(items.map(item => item.id)); },
    albumFavourite: async () => false, favouriteAlbum: async () => {},
    forgotten: [] as Media[], changes: 0,
    forgetFavourite: async function (item: Media) { this.forgotten.push(item); },
    favouritesChanged: function () { this.changes++; },
  };
  let mark = 0;
  const state: Playback = { ...structuredClone(stopped), state: "playing", time: { currentTime: 10, duration: 135 }, nowPlaying: { name: "$ (Money)", artistName: "JPEGMAFIA", inFavorites: false, playParams: { id: "999", catalogId: "999" } } };
  const player: any = {
    snapshot: async () => ({ ...structuredClone(state), nowPlaying: { ...state.nowPlaying, inFavorites: mark === 1 } }),
    queue: empty, queuePosition: async () => ({ position: 0, total: 1 }),
    rating: async () => mark, playItem: async () => {}, playCollectionTrack: async () => {}, enqueue: async () => {},
    command: async (path: string, _body: unknown, method: string) => { if (path === "/library/now-playing/rating") mark = method === "DELETE" ? 0 : 1; },
  };
  const model = new Model(library as unknown as Library, player);
  model.items = [track("999", { catalogId: "999", loved: true })];
  await model.refresh();
  // Until Peel's lookup answers, the player's "no" does not take the row's heart.
  expect(model.items[0]!.loved).toBe(true);
  for (let count = 0; count < 50 && model.favourite !== true; count++) await Bun.sleep(10);
  expect(model.favourite).toBe(true);
  expect(asked[0]).toMatchObject({ id: "999", catalogId: "999", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  await model.refresh();
  expect(model.items[0]!.loved).toBe(true);
  // Removing it removes every version's mark, not only the one the player plays.
  await model.toggleFavourite();
  expect(model.favourite).toBe(false);
  expect(library.forgotten.map(item => item.id)).toEqual(["999"]);
  expect(library.changes).toBe(1);
  expect(model.status).toBe("Removed from Favourite Songs");
});

test("after a start the first answer comes from the copy saved last time, and the fresh read replaces it", async () => {
  const first = apple();
  expect(await first.library.ratings([track("999", { catalogId: "999", isrc: "QM0000000001" })])).toEqual(new Set(["999"]));
  // A new start of Peel against the same Apple, whose Favourite Songs read is slow.
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/p.fav/tracks")) await slow;
    return first.server.fetch(request);
  } });
  cleanup.push(() => { release(); server.stop(true); });
  // The saved copy belongs to the Apple it was read from, so a copy from another base is ignored.
  const other = new AppleMusic("fixture-user", { base: server.url.origin, developerToken: async () => "fixture-developer", storefront: "de", cacheDir: first.dir });
  const answer = await Promise.race([other.ratings([track("999", { catalogId: "999", isrc: "QM0000000001" })]), Bun.sleep(300).then(() => "waiting")]);
  expect(answer).toBe("waiting");
  release();
  const again = new AppleMusic("fixture-user", { base: first.server.url.origin, developerToken: async () => "fixture-developer", storefront: "de", cacheDir: first.dir });
  const reads = first.calls.filter(call => call.endsWith("/p.fav/tracks")).length;
  const started = Date.now();
  expect(await again.ratings([track("999", { catalogId: "999", isrc: "QM0000000001" })])).toEqual(new Set(["999"]));
  expect(Date.now() - started).toBeLessThan(1000);
  // The fresh read still runs in the background.
  for (let count = 0; count < 50 && first.calls.filter(call => call.endsWith("/p.fav/tracks")).length === reads; count++) await Bun.sleep(10);
  expect(first.calls.filter(call => call.endsWith("/p.fav/tracks")).length).toBeGreaterThan(reads);
});

// Separate masters (#120): a remaster has its own ISRC, so it is another recording although its
// title, artist and length are the same.

test("two known ISRCs that differ never match by title, artist and length", () => {
  const versions = new Versions([
    track("i.money", { catalogId: "111", isrc: "QM0000000001", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 }),
    // Apple no longer serves this one's catalog song, so it has no ISRC.
    track("i.dark", { catalogId: "222", name: "Dark Loop", artist: "OG Keemo & GERDA", duration: 144 }),
  ]);
  const remaster = track("888", { catalogId: "888", isrc: "QM0000000888", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  expect(versions.has(remaster)).toBe(false);
  expect(versions.of(remaster)).toEqual([]);
  // A song whose ISRC is unknown still matches a favourite by title, artist and length, and so does
  // a song with an ISRC matching a favourite whose catalog song is gone.
  expect(versions.has(track("887", { name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 }))).toBe(true);
  expect(versions.of(track("887", { name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 })).map(song => song.id)).toEqual(["i.money"]);
  expect(versions.has(track("886", { isrc: "QM0000000886", name: "Dark Loop", artist: "GERDA", duration: 144 }))).toBe(true);
  // The same ID matches whatever the ISRCs say.
  expect(versions.has(track("111", { isrc: "QM0000000888" }))).toBe(true);
});

test("a separate master is not a favourite and removing its favourite keeps the original's marks", async () => {
  const { library, calls, marks } = apple();
  // The player reports the catalog ID without an ISRC, so Peel reads it before comparing titles.
  const remaster = track("888", { catalogId: "888", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  expect(await library.ratings([remaster])).toEqual(new Set());
  expect(calls).toContain("GET /v1/catalog/de/songs");
  await library.forgetFavourite(remaster);
  expect(calls.filter(call => call.startsWith("DELETE"))).toEqual(["DELETE /v1/me/ratings/songs/888"]);
  expect([...marks].sort()).toEqual(["i.dark", "i.money"]);
  // The original stays a favourite.
  expect(await library.ratings([track("999", { catalogId: "999", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 })])).toEqual(new Set(["999"]));
});

test("a song whose ISRC cannot be read matches by ID only, and removing its favourite removes nothing", async () => {
  const { library, calls, marks } = apple({ failIsrcs: true });
  const unread = track("888", { catalogId: "888", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  expect(await library.ratings([unread, track("111", { catalogId: "111" })])).toEqual(new Set(["111"]));
  await expect(library.forgetFavourite(unread)).rejects.toThrow("ISRC");
  expect(calls.filter(call => call.startsWith("DELETE"))).toEqual([]);
  expect([...marks].sort()).toEqual(["i.dark", "i.money"]);
});

test("Favourite Songs read while an ISRC read fails is not used, and is read again with the next question", async () => {
  let fail = true;
  const favourite = { id: "i.money", type: "library-songs", attributes: { name: "$ (Money)", artistName: "JPEGMAFIA", durationInMillis: 135000, playParams: { catalogId: "111" } } };
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/v1/me/library/playlists") return Response.json({ data: [{ id: "p.fav", type: "library-playlists", attributes: { name: "Favourite Songs", tags: ["favorited"] } }] });
    if (path === "/v1/me/library/playlists/p.fav/tracks") return Response.json({ data: Number(url.searchParams.get("offset")) ? [] : [favourite] });
    if (path === "/v1/catalog/de/songs") {
      if (fail) return new Response("unavailable", { status: 503 });
      const isrcs: Record<string, string> = { "111": "QM0000000001", "888": "QM0000000888" };
      return Response.json({ data: (url.searchParams.get("ids") ?? "").split(",").map(id => ({ id, attributes: { isrc: isrcs[id] } })) });
    }
    return Response.json({ data: [] });
  } });
  cleanup.push(() => server.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "peel-favourites-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const library = new AppleMusic("fixture-user", { base: server.url.origin, developerToken: async () => "fixture-developer", storefront: "de", cacheDir: dir });
  // The favourite's ISRC is unknown, so the remaster would match it by title.
  const remaster = track("888", { catalogId: "888", isrc: "QM0000000888", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  expect(await library.ratings([remaster])).toEqual(new Set());
  fail = false;
  expect(await library.ratings([remaster])).toEqual(new Set());
  expect(await library.ratings([track("999", { isrc: "QM0000000001" })])).toEqual(new Set(["999"]));
});

// A new start of Peel against the fake Apple, whose Favourite Songs read waits until released, so
// answers come from the copy saved in dir. songs replaces the songs in that copy first.
function restart(first: ReturnType<typeof apple>, songs?: unknown[]) {
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/p.fav/tracks")) await slow;
    return first.server.fetch(request);
  } });
  cleanup.unshift(() => { release(); server.stop(true); });
  const file = join(first.dir, "favourite-songs.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ base: server.url.origin, songs: songs ?? saved.songs }));
  const library = new AppleMusic("fixture-user", { base: server.url.origin, developerToken: async () => "fixture-developer", storefront: "de", cacheDir: first.dir });
  return { library, release };
}

// Older versions of Peel saved a favourite without its ISRC when the ISRC read failed.
const withoutIsrcs = [
  { id: "i.money", type: "library-songs", name: "$ (Money)", artist: "JPEGMAFIA", album: "", duration: 135, catalogId: "111" },
  { id: "i.dark", type: "library-songs", name: "Dark Loop", artist: "OG Keemo & GERDA", album: "", duration: 144, catalogId: "222" },
];

test("a saved favourite without an ISRC matches by ID only, so a separate master is not a favourite after a start", async () => {
  const first = apple();
  await first.library.ratings([]);
  const { library, release } = restart(first, withoutIsrcs);
  const remaster = track("888", { catalogId: "888", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 });
  expect(await library.ratings([remaster, track("111", { catalogId: "111" })])).toEqual(new Set(["111"]));
  // The fresh read knows every ISRC and replaces the copy.
  release();
  for (let count = 0; count < 50 && !(await library.ratings([track("999", { catalogId: "999" })])).size; count++) await Bun.sleep(10);
  expect(await library.ratings([remaster])).toEqual(new Set());
  expect(await library.ratings([track("777", { catalogId: "777", name: "Dark Loop", artist: "GERDA", duration: 144 })])).toEqual(new Set(["777"]));
});

test("removing a separate master's favourite first thing after a start keeps the marks of a saved favourite without an ISRC", async () => {
  const first = apple();
  await first.library.ratings([]);
  const { library } = restart(first, withoutIsrcs);
  await library.forgetFavourite(track("888", { catalogId: "888", name: "$ (Money)", artist: "JPEGMAFIA", duration: 135 }));
  expect(first.calls.filter(call => call.startsWith("DELETE"))).toEqual(["DELETE /v1/me/ratings/songs/888"]);
  expect([...first.marks].sort()).toEqual(["i.dark", "i.money"]);
});

test("the saved copy keeps a favourite whose catalog song is gone matching by title after a start", async () => {
  const first = apple();
  await first.library.ratings([track("500", { catalogId: "500" })]);
  const saved = JSON.parse(readFileSync(join(first.dir, "favourite-songs.json"), "utf8"));
  expect(saved.songs.map((song: { isrc?: string }) => song.isrc)).toEqual(["QM0000000001", ""]);
  const { library } = restart(first);
  const reads = first.calls.filter(call => call.startsWith("GET /v1/catalog/de/songs")).length;
  expect(await library.ratings([track("777", { catalogId: "777", isrc: "QM0000000777", name: "Dark Loop", artist: "GERDA", duration: 144 })])).toEqual(new Set(["777"]));
  // Its ISRC is not read again.
  expect(first.calls.filter(call => call.startsWith("GET /v1/catalog/de/songs")).length).toBe(reads);
});

// The playing song's heart after a change in another app or Peel window (#121).

function playing(answers: { loved: boolean; delay?: Promise<void> }[] | (() => boolean)) {
  const empty = async (): Promise<Page> => ({ items: [], more: false });
  const library = {
    recent: async () => [], releases: async () => [], playlists: async () => [], search: async () => [],
    songs: empty, playlist: empty, album: empty, albums: empty, artists: empty,
    asks: 0, changes: 0,
    ratings: async function (items: Media[]) {
      this.asks++;
      if (typeof answers === "function") return new Set(answers() ? items.map(item => item.id) : []);
      const answer = answers.shift()!;
      await answer.delay;
      return new Set(answer.loved ? items.map(item => item.id) : []);
    },
    albumFavourite: async () => false, favouriteAlbum: async () => {},
    forgetFavourite: async () => {},
    favouritesChanged: function () { this.changes++; },
  };
  const player = {
    mark: 0,
    snapshot: async function () {
      return { ...structuredClone(stopped), state: "playing", time: { currentTime: 10, duration: 135 }, nowPlaying: { name: "$ (Money)", artistName: "JPEGMAFIA", inFavorites: this.mark === 1, playParams: { id: "999", catalogId: "999" } } } as Playback;
    },
    queue: empty, queuePosition: async () => ({ position: 0, total: 1 }),
    rating: async function () { return this.mark; }, playItem: async () => {}, playCollectionTrack: async () => {}, enqueue: async () => {},
    command: async function (path: string, _body: unknown, method: string) { if (path === "/library/now-playing/rating") this.mark = method === "DELETE" ? 0 : 1; },
  };
  const model = new Model(library as unknown as Library, player as unknown as Player);
  const settle = async () => { for (let count = 0; count < 20; count++) await Bun.sleep(1); };
  return { library, player, model, settle };
}

test("a favourite removed elsewhere loses its heart once Peel's lookup agrees", async () => {
  let loved = true;
  const { library, player, model, settle } = playing(() => loved);
  player.mark = 1;
  await model.refresh(); await settle();
  expect(model.favourite).toBe(true);
  expect(library.asks).toBe(1);
  // Another app removes the favourite.
  loved = false; player.mark = 0;
  await model.refresh(); await settle();
  expect(model.favourite).toBe(false);
  // The lookup read Favourite Songs afresh.
  expect(library.asks).toBe(2);
  expect(library.changes).toBe(1);
  // The next press adds the favourite.
  await model.toggleFavourite();
  expect(player.mark).toBe(1);
  expect(model.favourite).toBe(true);
  // The player's new mark is this Peel's own change, so it starts no lookup.
  await model.refresh(); await settle();
  expect(model.favourite).toBe(true);
  expect(library.asks).toBe(2);
});

test("the player's no after a change elsewhere keeps a heart another version still holds, and Peel reads Favourite Songs again until they agree", async () => {
  let loved = true;
  const { library, player, model, settle } = playing(() => loved);
  player.mark = 1;
  await model.refresh(); await settle();
  // Another app removes the mark on the playing ID. The library song in Favourite Songs keeps one.
  player.mark = 0;
  await model.refresh(); await settle();
  expect(model.favourite).toBe(true);
  expect(library.changes).toBe(1);
  // The next lookup a minute later reads Favourite Songs afresh again, since it may have been late.
  const start = Date.now();
  try {
    setSystemTime(new Date(start + 61_000));
    await model.refresh(); await settle();
    expect(library.asks).toBe(3);
    expect(library.changes).toBe(2);
    expect(model.favourite).toBe(true);
    // Apple's Favourite Songs catches up with the removal of the last mark.
    loved = false;
    setSystemTime(new Date(start + 122_000));
    await model.refresh(); await settle();
    expect(model.favourite).toBe(false);
    expect(library.changes).toBe(3);
    // Once the answers agree, later lookups use the library's copy.
    setSystemTime(new Date(start + 183_000));
    await model.refresh(); await settle();
    expect(library.asks).toBe(5);
    expect(library.changes).toBe(3);
  } finally { setSystemTime(); }
});

test("a favourite changed elsewhere on another version shows within a minute while the song plays", async () => {
  let loved = false;
  const { library, model, settle } = playing(() => loved);
  await model.refresh(); await settle();
  expect(model.favourite).toBe(false);
  loved = true;
  // Refreshes within a minute do not ask again.
  await model.refresh(); await settle();
  expect(library.asks).toBe(1);
  const start = Date.now();
  try {
    setSystemTime(new Date(start + 61_000));
    await model.refresh(); await settle();
    expect(library.asks).toBe(2);
    expect(model.favourite).toBe(true);
    // Without a change in the player's mark, the library's copy of Favourite Songs is enough.
    expect(library.changes).toBe(0);
  } finally { setSystemTime(); }
});

test("a lookup that started before a favourite changed here does not undo the change", async () => {
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  const { player, model, settle } = playing([{ loved: true }, { loved: true, delay }, { loved: false }]);
  player.mark = 1;
  await model.refresh(); await settle();
  expect(model.favourite).toBe(true);
  const start = Date.now();
  try {
    // A minute later a lookup starts and answers late with the mark from before the removal.
    setSystemTime(new Date(start + 61_000));
    await model.refresh(); await settle();
    await model.toggleFavourite();
    expect(model.favourite).toBe(false);
    // The player reports the removal, which is this Peel's own change and needs no new lookup.
    await model.refresh(); await settle();
    release(); await settle();
    expect(model.favourite).toBe(false);
  } finally { setSystemTime(); }
});

test("an ISRC read while removing a separate master's favourite does not let a saved favourite without one match by title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peel-favourites-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const deletes: string[] = [];
  const original = { id: "i.original", type: "library-songs", name: "Song", artist: "Artist", album: "", duration: 180, catalogId: "111" };
  let library!: AppleMusic;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === "DELETE") { deletes.push(path); return new Response(null, { status: 204 }); }
    if (path.endsWith("/playlists")) return Response.json({ data: [{ id: "p.fav", type: "library-playlists", attributes: { tags: ["favorited"] } }] });
    if (path.endsWith("/tracks")) {
      await gate;
      return Response.json({ data: Number(url.searchParams.get("offset")) ? [] : [{ id: original.id, type: original.type, attributes: { name: original.name, artistName: original.artist, durationInMillis: 180000, playParams: { catalogId: "111" } } }] });
    }
    if (path === "/v1/catalog/de/songs") {
      const id = url.searchParams.get("ids")!;
      // The fresh read of Favourite Songs learns the original's ISRC while the remaster's is read.
      if (id === "888") { release(); while (!(library as any).isrcs.has("111")) await Bun.sleep(1); }
      return Response.json({ data: [{ id, attributes: { isrc: id === "111" ? "ORIGINAL" : "REMASTER" } }] });
    }
    return Response.json({ data: [] });
  } });
  cleanup.push(() => { release(); server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  library = new AppleMusic("fixture", { base: server.url.origin, storefront: "de", cacheDir: dir, developerToken: async () => "fixture" });
  writeFileSync(join(dir, "favourite-songs.json"), JSON.stringify({ base: server.url.origin, songs: [original] }));
  await library.forgetFavourite({ ...original, id: "888", catalogId: "888", type: "songs" });
  expect(deletes).toEqual(["/v1/me/ratings/songs/888"]);
});
