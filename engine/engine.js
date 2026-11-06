// Runs inside https://music.apple.com/robots.txt. Loads MusicKit JS and exposes the
// player to the engine's main process as window.peelEngine.
(() => {
  const log = text => console.log(`peel:${text}`);
  const states = { 2: "playing", 3: "paused" };
  const repeats = ["none", "one", "all"];
  let music;
  let signIn = false;
  // The playing song's rating. A song shows as a favourite or not only once Apple has answered.
  let rated = { id: "", value: undefined, checked: 0 };
  // The queue entries the listener added, mapped to the Peel songs they came from. The rest of
  // MusicKit's queue is the collection that was playing.
  let added = new WeakMap();

  // Ratings belong to the catalog song. Library songs name it in their play parameters, and
  // songs only in the library are rated as library songs.
  const catalogId = item => item?.playParams?.catalogId ?? (/^\d+$/.test(item?.id ?? "") ? item.id : "");
  const ratingPath = item => {
    const id = catalogId(item);
    if (id) return `/v1/me/ratings/songs/${id}`;
    return item?.id?.startsWith("i.") ? `/v1/me/ratings/library-songs/${item.id}` : "";
  };
  // Asked by id, Apple lists only the songs that have a rating, so an unrated song is an empty
  // list. Asked by path, Apple answers 404, which MusicKit reports in shapes that change between
  // versions. A failed request leaves the rating unknown.
  async function readRating(item) {
    const path = ratingPath(item);
    if (!path) return 0;
    const [collection, id] = [path.slice(0, path.lastIndexOf("/")), path.slice(path.lastIndexOf("/") + 1)];
    try { return (await music.api.music(collection, { ids: id })).data.data?.[0]?.attributes?.value ?? 0; }
    catch { return undefined; }
  }
  async function checkRating() {
    const item = music.nowPlayingItem;
    if (!item) return;
    rated = { id: item.id, value: rated.id === item.id ? rated.value : undefined, checked: Date.now() };
    const value = await readRating(item);
    if (music.nowPlayingItem?.id === item.id && value !== undefined) rated = { id: item.id, value, checked: Date.now() };
  }
  // MusicKit queues songs in the shape Apple's API returns them, built here from Peel's songs.
  const resource = item => ({
    id: item.id, type: item.type,
    attributes: {
      name: item.name, artistName: item.artist, albumName: item.album, durationInMillis: Math.round(item.duration * 1000),
      ...(item.artwork ? { artwork: { url: item.artwork } } : {}),
      playParams: { id: item.id, kind: "song", ...(item.catalogId ? { catalogId: item.catalogId } : {}), ...(item.type.startsWith("library-") ? { isLibrary: true } : {}) },
    },
  });
  const describe = item => ({
    id: item.id, type: item.type,
    attributes: { name: item.title, artistName: item.artistName, albumName: item.albumName, durationInMillis: (item.playbackDuration ?? 0) },
  });

  const pending = () => music.queue.items.slice(music.queue.position + 1).filter(item => added.has(item));
  async function insert(items, at) {
    await music.playAt(at, { items: items.map(resource) });
    music.queue.items.slice(at, at + items.length).forEach((item, index) => added.set(item, items[index]));
  }

  window.peelEngine = {
    state() {
      if (!music) return { ready: false, signIn };
      const item = music.nowPlayingItem;
      // An unknown rating is asked again every few seconds.
      if (item && (rated.id !== item.id || rated.value === undefined) && Date.now() - rated.checked > 3000) void checkRating();
      return {
        ready: music.isAuthorized, signIn,
        playback: {
          state: states[music.playbackState] ?? (item ? "paused" : "stopped"),
          nowPlaying: item ? {
            name: item.title, artistName: item.artistName, albumName: item.albumName, artwork: { url: item.artwork?.url },
            inFavorites: rated.id === item.id && rated.value !== undefined ? rated.value === 1 : undefined,
            playParams: { id: item.id, catalogId: catalogId(item) },
          } : null,
          time: { currentTime: music.currentPlaybackTime ?? 0, duration: music.currentPlaybackDuration ?? 0 },
          volume: music.volume, repeatMode: repeats[music.repeatMode] ?? "none", shuffleMode: music.shuffleMode === 1,
        },
      };
    },
    tokens: () => ({ userToken: music.musicUserToken, storefront: music.storefrontId }),
    toggle: () => music.playbackState === 2 ? music.pause() : music.play(),
    next: () => music.skipToNextItem(),
    previous: () => music.skipToPreviousItem(),
    seek: position => music.seekToTime(position),
    volume: value => { music.volume = Math.min(1, Math.max(0, value)); log(`volume ${music.volume}`); },
    shuffle: enabled => { music.shuffleMode = enabled ? 1 : 0; },
    toggleShuffle: () => { music.shuffleMode = music.shuffleMode === 1 ? 0 : 1; },
    toggleRepeat: () => { music.repeatMode = (music.repeatMode + 1) % 3; },
    // A song inside its collection: the whole list is queued, starting at the selected song.
    // Songs the listener added and has not heard yet stay queued after it.
    play: async (items, index = 0) => {
      const waiting = pending().map(item => added.get(item));
      added = new WeakMap();
      await music.setQueue({ items: items.map(resource), startWith: index, startPlaying: true });
      if (waiting.length) await insert(waiting, music.queue.position + 1);
    },
    // Play next goes directly after the playing song. Otherwise the songs go after the other added
    // songs and before the rest of the collection. Songs added while nothing is queued start playing.
    enqueue: async (items, next) => {
      if (!music.queue.items.length) {
        await music.setQueue({ items: items.map(resource), startPlaying: true });
        music.queue.items.slice(1).forEach((item, index) => added.set(item, items[index + 1]));
        return;
      }
      let at = music.queue.position + 1;
      if (!next) while (added.has(music.queue.items[at])) at++;
      await insert(items, at);
    },
    // Queue edits move MusicKit's own entries, so a moved song stays marked as added.
    // Only songs after the playing one change.
    move: (from, to) => {
      if (Math.min(from, to) <= music.queue.position) return;
      const [entry] = music.queue.spliceQueueItems(from, 1);
      music.queue.spliceQueueItems(to, 0, [entry]);
    },
    remove: index => { if (index > music.queue.position) music.queue.spliceQueueItems(index, 1); },
    jump: index => music.changeToMediaAtIndex(index),
    queue: () => ({ position: music.queue.position, items: music.queue.items.map(item => ({ ...describe(item), added: pending().includes(item) })) }),
    rating: async () => await readRating(music.nowPlayingItem) ?? -1,
    // Peel names the song it means. A song that changed since then is not rated.
    rate: async (value, expected) => {
      const item = music.nowPlayingItem, path = ratingPath(item);
      if (expected && item?.id !== expected) throw new Error("The playing song changed. Nothing was rated.");
      if (!path) throw new Error("This song cannot be rated.");
      const fetchOptions = value ? { method: "PUT", body: JSON.stringify({ type: "rating", attributes: { value } }) } : { method: "DELETE" };
      await music.api.music(path, {}, { fetchOptions });
      rated = { id: item.id, value: value ? 1 : 0, checked: Date.now() };
    },
  };

  document.addEventListener("musickitloaded", async () => {
    music = await MusicKit.configure({ developerToken: window.peel.token, app: { name: "Peel", build: "0.1.0" } });
    music.volume = window.peel.volume;
    music.addEventListener("nowPlayingItemDidChange", () => void checkRating());
    music.addEventListener("playbackVolumeDidChange", () => log(`volume ${music.volume}`));
    log(`configured, authorized=${music.isAuthorized}`);
    if (!music.isAuthorized) {
      signIn = true;
      try { await music.authorize(); } catch (error) { log(`sign-in failed ${error}`); }
      signIn = false;
    }
    log(`ready, authorized=${music.isAuthorized}`);
  });
  const script = document.createElement("script");
  script.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
  script.dataset.webComponents = "";
  document.head.append(script);
})();
