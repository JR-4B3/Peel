// Changes that arrive while an earlier one is still running: settings saved during a save, and
// a second song chosen while the first one starts.
import { expect, test } from "bun:test";
import { defaults, type Preferences } from "../src/config";
import { Model } from "../src/model";
import { stopped } from "../src/types";

const song = (id: string) => ({ id, type: "library-songs", name: id, artist: "Artist", album: "Album", duration: 100 });

test("settings changed while an earlier change saves keep both changes", async () => {
  const saved: Preferences[] = [];
  // Each save takes a moment, as a write to disk does.
  const save = async (value: Preferences) => { await Bun.sleep(20); saved.push(structuredClone(value)); };
  const model = new Model({} as any, { snapshot: async () => structuredClone(stopped) } as any, structuredClone(defaults), save);
  await Promise.all([model.hide("albums"), model.hide("artists")]);
  expect(model.preferences.hidden).toEqual(["albums", "artists"]);
  await Promise.all([model.setPreference({ quality: "standard" }, "Quality"), model.setPreference({ channel: "nightly" }, "Channel")]);
  expect(model.preferences).toMatchObject({ quality: "standard", channel: "nightly", hidden: ["albums", "artists"] });
  expect(saved.at(-1)).toEqual(model.preferences);
});

test("choosing another copy of a song while the first one starts plays from that copy", async () => {
  for (const ids of [["101", "102", "103"], ["101", "102", "101"]]) {
    const items = ids.map(song), started: number[] = [];
    const library = { songs: async () => ({ items, more: false }), ratings: async () => new Set() };
    const player = {
      snapshot: async () => structuredClone(stopped),
      playCollectionTrack: async (_collection: unknown, _items: unknown, index: number) => { await Bun.sleep(20); started.push(index); },
    };
    const model = new Model(library as any, player as any);
    model.connected = true;
    await model.openCollection({ id: "p.list", type: "library-playlists", name: "Playlist", artist: "", album: "", duration: 0 });
    await Promise.all([model.activate(model.items[0]!), model.activate(model.items[2]!)]);
    expect(started).toEqual([0, 2]);
    // A double-click on one row still starts it once.
    started.length = 0;
    await Promise.all([model.activate(model.items[1]!), model.activate(model.items[1]!)]);
    expect(started).toEqual([1]);
  }
});
