// Runs inside https://music.apple.com/robots.txt. Loads MusicKit JS and exposes the
// player to the engine's main process as window.peelEngine.
(() => {
  const log = text => console.log(`peel:${text}`);
  const states = { 2: "playing", 3: "paused" };
  const repeats = ["none", "one", "all"];
  let music;
  let signIn = false;
  // Where music played a moment ago, and why it last stopped by itself, for the status line.
  let last;
  let notice;
  // Peel reads the state every second, and MusicKit does not always report time changes, so both
  // remember where music plays.
  // Only music the listener wants playing counts. MusicKit can still report playing for a moment
  // after a pause, and a paused import plays muted to reach its position.
  let wanted = false;
  const want = value => { wanted = value; if (!value) last = undefined; };
  const remember = () => { if (wanted && music?.playbackState === 2) last = { position: music.queue.position, time: music.currentPlaybackTime ?? 0, duration: music.currentPlaybackDuration ?? 0, at: Date.now() }; };
  // The playing song's rating. A song shows as a favourite or not only once Apple has answered.
  let rated = { id: "", value: undefined, checked: 0 };
  // The queue entries the listener added, mapped to the Peel songs they came from. The rest of
  // MusicKit's queue is the collection that was playing.
  let added = new WeakMap();

  // Library and catalog ratings can differ. A library song is read and rated by its library
  // ID even when its play parameters also name a catalog song.
  const catalogId = item => item?.playParams?.catalogId ?? (/^\d+$/.test(item?.id ?? "") ? item.id : "");
  const ratingPath = item => {
    if (item?.id?.startsWith("i.")) return `/v1/me/ratings/library-songs/${item.id}`;
    const id = catalogId(item);
    if (id) return `/v1/me/ratings/songs/${id}`;
    return "";
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

  // A queued entry as a Peel song again, for moving the queue to another device. Added songs keep
  // the song Peel queued. The collection's entries are read back from MusicKit.
  // MusicKit names every queued entry's type "song", so a library song is known by its
  // library ID or its play parameters. Without that, another device would look it up in the catalog.
  const song = item => added.get(item) ?? {
    id: item.id, type: item.playParams?.isLibrary || /^i\./.test(item.id ?? "") || item.type?.startsWith("library-") ? "library-songs" : "songs",
    name: item.attributes?.name ?? item.title ?? "", artist: item.attributes?.artistName ?? item.artistName ?? "", album: item.attributes?.albumName ?? item.albumName ?? "",
    duration: (item.attributes?.durationInMillis ?? item.playbackDuration ?? 0) / 1000,
    ...(item.attributes?.artwork?.url ?? item.artwork?.url ? { artwork: item.attributes?.artwork?.url ?? item.artwork?.url } : {}),
    ...(catalogId(item) && catalogId(item) !== item.id ? { catalogId: catalogId(item) } : {}),
  };
  const pending = () => music.queue.items.slice(music.queue.position + 1).filter(item => added.has(item));
  // A short fingerprint of the queue: the playing place and every entry with its added mark. Peel
  // reads the state every second, often over the network, so it carries 8 characters instead of
  // every song's ID. FNV-1a, which is enough to notice a change.
  function revision() {
    let hash = 0x811c9dc5;
    const add = text => { for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); } };
    add(String(music.queue.position));
    for (const item of music.queue.items) add(`|${item.id}${added.has(item) ? "+" : ""}`);
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  async function insert(items, at) {
    await music.playAt(at, { items: items.map(resource) });
    music.queue.items.slice(at, at + items.length).forEach((item, index) => added.set(item, items[index]));
  }

  window.peelEngine = {
    state() {
      if (!music) return { ready: false, signIn };
      remember();
      const item = music.nowPlayingItem;
      // An unknown rating is asked again every few seconds, and a known one every half minute, so
      // a favourite changed in another app or on another device shows here too.
      if (item && Date.now() - rated.checked > (rated.id !== item.id || rated.value === undefined ? 3000 : 30000)) void checkRating();
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
          queueRevision: revision(),
          ...(notice ? { error: notice } : {}),
          volume: music.volume, repeatMode: repeats[music.repeatMode] ?? "none", shuffleMode: music.shuffleMode === 1,
        },
      };
    },
    tokens: () => ({ userToken: music.musicUserToken, storefront: music.storefrontId }),
    failed: text => { notice = text; },
    // A pause, a stop, or a move to another device means the listener stopped this music, so a
    // failure that arrives afterwards does not start it again.
    pause: () => { want(false); return music.pause(); },
    // Ends playback here and gives up Apple's stream, after the music moved to another device.
    stop: () => { want(false); return music.stop(); },
    resume: () => { want(true); return music.play(); },
    toggle: () => { const playing = music.playbackState === 2; want(!playing); return playing ? music.pause() : music.play(); },
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
      want(true);
      const waiting = pending().map(item => added.get(item));
      added = new WeakMap();
      await music.setQueue({ items: items.map(resource), startWith: index, startPlaying: true });
      if (waiting.length) await insert(waiting, music.queue.position + 1);
    },
    // Play next goes directly after the playing song. Otherwise the songs go after the other added
    // songs and before the rest of the collection. Songs added while nothing is queued start playing.
    enqueue: async (items, next) => {
      if (!music.queue.items.length) {
        want(true);
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
    move: (from, to, expected, target) => {
      if (expected && music.queue.items[from]?.id !== expected || target && music.queue.items[to]?.id !== target) throw new Error("The queue changed in another Peel. Try again.");
      if (Math.min(from, to) <= music.queue.position) return;
      const [entry] = music.queue.spliceQueueItems(from, 1);
      music.queue.spliceQueueItems(to, 0, [entry]);
    },
    // Apple's web player streams AAC at 256 kbps (high) or 64 kbps (standard). Returns the bitrate
    // MusicKit reports afterwards.
    quality: value => {
      const rates = MusicKit.PlaybackBitrate ?? { HIGH: 256, STANDARD: 64 };
      music.bitrate = value === "standard" ? rates.STANDARD : rates.HIGH;
      return music.bitrate;
    },
    remove: (index, expected) => {
      if (expected && music.queue.items[index]?.id !== expected) throw new Error("The queue changed in another Peel. Try again.");
      if (index > music.queue.position) music.queue.spliceQueueItems(index, 1);
    },
    jump: async (index, expected) => {
      want(true);
      if (expected && music.queue.items[index]?.id !== expected) throw new Error("The queue changed in another Peel. Try again.");
      await music.changeToMediaAtIndex(index);
    },
    queue: () => ({ position: music.queue.position, items: music.queue.items.map(item => ({ ...describe(item), added: pending().includes(item) })) }),
    // Only the songs the listener added and has not heard, with their places in the queue. The
    // Queue view shows nothing else, so the rest of the collection does not cross the network.
    added: (offset = 0, limit = 100) => {
      const position = music.queue.position, entries = music.queue.items.map((item, index) => ({ item, index })).filter(({ item, index }) => index > position && added.has(item));
      return { more: offset + limit < entries.length, items: entries.slice(offset, offset + limit).map(({ item, index }) => ({ ...describe(item), queueIndex: index })) };
    },
    position: () => ({ position: music.queue.position, total: music.queue.items.length }),
    // The whole queue, the playing place, and the position, so another device can continue it.
    exportPlayback: () => {
      const items = music.queue.items, position = music.queue.position;
      return {
        items: items.map(song), position,
        added: items.map((item, index) => index > position && added.has(item) ? index : -1).filter(index => index >= 0),
        time: music.currentPlaybackTime ?? 0, playing: music.playbackState === 2,
        repeatMode: repeats[music.repeatMode] ?? "none", shuffleMode: music.shuffleMode === 1,
      };
    },
    // Replaces this device's queue with one exported from another device. The volume stays this
    // device's own. A paused queue starts muted to reach its position, then pauses.
    // With cue, the queue is only set, as after reloading a player that stopped answering.
    importPlayback: async ({ items = [], position = 0, added: marks = [], time = 0, playing = false, repeatMode = "none", shuffleMode = false, cue = false } = {}) => {
      want(false);
      added = new WeakMap();
      if (!items.length) { await music.stop?.(); return; }
      const start = Math.min(Math.max(0, position), items.length - 1);
      music.shuffleMode = 0;
      await music.setQueue({ items: items.map(resource), startWith: start, startPlaying: false });
      // MusicKit leaves out songs it cannot play, which moves the rest. Each entry is matched to
      // the song it came from by ID, in order, for the added marks and the song to start with.
      const sources = [];
      let next = 0;
      for (const entry of music.queue.items) {
        let index = next;
        while (index < items.length && items[index].id !== entry.id) index++;
        if (index < items.length) next = index + 1;
        sources.push(index < items.length ? index : -1);
      }

      // If MusicKit gave its entries other IDs, nothing matches, and the queue is taken as it is.
      const matched = sources.some(index => index >= 0);
      const target = matched ? sources.findIndex(index => index >= start) : music.queue.position;
      music.queue.items.forEach((item, index) => { const source = matched ? sources[index] : index; if (marks.includes(source) && items[source]) added.set(item, items[source]); });
      music.repeatMode = Math.max(0, repeats.indexOf(repeatMode));
      if (cue) { if (shuffleMode) music.shuffleMode = 1; return; }
      const volume = music.volume;
      if (!playing) music.volume = 0;
      try {
        if (target >= 0 && target !== music.queue.position) await music.changeToMediaAtIndex(target);
        // The song to start with was left out, so its position does not apply to the next one.
        if (matched && sources[target] !== start) time = 0;
        want(playing);
        await music.play();
        if (time > 1) await music.seekToTime(time);
        if (!playing) await music.pause();
      } catch (error) {
        // A failed import stays silent, so the device that played can continue.
        await Promise.resolve(music.pause()).catch(() => {});
        throw error;
      } finally { music.volume = volume; }
      // Turning shuffle on mixes the songs after the playing one again.
      if (shuffleMode) music.shuffleMode = 1;
    },
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
    music.addEventListener("playbackTimeDidChange", remember);
    // Apple's player drops the song and stops when loading its audio fails, for example after a
    // short network outage. If music played a moment ago, the engine's main process reloads the
    // player and continues: at the same place, or with the next song when it failed at the end of one.
    music.addEventListener("mediaPlaybackError", event => {
      const code = event?.errorCode ?? event?.name ?? "", text = event?.message ?? event?.description ?? "";
      log(`playback error ${code} ${text}`.trim());
      if (code !== "NETWORK_ERROR" && text !== "loadSegmentError" || !last || Date.now() - last.at > 2500) return;
      const ended = last.duration > 0 && last.time >= last.duration - 2, count = music.queue.items.length;
      const position = !ended || music.repeatMode === 1 ? last.position : music.repeatMode === 2 ? (last.position + 1) % count : last.position + 1;
      if (position < count) console.log(`peel:recover ${JSON.stringify({ position, time: ended ? 0 : last.time })}`);
    });
    music.addEventListener("playbackStateDidChange", event => {
      const state = event?.state ?? music.playbackState;
      if (state === 2) notice = undefined;
      if (state === MusicKit.PlaybackStates?.stopped || state === 4) log(`playback stopped at ${Math.round(music.currentPlaybackTime ?? 0)}s of ${music.nowPlayingItem?.title ?? "nothing"}`);
    });
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
