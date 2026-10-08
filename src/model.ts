import { EventEmitter } from "node:events";
import type { Preferences } from "./config";
import { defaults } from "./config";
import { stopped, type ArtistShelf, type Home, type Library, type Media, type Page, type Playback, type Player } from "./types";

export interface Navigation { id: string; name: string; media?: Media; hidden?: boolean }
export interface HomeStore { read(): Promise<Home | undefined>; write(home: Home): Promise<void> }
// Sections: songs above shelves of covers, on artist pages and in search results.
type Display = "home" | "grid" | "list" | "sections";
interface Snapshot { view: string; title: string; items: Media[]; more: boolean; detail?: Media; shelves: ArtistShelf[]; loader?: (offset: number) => Promise<Page>; collection?: { id: string; type: string } }

// New releases need one request per hundred library artists, so reuse them for a while.
const releasesFresh = 6 * 60 * 60 * 1000;
const navigationRetry = 10000;
const memoryStore: HomeStore = { read: async () => undefined, write: async () => {} };

export class Model extends EventEmitter {
  playback: Playback = structuredClone(stopped);
  // Cider answers with an authorised playback state. Browsing does not need it.
  connected = false;
  starting = false;
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
  layout = false;
  private generation = 0;
  private refreshing?: Promise<void>;
  private playbackError?: unknown;
  private engine?: Promise<void>;
  private browsingReady = false;
  private navigating?: Promise<void>;
  private navigationTried = 0;
  private loader?: (offset: number) => Promise<Page>;
  private collection?: { id: string; type: string };
  private commands: Promise<unknown> = Promise.resolve();
  private activation?: { key: string; started: number; pending: boolean; promise: Promise<void> };
  private loved?: { key: string; value: boolean };
  private homeRead = false;
  releases: Promise<void> = Promise.resolve();

  // Starts Cider when it is not running. Tests and custom API addresses need nothing started.
  wake: () => Promise<void> = async () => {};

  constructor(readonly library: Library, readonly player: Player, public preferences: Preferences = structuredClone(defaults), private save: (value: Preferences) => Promise<void> = async () => {}, private store: HomeStore = memoryStore) { super(); }
  changed() { this.emit("change"); }

  get display(): Display {
    return this.view === "home" ? "home" : this.view === "albums" || this.view === "artists" ? "grid" : this.view.startsWith("artist:") || this.view === "search" ? "sections" : "list";
  }

  // Home stays first. The layout editor arranges the entries after it.
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
        this.playback = await this.player.snapshot();
        this.playbackError = undefined;
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
    this.collection = undefined;
    this.detail = undefined;
    this.shelves = [];
    this.history = [];
    this.view = id;
    this.layout = false;
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
    this.view = `collection:${item.type}:${item.id}`; this.title = item.name; this.detail = item; this.layout = false; this.shelves = [];
    this.collection = { id: item.id, type: item.type };
    this.loader = item.type === "library-playlists" ? offset => this.library.songs(item.id, offset)
      : item.type === "playlists" ? offset => this.library.playlist(item.id, offset)
      : offset => this.library.album(item.id, offset);
    await this.load(false);
  }

  private remember() {
    this.history.push({ view: this.view, title: this.title, items: this.items, more: this.more, detail: this.detail, shelves: this.shelves, loader: this.loader, collection: this.collection });
  }

  // The artist of a song, album, or artist. Back returns to the page it was opened from.
  async openArtist(item: Media) {
    const artist = item.type.includes("artists");
    const name = artist ? item.name : item.artist;
    if (!name || item.type.includes("playlists")) { this.status = "Playlists have no artist page."; this.changed(); return; }
    if (this.view.startsWith("artist:") && (this.detail?.id === item.id || this.detail?.name === name)) return;
    this.remember();
    const generation = ++this.generation;
    this.view = `artist:${artist ? item.id : name}`; this.title = name; this.layout = false;
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
    ({ view: this.view, title: this.title, items: this.items, more: this.more, detail: this.detail, shelves: this.shelves, loader: this.loader, collection: this.collection } = previous);
    this.changed();
    return closed;
  }

  async search(term: string) {
    if (!term.trim()) return;
    this.collection = undefined;
    this.detail = undefined;
    this.shelves = [];
    this.history = [];
    const generation = ++this.generation;
    this.layout = false; this.view = "search"; this.title = `Search: ${term}`;
    this.loading = true; this.items = []; this.more = false; this.changed();
    try {
      const items = await this.library.search(term);
      if (generation !== this.generation) return;
      // Songs form the list. Albums and artists get shelves of covers.
      const of = (kind: string) => items.filter(item => item.type.includes(kind));
      this.items = items.filter(item => !/albums|artists|playlists/.test(item.type));
      this.shelves = [{ id: "albums", title: "Albums", items: of("albums") }, { id: "artists", title: "Artists", items: of("artists") }].filter(shelf => shelf.items.length);
      this.status = `${items.length} search results`;
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
  }

  async load(append: boolean) {
    if (!this.loader || append && this.loading) return;
    const generation = ++this.generation;
    const offset = append ? this.items.length : 0;
    if (!append) this.items = [];
    this.loading = true; this.more = false; this.changed();
    try {
      const result = await this.loader(offset);
      if (generation !== this.generation) return;
      this.items = append ? [...this.items, ...result.items] : result.items;
      this.more = result.more; this.status = `${this.items.length} items${result.more ? " loaded, more available" : ""}`;
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
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
    const index = this.items.indexOf(item);
    const activation = { key, started: Date.now(), pending: true, promise: Promise.resolve() };
    this.activation = activation;
    activation.promise = (async () => {
      try {
        if (item.queueIndex !== undefined) await this.act("/queue/jump", { index: item.queueIndex });
        else if (collection && index >= 0) await this.execute(() => this.player.playCollectionTrack(collection, this.items, index));
        else await this.execute(() => this.player.playItem(item));
      } finally { activation.pending = false; }
    })();
    await activation.promise;
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

  get favourite() {
    const key = this.songKey();
    return this.loved?.key === key ? this.loved.value : !!this.playback.nowPlaying?.inFavorites;
  }

  private songKey() {
    const song = this.playback.nowPlaying;
    return song ? song.playParams?.catalogId ?? song.playParams?.id ?? `${song.name}/${song.artistName}` : "";
  }

  async toggleFavourite() {
    const key = this.songKey();
    if (!key || !this.connected) return;
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
    if (saved !== value) this.status = "Apple Music did not save the favourite. Try again.";
    else this.status = value ? "Added to Favourite Songs" : "Removed from Favourite Songs";
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
  async bars() { await this.persist({ ...this.preferences, playbackBars: !this.preferences.playbackBars }); }
  private async persist(value: Preferences) {
    try { await this.save(value); this.preferences = value; this.status = "Layout saved"; this.changed(); }
    catch (error) { this.fail(error); }
  }
}
