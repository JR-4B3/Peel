// Switching back to a list shows its songs at once, then replaces them with Apple's newer answer.
import { expect, test } from "bun:test";
import { Model } from "../src/model";
import type { Library, Media, Page } from "../src/types";

const song = (id: string): Media => ({ id, catalogId: id, type: "songs", name: id, artist: "Artist", album: "Album", duration: 100 });
const empty = async (): Promise<Page> => ({ items: [], more: false });

function setup() {
  const library = {
    recent: async () => [], releases: async () => [], playlists: async () => [], search: async () => [],
    songs: empty, playlist: empty, album: empty, albums: empty, artists: empty,
    artistId: async () => "artist", artist: async () => ({ artist: { ...song("artist"), type: "artists" }, top: [], shelves: [] }),
    ratings: async () => new Set<string>(), albumFavourite: async () => false, favouriteAlbum: async () => {},
  } as unknown as Library & { songs: (id?: string, offset?: number) => Promise<Page> };
  return { model: new Model(library, {} as never), library };
}

const ids = (model: Model) => model.items.map(item => item.id);

test("a list opened before shows its songs while Apple is asked again", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1"), song("2")], more: false });
  await model.open("songs");
  await model.open("albums");

  let answer!: (page: Page) => void;
  library.songs = () => new Promise(resolve => { answer = resolve; });
  const opening = model.open("songs");
  // The old songs show at once. Nothing on screen says the list is loading from scratch.
  expect(ids(model)).toEqual(["1", "2"]);

  answer({ items: [song("1"), song("2"), song("3")], more: false });
  await opening;
  expect({ items: ids(model), loading: model.loading }).toEqual({ items: ["1", "2", "3"], loading: false });
});

test("a refreshed list shows earlier hearts until Apple answers again", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1"), song("2")], more: false });
  library.ratings = async () => new Set(["1"]);
  await model.open("songs"); await Bun.sleep(0);
  await model.open("albums");

  const asked: string[][] = [];
  let answer!: (loved: Set<string>) => void;
  library.songs = async () => ({ items: [song("1"), song("2"), song("3")], more: false });
  library.ratings = songs => { asked.push(songs.map(item => item.id)); return new Promise(resolve => { answer = resolve; }); };
  await model.open("songs");
  const marks = () => model.items.map(item => [item.id, item.loved]);
  expect(marks()).toEqual([["1", true], ["2", false], ["3", undefined]]);
  // Every song is asked again, since a favourite can change on another device.
  expect(asked).toEqual([["1", "2", "3"]]);
  answer(new Set(["2"])); await Bun.sleep(0);
  expect(marks()).toEqual([["1", false], ["2", true], ["3", false]]);
});

test("a song listed twice stays two entries after a refresh", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1"), song("2"), song("1")], more: false });
  await model.open("songs");
  await model.open("albums");
  await model.open("songs");
  expect(model.items[0]).not.toBe(model.items[2]);
  expect(model.items.indexOf(model.items[2]!)).toBe(2);
});

test("an emptied list does not show its old songs on the next visit", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1")], more: false });
  await model.open("songs");
  await model.open("albums");
  library.songs = async () => ({ items: [], more: false });
  await model.open("songs");
  await model.open("albums");
  library.songs = () => new Promise(() => {});
  void model.open("songs");
  expect(model.items).toEqual([]);
});

test("going back to a list whose refresh was interrupted asks Apple again", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1")], more: false });
  await model.open("songs");
  await model.open("albums");

  let asked = 0;
  library.songs = async () => { asked++; return asked === 1 ? new Promise(() => {}) : { items: [song("1"), song("2")], more: false }; };
  void model.open("songs");
  await model.openCollection({ ...song("a"), type: "library-albums" });
  await model.back(); await Bun.sleep(0);
  expect({ asked, items: ids(model), loading: model.loading }).toEqual({ asked: 2, items: ["1", "2"], loading: false });
});

test("a long list keeps only its first songs for the next visit", async () => {
  const { model, library } = setup();
  const page = (offset: number): Page => ({ items: Array.from({ length: 100 }, (_, index) => song(String(offset + index))), more: offset < 900 });
  library.songs = async (_id, offset = 0) => page(offset);
  await model.open("songs");
  await model.load(true, Infinity);
  expect(model.items.length).toBe(1000);
  await model.open("albums");

  const offsets: number[] = [];
  library.songs = async (_id, offset = 0) => { offsets.push(offset); return page(offset); };
  await model.open("songs");
  expect({ count: model.items.length, more: model.more, offsets }).toEqual({ count: 500, more: true, offsets: [0, 100, 200, 300, 400] });
});

test("a list left halfway through loading continues from the songs it had", async () => {
  const { model, library } = setup();
  const page = (offset: number): Page => ({ items: Array.from({ length: 100 }, (_, index) => song(String(offset + index))), more: offset < 900 });
  let stall = false;
  library.songs = async (_id, offset = 0) => { if (stall && offset) await new Promise(() => {}); return page(offset); };
  stall = true;
  void model.open("songs"); await Bun.sleep(0);
  expect(model.items.length).toBe(100);
  await model.open("albums");

  stall = false;
  const opening = model.open("songs");
  expect(model.items.length).toBe(100);
  await opening;
  // The refresh loads up to the usual background limit.
  expect({ count: model.items.length, more: model.more }).toEqual({ count: 500, more: true });
});

test("a failed refresh keeps the shown list", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1")], more: false });
  await model.open("songs");
  await model.open("albums");
  library.songs = async () => { throw new Error("Apple Music did not answer."); };
  await model.open("songs");
  expect({ items: ids(model), loading: model.loading, status: model.status }).toEqual({ items: ["1"], loading: false, status: "Apple Music did not answer." });
});

test("the queue is always read again", async () => {
  const { model } = setup();
  const reads: number[] = [];
  Object.assign(model, { connected: true });
  Object.assign(model.player as object, { queue: async (offset: number) => { reads.push(offset); return { items: reads.length > 1 ? [song("b")] : [song("a")], more: false }; } });
  await model.open("queue");
  await model.open("albums");
  const opening = model.open("queue");
  expect(model.items).toEqual([]);
  await opening;
  expect(ids(model)).toEqual(["b"]);
});

test("the sidebar's lists are read ahead, so even a first visit shows songs at once", async () => {
  const { model, library } = setup();
  const asked: string[] = [];
  const favourite = { ...song("p.fav"), type: "library-playlists", favourite: true };
  // Many playlists come before the library's own lists in the sidebar.
  library.playlists = async () => [favourite, ...Array.from({ length: 20 }, (_, index) => ({ ...song(`p.${index}`), type: "library-playlists" }))];
  library.songs = async (id, offset = 0) => { asked.push(`${id ?? "all"}@${offset}`); return { items: [song(id ?? "all")], more: false }; };
  library.albums = async () => ({ items: [{ ...song("album"), type: "library-albums" }], more: false });
  await (model as unknown as { loadNavigation(): Promise<void> }).loadNavigation();
  await Bun.sleep(10);
  // Only first pages, of at most twelve lists, the library's own first. Nothing for the queue or settings.
  expect(asked).toContain("all@0");
  expect(asked).toContain("p.fav@0");
  expect(asked.every(call => call.endsWith("@0"))).toBe(true);
  expect(asked.length).toBe(12 - 2);

  library.songs = () => new Promise(() => {});
  void model.open("favourites");
  expect(ids(model)).toEqual(["p.fav"]);
  void model.open("albums");
  expect(ids(model)).toEqual(["album"]);
});

test("a read ahead list grows page by page once the new answer covers it", async () => {
  const { model, library } = setup();
  const page = (offset: number): Page => ({ items: Array.from({ length: 100 }, (_, index) => song(String(offset + index))), more: offset < 900 });
  library.songs = async () => page(0);
  await (model as unknown as { loadNavigation(): Promise<void> }).loadNavigation();
  await Bun.sleep(10);
  const first = model["lists"].get("songs")!.items;

  const answers = new Map<number, (page: Page) => void>();
  library.songs = (_id, offset = 0) => new Promise(resolve => answers.set(offset, resolve));
  const opening = model.open("songs");
  expect(model.items).toBe(first);
  answers.get(0)!(page(0)); await Bun.sleep(0);
  // The new first page covers the read ahead one, so it shows and the next pages follow.
  expect({ count: model.items.length, loading: model.loading }).toEqual({ count: 100, loading: true });
  expect(model.items).not.toBe(first);
  for (const offset of [100, 200, 300, 400]) answers.get(offset)!(page(offset));
  await opening;
  expect({ count: model.items.length, loading: model.loading }).toEqual({ count: 500, loading: false });
});

test("going back to a long list that was loading keeps the songs it had", async () => {
  const { model, library } = setup();
  const page = (offset: number): Page => ({ items: Array.from({ length: 100 }, (_, index) => song(String(offset + index))), more: offset < 1900 });
  library.songs = async (_id, offset = 0) => page(offset);
  await model.open("songs");
  await model.load(true, 800);
  library.songs = async (_id, offset = 0) => offset >= 800 ? new Promise(() => {}) : page(offset);
  void model.load(true);
  await model.openCollection({ ...song("a"), type: "library-albums" });
  model.back(); await Bun.sleep(0);
  expect({ count: model.items.length, more: model.more }).toEqual({ count: 800, more: true });
});

test("going back to a filtered list loads the rest of it again", async () => {
  const { model, library } = setup();
  const page = (offset: number): Page => ({ items: Array.from({ length: 100 }, (_, index) => song(String(offset + index))), more: offset < 900 });
  let stall = false;
  library.songs = async (_id, offset = 0) => { if (stall && offset >= 600) await new Promise(() => {}); return page(offset); };
  await model.open("songs");
  stall = true;
  void model.setFilter({ text: "999" }); await Bun.sleep(0);
  await model.openCollection({ ...song("a"), type: "library-albums" });
  stall = false;
  model.back();
  await Bun.sleep(20);
  expect({ count: model.items.length, more: model.more, shown: model.shown.map(item => item.id) }).toEqual({ count: 1000, more: false, shown: ["999"] });
});

test("a favourite changed while a list's marks are asked again keeps its heart", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1"), song("2")], more: false });
  library.ratings = async () => new Set<string>();
  await model.open("songs"); await Bun.sleep(0);
  await model.open("albums");

  // Apple read its ratings before the favourite was saved.
  let answer!: (loved: Set<string>) => void;
  library.ratings = () => new Promise(resolve => { answer = resolve; });
  await model.open("songs");
  const playing = { name: "1", artistName: "Artist", inFavorites: false, playParams: { id: "1", catalogId: "1" } };
  Object.assign(model, { connected: true });
  model.playback = { ...model.playback, nowPlaying: playing };
  Object.assign(model.player as object, { snapshot: async () => model.playback, command: async () => {}, rating: async () => 1 });
  await model.toggleFavourite();
  expect(model.items[0]!.loved).toBe(true);
  answer(new Set());
  await Bun.sleep(0);
  expect(model.items.map(item => item.loved)).toEqual([true, false]);
});
