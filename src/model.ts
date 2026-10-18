import { EventEmitter } from "node:events";
import type { Preferences } from "./config";
import { defaults } from "./config";
import { stopped, type ArtistShelf, type Home, type Library, type Media, type Page, type Playback, type Player } from "./types";

export interface Navigation { id: string; name: string; media?: Media; hidden?: boolean }
export interface HomeStore { read(): Promise<Home | undefined>; write(home: Home): Promise<void> }
// Sections: songs above shelves of covers, on artist pages and in search results.
type Display = "home" | "grid" | "list" | "sections";
export type Sort = "playlist" | "title" | "artist" | "album" | "year" | "length" | "shuffled";
export const sorts: Record<Sort, string> = { playlist: "Playlist order", title: "Title", artist: "Artist", album: "Album", year: "Year", length: "Length", shuffled: "Shuffled" };
// What a song list shows: matching words and years, an order and its direction, and optionally favourites only.
export interface Filter { text: string; sort: Sort; descending: boolean; loved: boolean }
const unfiltered: Filter = { text: "", sort: "playlist", descending: false, loved: false };

// Filter text holds words and release years: "2015-2020", ">2018", "<2000", "2018+", "90s", or "1990s".
// A bare year such as "2016" matches that release year or the number in a title.
export function parseFilter(text: string) {
  const words: string[] = [], years: [number, number][] = [], either: number[] = [];
  for (const token of text.replace(/(\d{4})\s*(?:-|–|\.\.)\s*(\d{4})/g, "$1-$2").split(/\s+/).filter(Boolean)) {
    let match: RegExpMatchArray | null;
    if ((match = token.match(/^(\d{4})-(\d{4})$/))) years.push([Math.min(+match[1]!, +match[2]!), Math.max(+match[1]!, +match[2]!)]);
    else if ((match = token.match(/^>(=?)(\d{4})$/))) years.push([+match[2]! + (match[1] ? 0 : 1), 9999]);
    else if ((match = token.match(/^<(=?)(\d{4})$/))) years.push([0, +match[2]! - (match[1] ? 0 : 1)]);
    else if ((match = token.match(/^(\d{4})\+$/))) years.push([+match[1]!, 9999]);
    else if ((match = token.match(/^(\d{2}|\d{4})s$/))) {
      const start = match[1]!.length === 4 ? +match[1]! : (+match[1]! < 30 ? 2000 : 1900) + +match[1]!;
      years.push([start, start + 9]);
    }
    else if (/^\d{4}$/.test(token)) either.push(+token);
    else words.push(fold(token));
  }
  return { words, years, either };
}
interface Snapshot { view: string; title: string; items: Media[]; more: boolean; detail?: Media; shelves: ArtistShelf[]; loader?: (offset: number) => Promise<Page>; collection?: { id: string; type: string }; filter: Filter }

// Case and accents do not matter: "beyonce" finds "Beyoncé".
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// New releases need one request per hundred library artists, so reuse them for a while.
const releasesFresh = 6 * 60 * 60 * 1000;
const navigationRetry = 10000;
// Apple returns a hundred items per request. Lists load backgroundLimit items without scrolling.
const pageSize = 100;
export const backgroundLimit = 500;
const memoryStore: HomeStore = { read: async () => undefined, write: async () => {} };

export class Model extends EventEmitter {
  playback: Playback = structuredClone(stopped);
  // Cider answers with an authorised playback state. Browsing does not need it.
  connected = false;
  starting = false;
  // Counts changes to songs' favourite marks, which change the songs in place.
  lovedRevision = 0;
  status = "Loading your library...";
  playlists: Media[] = [];
  items: Media[] = [];
  title = "Home";
  view = "home";
  home: Home = { recent: [], releases: [] };
  homeLoading = { recent: false, releases: false };
  detail?: Media;
  // An artist page's albums. Its top songs are the items.
  shelves: ArtistShelf[] = [];
  history: Snapshot[] = [];
  loading = false;
  more = false;
  private generation = 0;
  private refreshing?: Promise<void>;
  private playbackError?: unknown;
  private engine?: Promise<void>;
  private browsingReady = false;
  private navigating?: Promise<void>;
  private navigationTried = 0;
  private loader?: (offset: number) => Promise<Page>;
  private loads?: Promise<void>;
  private collection?: { id: string; type: string };
  private commands: Promise<unknown> = Promise.resolve();
  private queueEdits = 0;
  private activation?: { key: string; started: number; pending: boolean; promise: Promise<void> };
  private loved?: { key: string; value: boolean };
  // Albums' favourite marks by album id, once Apple has answered.
  private albumsLoved = new Map<string, boolean>();
  private homeRead = false;
  releases: Promise<void> = Promise.resolve();

  // Starts Cider when it is not running. Tests and custom API addresses need nothing started.
  wake: () => Promise<void> = async () => {};

  constructor(readonly library: Library, readonly player: Player, public preferences: Preferences = structuredClone(defaults), private save: (value: Preferences) => Promise<void> = async () => {}, private store: HomeStore = memoryStore) { super(); }
  changed() { this.emit("change"); }

  get display(): Display {
    return this.view === "home" ? "home" : this.view === "albums" || this.view === "artists" ? "grid" : this.view.startsWith("artist:") || this.view === "search" ? "sections" : "list";
  }

  // Home stays first. The sidebar's editing keys arrange the entries after it.
  navigation(includeHidden = false): Navigation[] {
    return [{ id: "home", name: "Home" }, ...this.entries(includeHidden)];
  }

  entries(includeHidden = false): Navigation[] {
    const entries: Navigation[] = [
      { id: "favourites", name: "Favourite Songs", media: this.playlists.find(p => p.favourite) },
      ...this.playlists.filter(p => !p.favourite).map(p => ({ id: `playlist:${p.id}`, name: p.name, media: p })),
      { id: "songs", name: "All songs" }, { id: "albums", name: "Albums" }, { id: "artists", name: "Artists" }, { id: "queue", name: "Queue" },
    ];
    const rank = (id: string) => { const index = this.preferences.order.indexOf(id); return index < 0 ? 1e6 : index; };
    entries.sort((a, b) => rank(a.id) - rank(b.id));
    return entries.map(item => ({ ...item, hidden: this.preferences.hidden.includes(item.id) })).filter(item => includeHidden || !item.hidden);
  }

  // Home and the sidebar come from Apple Music, so they load while Cider is still starting.
  async start() {
    await Promise.all([this.loadNavigation(), this.loadHome(), this.refresh()]);
  }

  private loadNavigation() {
    this.navigationTried = Date.now();
    return this.navigating ??= (async () => {
      try {
        this.playlists = await this.library.playlists();
        this.browsingReady = true;
        this.changed();
      } catch (error) { this.fail(error); }
      finally { this.navigating = undefined; }
    })();
  }

  fail(error: unknown) { this.status = error instanceof Error ? error.message : String(error); this.changed(); }

  // Concurrent callers share one playback request and its result.
  refresh() {
    if (!this.browsingReady && Date.now() - this.navigationTried > navigationRetry) void this.loadNavigation();
    return this.refreshing ??= (async () => {
      try {
        const playing = this.playback.nowPlaying?.playParams?.id;
        this.playback = await this.player.snapshot();
        this.playbackError = undefined;
        // A queued song leaves the queue when it starts playing.
        if (this.view === "queue" && !this.loading && playing !== this.playback.nowPlaying?.playParams?.id) void this.requeue();
        const recovering = !this.connected;
        this.connected = true;
        if (recovering && !this.starting) this.status = "Ready to play";
        this.changed();
      } catch (error) {
        // Cider not running yet is normal. Losing a working connection is reported.
        if (this.connected) this.fail(error);
        this.connected = false; this.playbackError = error; this.changed();
      } finally { this.refreshing = undefined; }
    })();
  }

  // Playback commands wait here. Concurrent commands share one Cider startup, and a failure allows a retry.
  ensurePlayback(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return this.engine ??= (async () => {
      this.starting = true; this.changed();
      try {
        await this.wake();
        // A poll that began before Cider opened its API can still be in flight.
        await this.refresh();
        if (!this.connected) await this.refresh();
        if (!this.connected) throw this.playbackError ?? new Error("The player is not responding.");
        this.status = "Ready to play";
      } finally { this.starting = false; this.engine = undefined; this.changed(); }
    })();
  }

  async open(id: string) {
    this.filter = unfiltered;
    this.collection = undefined;
    this.detail = undefined;
    this.shelves = [];
    this.history = [];
    this.view = id;
    const navigation = this.navigation(true).find(item => item.id === id);
    this.title = navigation?.name ?? id;
    if (id === "home") {
      this.generation++; this.loader = undefined; this.items = []; this.more = false; this.loading = false;
      this.changed(); await this.loadHome(); return;
    }
    if (id === "favourites" || id.startsWith("playlist:")) {
      if (!navigation?.media) {
        this.generation++; this.items = []; this.more = false; this.loading = false;
        this.status = "No Favourite Songs playlist returned by Apple Music."; this.changed(); return;
      }
      this.loader = offset => this.library.songs(navigation.media!.id, offset);
      this.collection = { id: navigation.media.id, type: navigation.media.type };
    } else if (id === "albums") this.loader = offset => this.library.albums(offset);
    else if (id === "artists") this.loader = offset => this.library.artists(offset);
    // The queue lives in Cider. Before Cider runs there is nothing queued.
    else if (id === "queue") this.loader = offset => this.connected ? this.player.queue(offset) : Promise.resolve({ items: [], more: false });
    else this.loader = offset => this.library.songs(undefined, offset);
    await this.load(false);
  }

  async loadHome(force = false) {
    if (!this.homeRead) {
      this.homeRead = true;
      const cached = await this.store.read().catch(() => undefined);
      if (cached && !this.home.updated) { this.home = cached; this.changed(); }
    }
    // The release scan takes seconds. Playback polling must not wait for it.
    if (!this.homeLoading.releases && (force || !this.home.updated || Date.now() - this.home.updated > releasesFresh)) {
      this.releases = this.homeShelf("releases", () => this.library.releases());
    }
    if (!this.homeLoading.recent) await this.homeShelf("recent", () => this.library.recent());
  }

  private async homeShelf(shelf: "recent" | "releases", load: () => Promise<Media[]>) {
    this.homeLoading[shelf] = true; this.changed();
    try {
      const items = await load();
      this.home = { ...this.home, [shelf]: items, ...(shelf === "releases" ? { updated: Date.now() } : {}) };
      await this.store.write(this.home).catch(() => {});
    } catch (error) { this.fail(error); }
    finally { this.homeLoading[shelf] = false; this.changed(); }
  }

  // Albums and playlists open as their own view. Back returns to the previous one.
  async openCollection(item: Media) {
    this.remember();
    this.view = `collection:${item.type}:${item.id}`; this.title = item.name; this.detail = item; this.shelves = [];
    this.collection = { id: item.id, type: item.type };
    this.loader = this.songsOf(item);
    if (item.type.includes("albums") && !this.albumsLoved.has(item.id)) void this.library.albumFavourite(item).then(value => { this.albumsLoved.set(item.id, value); this.changed(); }, () => {});
    await this.load(false);
  }

  private songsOf(item: Media): (offset: number) => Promise<Page> {
    return item.type === "library-playlists" ? offset => this.library.songs(item.id, offset)
      : item.type === "playlists" ? offset => this.library.playlist(item.id, offset)
      : offset => this.library.album(item.id, offset);
  }

  private remember() {
    this.history.push({ view: this.view, title: this.title, items: this.items, more: this.more, detail: this.detail, shelves: this.shelves, loader: this.loader, collection: this.collection, filter: this.filter });
    this.filter = unfiltered;
  }

  // The artist of a song, album, or artist. Back returns to the page it was opened from.
  async openArtist(item: Media) {
    const artist = item.type.includes("artists");
    const name = artist ? item.name : item.artist;
    if (!name || item.type.includes("playlists")) { this.status = "Playlists have no artist page."; this.changed(); return; }
    if (this.view.startsWith("artist:") && (this.detail?.id === item.id || this.detail?.name === name)) return;
    this.remember();
    const generation = ++this.generation;
    this.view = `artist:${artist ? item.id : name}`; this.title = name;
    this.detail = artist ? item : { id: "", type: "artists", name, artist: "", album: "", duration: 0 };
    this.collection = undefined; this.loader = undefined;
    this.items = []; this.shelves = []; this.more = false; this.loading = true; this.changed();
    try {
      const id = await this.library.artistId(item);
      if (generation !== this.generation) return;
      if (!id) { this.status = `Apple Music has no artist page for ${name}.`; return; }
      // A collaboration can lead back to the artist page it was opened from.
      if (this.history.at(-1)?.view === `artist:${id}`) { this.back(); return; }
      const page = await this.library.artist(id);
      if (generation !== this.generation) return;
      this.view = `artist:${id}`; this.title = page.artist.name; this.detail = page.artist;
      this.items = page.top; this.shelves = page.shelves;
      void this.markLoved(page.top);
      this.status = page.artist.name;
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
  }

  // The playing song as an item, so its artist can be opened.
  get playing(): Media | undefined {
    const song = this.playback.nowPlaying;
    if (!song?.artistName) return undefined;
    return { id: song.playParams?.catalogId ?? song.playParams?.id ?? "", type: "songs", name: song.name ?? "", artist: song.artistName, album: song.albumName ?? "", duration: 0 };
  }

  back(): Media | undefined {
    const previous = this.history.pop();
    if (!previous) return undefined;
    const closed = this.detail;
    this.generation++; this.loading = false;
    ({ view: this.view, title: this.title, items: this.items, more: this.more, detail: this.detail, shelves: this.shelves, loader: this.loader, collection: this.collection, filter: this.filter } = previous);
    this.changed();
    // Opening the page stopped this list's background loading. It continues where it was.
    if (this.more && this.items.length < backgroundLimit) void this.load(true, backgroundLimit);
    return closed;
  }

  async search(term: string) {
    if (!term.trim()) return;
    this.filter = unfiltered;
    this.collection = undefined;
    this.detail = undefined;
    this.shelves = [];
    this.history = [];
    const generation = ++this.generation;
    this.view = "search"; this.title = `Search: ${term}`;
    this.loading = true; this.items = []; this.more = false; this.changed();
    try {
      const items = await this.library.search(term);
      if (generation !== this.generation) return;
      // Songs form the list. Albums and artists get shelves of covers.
      const of = (kind: string) => items.filter(item => item.type.includes(kind));
      this.items = items.filter(item => !/albums|artists|playlists/.test(item.type));
      void this.markLoved(this.items);
      this.shelves = [{ id: "albums", title: "Albums", items: of("albums") }, { id: "artists", title: "Artists", items: of("artists") }].filter(shelf => shelf.items.length);
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
  }

  // A list opens with its first page, then keeps loading pages in the background up to
  // backgroundLimit items. Past that, scrolling near the end loads one more page each time.
  load(append: boolean, until = append ? 0 : backgroundLimit) {
    if (!this.loader || append && this.loading) return this.loads ?? Promise.resolve();
    const generation = ++this.generation, loader = this.loader;
    if (!append) { this.items = []; this.more = false; }
    this.loading = true; this.changed();
    const loads = this.loads = (async () => {
      try {
        do {
          // The first page comes alone so the list shows at once. Later pages arrive four at a time.
          const count = this.items.length ? Math.max(1, Math.min(4, Math.ceil((until - this.items.length) / pageSize))) : 1;
          const results = await Promise.all(Array.from({ length: count }, (_, index) => loader(this.items.length + index * pageSize)));
          if (generation !== this.generation) return;
          for (const result of results) {
            this.items = [...this.items, ...result.items];
            void this.markLoved(result.items);
            this.more = result.more;
            // A short page means the offsets after it are off. The next round starts from here.
            if (!result.more || result.items.length < pageSize) break;
          }
          this.changed();
        } while (this.more && this.items.length < until);
      } catch (error) { if (generation === this.generation) { this.more = false; this.fail(error); } }
      finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
    })();
    return loads;
  }

  filter: Filter = unfiltered;
  private filtered?: { items: Media[]; filter: Filter; loved: number; shown: Media[] };
  private order?: { items: Media[]; index: Map<string, number> };

  // The songs as shown: the loaded songs, filtered and sorted.
  get shown(): Media[] {
    const { text, sort, descending, loved } = this.filter;
    if (!text.trim() && sort === "playlist" && !descending && !loved) return this.items;
    const cached = this.filtered;
    if (cached && cached.items === this.items && cached.filter === this.filter && cached.loved === this.lovedRevision) return cached.shown;
    const { words, years, either } = parseFilter(text);
    let shown = this.items.filter(item => {
      if (loved && !item.loved) return false;
      const haystack = fold(`${item.name} ${item.artist} ${item.album}`), year = Number(item.releaseDate?.slice(0, 4)) || 0;
      return words.every(word => haystack.includes(word)) && years.every(([from, to]) => year >= from && year <= to)
        && either.every(value => year === value || haystack.includes(String(value)));
    });
    const by = (key: (item: Media) => string | number) => (a: Media, b: Media) => {
      const x = key(a), y = key(b);
      return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: "base", numeric: true });
    };
    if (sort === "title") shown = shown.toSorted(by(item => item.name));
    else if (sort === "artist") shown = shown.toSorted((a, b) => by(item => item.artist)(a, b) || by(item => item.album)(a, b));
    else if (sort === "album") shown = shown.toSorted((a, b) => by(item => item.album)(a, b) || by(item => item.artist)(a, b));
    else if (sort === "length") shown = shown.toSorted(by(item => item.duration));
    else if (sort === "year") shown = shown.toSorted((a, b) => by(item => item.releaseDate ?? "")(a, b) || by(item => item.album)(a, b));
    else if (sort === "shuffled") {
      shown = [...shown];
      for (let index = shown.length - 1; index > 0; index--) { const other = Math.floor(Math.random() * (index + 1)); [shown[index], shown[other]] = [shown[other]!, shown[index]!]; }
    }
    if (descending && sort !== "shuffled") shown = sort === "playlist" ? shown.toReversed() : shown.reverse();
    this.filtered = { items: this.items, filter: this.filter, loved: this.lovedRevision, shown };
    return shown;
  }

  // A song's place in the playlist, which its row shows when the list is filtered.
  position(item: Media) {
    if (this.order?.items !== this.items) this.order = { items: this.items, index: new Map(this.items.map((song, index) => [song.id, index])) };
    return this.order.index.get(item.id) ?? -1;
  }

  // Filtering and sorting cover the whole list, so the rest of it loads first.
  async setFilter(change: Partial<Filter>) {
    this.filter = { ...this.filter, ...change };
    this.changed();
    const view = this.view;
    // A load that is already running finishes first, then the rest of the list loads.
    while (view === this.view && (this.loading || this.more) && (this.filter.text.trim() || this.filter.sort !== "playlist" || this.filter.descending || this.filter.loved)) {
      await (this.loading ? this.loads : this.load(true, Infinity));
    }
  }

  // Marks which songs are favourites, so their rows show a heart. Every song in Favourite Songs is one.
  private async markLoved(items: Media[]) {
    const songs = items.filter(item => /songs/.test(item.type) && item.loved === undefined);
    if (!songs.length) return;
    if (this.view === "favourites") { for (const item of songs) item.loved = true; this.lovedRevision++; this.changed(); return; }
    try {
      const loved = await this.library.ratings(songs);
      for (const item of songs) item.loved = loved.has(item.id);
      this.lovedRevision++; this.changed();
    } catch {}
  }

  async activate(item: Media) {
    if (item.type.includes("artists")) return this.openArtist(item);
    if (item.type.includes("albums") || item.type.includes("playlists")) return this.openCollection(item);
    const key = JSON.stringify([this.view, item.type, item.id, item.queueIndex]);
    const previous = this.activation;
    if (previous?.key === key && (previous.pending || Date.now() - previous.started < 500)) {
      await previous.promise;
      return;
    }
    const collection = this.collection;
    // A filtered list plays in its displayed order. Cider can only queue whole collections, so it plays the song alone.
    const list = this.shown;
    const index = list === this.items || this.player.queuesItems ? list.indexOf(item) : -1;
    const activation = { key, started: Date.now(), pending: true, promise: Promise.resolve() };
    this.activation = activation;
    activation.promise = (async () => {
      try {
        if (item.queueIndex !== undefined) await this.act("/queue/jump", { index: item.queueIndex });
        else if (collection && index >= 0) await this.execute(() => this.player.playCollectionTrack(collection, list, index));
        else await this.execute(() => this.player.playItem(item));
      } finally { activation.pending = false; }
    })();
    await activation.promise;
  }

  // Reads the open queue again without clearing it first. Edits still on their way to the
  // player would be undone on screen, so the last edit reads it.
  private async requeue() {
    if (this.queueEdits) return;
    const generation = this.generation;
    try {
      const page = await this.player.queue(0);
      if (generation !== this.generation || this.view !== "queue") return;
      this.items = page.items; this.more = page.more; this.changed();
    } catch {}
  }

  // Adds a song, album, or playlist directly after the playing song (next), or after the songs
  // already added, before the rest of the playing collection.
  async enqueue(item: Media, next: boolean) {
    if (item.type.includes("artists")) { this.status = "Artists cannot be queued. Open the artist and queue a song or album."; this.changed(); return; }
    let songs = [item];
    // Cider adds a collection itself. Peel's engine needs its songs, up to the usual list limit.
    if (/albums|playlists/.test(item.type) && this.player.queuesItems) {
      try {
        const load = this.songsOf(item);
        songs = [];
        for (let page: Page | undefined; !page || page.more && songs.length < backgroundLimit;) {
          page = await load(songs.length);
          if (!page.items.length) break;
          songs.push(...page.items);
        }
      } catch (error) { this.fail(error); return; }
      if (!songs.length) { this.status = `${item.name} has no songs to queue.`; this.changed(); return; }
    }
    if (!await this.execute(() => this.player.enqueue(songs, next))) return;
    // An open queue reads its songs again.
    if (this.view === "queue") await this.requeue();
    this.status = `${next ? "Plays next" : "Added to the queue"}: ${item.name}`;
    this.changed();
  }

  // Moves the song at from in the open queue to to, both places in the list. The list changes at
  // once. The songs keep the player's queue places they had, which are consecutive after the playing song.
  async moveQueued(from: number, to: number) {
    const item = this.items[from], target = this.items[to];
    if (this.view !== "queue" || from === to || item?.queueIndex === undefined || target?.queueIndex === undefined) return;
    const places = this.items.map(entry => entry.queueIndex);
    this.items = this.items.toSpliced(from, 1).toSpliced(to, 0, item).map((entry, index) => ({ ...entry, queueIndex: places[index] }));
    this.changed();
    await this.editQueue(() => this.act("/queue/move", { from: item.queueIndex, to: target.queueIndex }));
  }

  async removeQueued(index: number) {
    const item = this.items[index], place = item?.queueIndex;
    if (this.view !== "queue" || place === undefined) return;
    this.items = this.items.toSpliced(index, 1).map(entry => entry.queueIndex! > place ? { ...entry, queueIndex: entry.queueIndex! - 1 } : entry);
    this.status = `Removed from the queue: ${item!.name}`;
    this.changed();
    await this.editQueue(() => this.act(`/queue/items/${place}`, undefined, "DELETE"));
  }

  private async editQueue(edit: () => Promise<unknown>) {
    this.queueEdits++;
    try { await edit(); } finally { this.queueEdits--; }
    await this.requeue();
  }

  act(path: string, body: unknown = {}, method = "POST") {
    return this.execute(() => this.player.command(path, typeof body === "function" ? body() : body, method));
  }

  private async execute(command: () => Promise<void>) {
    let success = false;
    // Keep rapid clicks ordered, start Cider for the first one, and always read Cider's state after a command.
    this.commands = this.commands.then(async () => {
      try {
        await this.ensurePlayback();
        await command();
        success = true;
        await this.refresh();
      } catch (error) { this.fail(error); }
    });
    await this.commands;
    return success;
  }

  seek(delta: number) {
    const maximum = this.playback.time.duration;
    if (!(maximum > 0)) return Promise.resolve();
    return this.act("/playback/seek", () => ({ position: Math.min(maximum, Math.max(0, this.playback.time.currentTime + delta)) }));
  }
  volume(delta: number) { return this.act("/audio/volume", () => ({ volume: Math.min(1, Math.max(0, this.playback.volume + delta)) }), "PATCH"); }

  async skip(direction: -1 | 1) {
    if (this.playback.repeatMode !== "one") {
      return this.act(direction === 1 ? "/playback/next" : "/playback/previous", direction === -1 ? { force: true } : {});
    }
    try {
      // Cider's ordinary Next can repeat the current song in repeat-one mode.
      // An explicit queue jump skips without changing the user's repeat setting.
      const queue = await this.player.queuePosition();
      if (queue.total < 2) return false;
      return this.act("/queue/jump", { index: (queue.position + direction + queue.total) % queue.total });
    } catch (error) { this.fail(error); return false; }
  }

  // Undefined until Apple has said whether the playing song is a favourite.
  get favourite(): boolean | undefined {
    const key = this.songKey();
    return this.loved?.key === key ? this.loved.value : this.playback.nowPlaying?.inFavorites;
  }

  private songKey() {
    const song = this.playback.nowPlaying;
    return song ? song.playParams?.catalogId ?? song.playParams?.id ?? `${song.name}/${song.artistName}` : "";
  }

  async toggleFavourite() {
    const key = this.songKey();
    if (!key || !this.connected) return;
    // Toggling an unknown state could remove a favourite, which would move it in Favourite Songs.
    if (this.favourite === undefined) { this.status = "Still checking whether this song is a favourite."; this.changed(); return; }
    const value = !this.favourite;
    this.loved = { key, value }; this.changed();
    const done = await this.execute(() => value
      ? this.player.command("/library/now-playing/rating", { rating: 1 }, "PUT")
      : this.player.command("/library/now-playing/rating", {}, "DELETE"));
    // Cider applies ratings asynchronously. Read the stored rating before claiming it.
    let saved = !value;
    try {
      for (let attempt = 0; done && attempt < 30 && saved !== value; attempt++) {
        saved = await this.player.rating() === 1;
        if (saved !== value) await Bun.sleep(100);
      }
    } catch {}
    if (this.songKey() !== key) return;
    this.loved = { key, value: saved };
    // The song's row shows its heart too.
    for (const item of this.items) if (item.id === key || item.catalogId === key) item.loved = saved;
    this.lovedRevision++;
    if (saved !== value) this.status = "Apple Music did not save the favourite. Try again.";
    else this.status = value ? "Added to Favourite Songs" : "Removed from Favourite Songs";
    this.changed();
  }

  // Undefined until Apple has said whether the open album is a favourite.
  get albumFavourite(): boolean | undefined {
    return this.detail?.type.includes("albums") ? this.albumsLoved.get(this.detail.id) : undefined;
  }

  async toggleAlbumFavourite() {
    const album = this.detail;
    if (!album?.type.includes("albums")) return;
    const current = this.albumFavourite;
    if (current === undefined) { this.status = "Still checking whether this album is a favourite."; this.changed(); return; }
    this.albumsLoved.set(album.id, !current); this.changed();
    try {
      await this.library.favouriteAlbum(album, !current);
      this.status = current ? `Removed ${album.name} from favourite albums` : `Added ${album.name} to favourite albums`;
    } catch (error) { this.albumsLoved.set(album.id, current); this.fail(error); return; }
    this.changed();
  }

  async reorder(id: string, direction: number) {
    const entries = this.entries(true).map(item => item.id);
    const index = entries.indexOf(id), target = index + direction;
    if (index < 0 || target < 0 || target >= entries.length) return;
    [entries[index], entries[target]] = [entries[target], entries[index]];
    await this.persist({ ...this.preferences, order: entries });
  }
  async hide(id: string) {
    const hidden = this.preferences.hidden.includes(id) ? this.preferences.hidden.filter(value => value !== id) : [...this.preferences.hidden, id];
    await this.persist({ ...this.preferences, hidden });
  }
  private async persist(value: Preferences) {
    try { await this.save(value); this.preferences = value; this.status = "Layout saved"; this.changed(); }
    catch (error) { this.fail(error); }
  }
}
