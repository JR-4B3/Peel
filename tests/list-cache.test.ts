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

test("an unchanged answer keeps the list and its favourite marks", async () => {
  const { model, library } = setup();
  let ratings = 0;
  library.songs = async () => ({ items: [song("1"), song("2")], more: false });
  library.ratings = async () => { ratings++; return new Set(["2"]); };
  await model.open("songs"); await Bun.sleep(0);
  const first = model.items;
  expect(first.map(item => item.loved)).toEqual([false, true]);

  await model.open("albums");
  await model.open("songs"); await Bun.sleep(0);
  expect(model.items).toBe(first);
  expect(ratings).toBe(1);
});

test("a refreshed list keeps the marks of songs it still has", async () => {
  const { model, library } = setup();
  library.songs = async () => ({ items: [song("1")], more: false });
  library.ratings = async () => new Set(["1"]);
  await model.open("songs"); await Bun.sleep(0);
  await model.open("albums");

  const asked: string[][] = [];
  library.songs = async () => ({ items: [song("1"), song("2")], more: false });
  library.ratings = async songs => { asked.push(songs.map(item => item.id)); return new Set(); };
  await model.open("songs"); await Bun.sleep(0);
  expect(model.items.map(item => [item.id, item.loved])).toEqual([["1", true], ["2", false]]);
  // Only the new song needed asking.
  expect(asked).toEqual([["2"]]);
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
  library.playlists = async () => [favourite];
  library.songs = async (id, offset = 0) => { asked.push(`${id ?? "all"}@${offset}`); return { items: [song(id ?? "all")], more: false }; };
  library.albums = async () => ({ items: [{ ...song("album"), type: "library-albums" }], more: false });
  await (model as unknown as { loadNavigation(): Promise<void> }).loadNavigation();
  await Bun.sleep(10);
  // Only first pages, and nothing for the queue or settings.
  expect(asked.sort()).toEqual(["all@0", "p.fav@0"]);

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
  // The first page matches, so the shown songs stay the same objects and the next pages follow.
  expect(model.items).toBe(first);
  for (const offset of [100, 200, 300, 400]) answers.get(offset)!(page(offset));
  await opening;
  expect({ count: model.items.length, first: model.items[0], loading: model.loading }).toEqual({ count: 500, first: first[0], loading: false });
});
