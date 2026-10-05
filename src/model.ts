import { EventEmitter } from "node:events";
import type { Preferences } from "./config";
import { defaults } from "./config";
import { stopped, type Home, type Media, type Page, type Playback, type Player } from "./types";

export interface Navigation { id: string; name: string; media?: Media; hidden?: boolean }
export interface HomeStore { read(): Promise<Home | undefined>; write(home: Home): Promise<void> }
type Display = "home" | "grid" | "list";
interface Snapshot { view: string; title: string; items: Media[]; more: boolean; detail?: Media; loader?: (offset: number) => Promise<Page>; collection?: { id: string; type: string } }

// New releases need one request per hundred library artists, so reuse them for a while.
const releasesFresh = 6 * 60 * 60 * 1000;
const memoryStore: HomeStore = { read: async () => undefined, write: async () => {} };

export class Model extends EventEmitter {
  playback: Playback = structuredClone(stopped);
  connected = false;
  status = "Connecting to Cider...";
  playlists: Media[] = [];
  items: Media[] = [];
  title = "Home";
  view = "home";
  home: Home = { recent: [], releases: [] };
  homeLoading = { recent: false, releases: false };
  detail?: Media;
  history: Snapshot[] = [];
  loading = false;
  more = false;
  layout = false;
  private generation = 0;
  private refreshing = false;
  private browsingReady = false;
  private loader?: (offset: number) => Promise<Page>;
  private collection?: { id: string; type: string };
  private commands: Promise<unknown> = Promise.resolve();
  private activation?: { key: string; started: number; pending: boolean; promise: Promise<void> };
  private loved?: { key: string; value: boolean };
  private homeRead = false;
  releases: Promise<void> = Promise.resolve();

  constructor(readonly player: Player, public preferences: Preferences = structuredClone(defaults), private save: (value: Preferences) => Promise<void> = async () => {}, private store: HomeStore = memoryStore) { super(); }
  changed() { this.emit("change"); }

  get display(): Display { return this.view === "home" ? "home" : this.view === "albums" ? "grid" : "list"; }

  // Home stays first. The layout editor arranges the entries after it.
  navigation(includeHidden = false): Navigation[] {
    return [{ id: "home", name: "Home" }, ...this.entries(includeHidden)];
  }

  entries(includeHidden = false): Navigation[] {
    const entries: Navigation[] = [
      { id: "favourites", name: "Favourite Songs", media: this.playlists.find(p => p.favourite) },
      ...this.playlists.filter(p => !p.favourite).map(p => ({ id: `playlist:${p.id}`, name: p.name, media: p })),
      { id: "songs", name: "All songs" }, { id: "albums", name: "Albums" }, { id: "queue", name: "Queue" },
    ];
    const rank = (id: string) => { const index = this.preferences.order.indexOf(id); return index < 0 ? 1e6 : index; };
    entries.sort((a, b) => rank(a.id) - rank(b.id));
    return entries.map(item => ({ ...item, hidden: this.preferences.hidden.includes(item.id) })).filter(item => includeHidden || !item.hidden);
  }

  async start() {
    await this.refresh();
  }

  private async loadNavigation() {
    const generation = this.generation;
    try {
      this.playlists = await this.player.playlists();
      this.browsingReady = true;
      this.changed();
      if (generation === this.generation) await this.open(this.navigation()[0]?.id ?? "songs");
    } catch (error) { this.fail(error); }
  }

  fail(error: unknown) { this.status = error instanceof Error ? error.message : String(error); this.changed(); }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.playback = await this.player.snapshot();
      const recovering = !this.connected;
      this.connected = true;
      if (recovering) this.status = "Connected to Cider";
      this.changed();
      if (!this.browsingReady) await this.loadNavigation();
    } catch (error) { this.connected = false; this.fail(error); }
    finally { this.refreshing = false; }
  }

  async open(id: string) {
    this.collection = undefined;
    this.detail = undefined;
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
      this.loader = offset => this.player.songs(navigation.media!.id, offset);
      this.collection = { id: navigation.media.id, type: navigation.media.type };
    } else if (id === "albums") this.loader = offset => this.player.albums(offset);
    else if (id === "queue") this.loader = offset => this.player.queue(offset);
    else this.loader = offset => this.player.songs(undefined, offset);
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
      this.releases = this.homeShelf("releases", () => this.player.releases());
    }
    if (!this.homeLoading.recent) await this.homeShelf("recent", () => this.player.recent());
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
    this.history.push({ view: this.view, title: this.title, items: this.items, more: this.more, detail: this.detail, loader: this.loader, collection: this.collection });
    this.view = `collection:${item.type}:${item.id}`; this.title = item.name; this.detail = item; this.layout = false;
    this.collection = { id: item.id, type: item.type };
    this.loader = item.type === "library-playlists" ? offset => this.player.songs(item.id, offset)
      : item.type === "playlists" ? offset => this.player.playlist(item.id, offset)
      : offset => this.player.album(item.id, offset);
    await this.load(false);
  }

  back(): Media | undefined {
    const previous = this.history.pop();
    if (!previous) return undefined;
    const closed = this.detail;
    this.generation++; this.loading = false;
    ({ view: this.view, title: this.title, items: this.items, more: this.more, detail: this.detail, loader: this.loader, collection: this.collection } = previous);
    this.changed();
    return closed;
  }

  async search(term: string) {
    if (!term.trim()) return;
    this.collection = undefined;
    this.detail = undefined;
    this.history = [];
    const generation = ++this.generation;
    this.layout = false; this.view = "search"; this.title = `Search: ${term}`;
    this.loading = true; this.items = []; this.more = false; this.changed();
    try {
      const items = await this.player.search(term);
      if (generation !== this.generation) return;
      this.items = items; this.status = `${items.length} search results`;
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
        else if (collection && index >= 0) await this.execute(() => this.player.playCollectionTrack(collection, item, index));
        else await this.act("/playback/play-item", { id: item.id, type: item.type });
      } finally { activation.pending = false; }
    })();
    await activation.promise;
  }

  act(path: string, body: unknown = {}, method = "POST") {
    return this.execute(() => this.player.command(path, typeof body === "function" ? body() : body, method));
  }

  private async execute(command: () => Promise<void>) {
    let success = false;
    // Keep rapid clicks ordered, and always read Cider's state after a command.
    this.commands = this.commands.then(async () => {
      try {
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
    if (saved !== value) this.status = "Cider did not save the favourite. Try again.";
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
