import { AppleMusic } from "../src/apple";
import { Engine } from "../src/engine";
import { stopped, type Media, type Playback } from "../src/types";

// Apple Music's native JSON for the library, and a stand-in for Peel's playback engine that keeps
// its queue the way engine/engine.js does. Nothing reaches Apple or starts a real engine.
// version names the engine that answers, such as "hires" for the hi-res host.
export function fixture(options: { queueDelay?: number; silentRating?: boolean; version?: string } = {}) {
  const playback: Playback = { ...structuredClone(stopped), nowPlaying: { name: "Soma", artistName: "Skrillex" }, time: { currentTime: 30, duration: 200 } };
  // Requests to Apple Music, and the engine methods Peel called with their arguments.
  const calls: { path: string; method: string; body: any }[] = [];
  const commands: { method: string; args: any[] }[] = [];
  const song = { id: "i.soma", name: "Soma", artistName: "Skrillex", albumName: "SOMA", durationMs: 200000 };
  const collection = [song,
    { ...song, id: "i.selected", name: "Selected song" },
    { ...song, id: "i.last", name: "Last song" },
  ];
  // The engine's queue: each entry, and whether the listener added it.
  interface Entry { id: string; type: string; name: string; artist: string; album: string; duration: number; added: boolean }
  const entry = (item: Pick<Media, "id" | "type"> & Partial<Media>, added = false): Entry => ({
    id: item.id, type: item.type, name: item.name ?? item.id, artist: item.artist ?? "", album: item.album ?? "", duration: item.duration ?? 200, added,
  });
  let queue: Entry[] = collection.map(item => entry({ id: item.id, type: "library-songs", name: item.name, artist: item.artistName, album: item.albumName }));
  let position = 0;
  // The songs that started playing, in order.
  const audible: string[] = [];
  let rating = 0;
  // Rated albums, by the id in their rating path.
  const lovedAlbums = new Set<string>();
  const album = (id: string, name: string, artistName: string, releaseDate = "2026-01-01") => ({ id, type: "albums", attributes: { name, artistName, releaseDate, trackCount: 3 } });
  const skrillex = { id: "100", type: "artists", attributes: { name: "Skrillex", genreNames: ["Dance"] } };
  const top = [1, 2, 3, 4, 5, 6].map(n => ({ id: `t${n}`, type: "songs", attributes: { name: `Top song ${n}`, artistName: "Skrillex", albumName: "SOMA", durationInMillis: 180000 } }));
  const artistViews: Record<string, unknown[]> = {
    "top-songs": top, "full-albums": [album("a.soma", "SOMA", "Skrillex")],
    singles: [album("a.single", "CONTRABAND - Single", "Naisha, Skrillex, BEAM & Dilip")],
    "appears-on-albums": [album("a.guest", "Guest Spot", "Someone Else")],
  };
  const soon = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
  const songs = collection.map(item => ({ id: item.id, type: "library-songs", attributes: { ...item, durationInMillis: item.durationMs } }));
  const apple = (request: Request, url: URL, path: string) => {
    if (request.headers.get("authorization") !== "Bearer dev-token" || request.headers.get("origin") !== "https://music.apple.com") return Response.json({ errors: [] }, { status: 401 });
    if (request.headers.get("music-user-token") !== "user-token") return Response.json({ errors: [] }, { status: 403 });
    calls.push({ path, method: request.method, body: undefined });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    let data: any = { data: [] };
    if (path === "/v1/me/storefront") data = { data: [{ id: "de", type: "storefronts" }] };
    else if (path === "/v1/me/library/playlists") data = { data: [
      { id: "p.chill", type: "library-playlists", attributes: { name: "Background Chill" } },
      { id: "p.favourites", type: "library-playlists", attributes: { name: "Lieblingstitel", ...(url.searchParams.get("extend[library-playlists]") === "tags" ? { tags: ["favorited"] } : {}) } },
    ] };
    else if (path === "/v1/me/recent/played") data = offset ? { data: [] } : { data: [
      album("a.soma", "SOMA", "Skrillex"), { id: "st.radio", type: "stations", attributes: { name: "Radio" } },
      { id: "pl.mix", type: "playlists", attributes: { name: "Favourites Mix", curatorName: "Apple Music" } },
    ] };
    else if (path === "/v1/me/library/artists") data = offset ? { data: [] } : { meta: { total: 2 }, data: [
      { id: "r.one", type: "library-artists", attributes: { name: "Skrillex", inFavorites: url.searchParams.get("extend") === "inFavorites" }, relationships: { catalog: { data: [skrillex] } } },
      { id: "r.two", type: "library-artists", attributes: { name: "Other", inFavorites: false }, relationships: { catalog: { data: [{ id: "200" }] } } },
    ] };
    else if (path === "/v1/catalog/de/artists") data = { data: (url.searchParams.get("ids") ?? "").split(",").map(id => ({ id, views: { "latest-release": { data: [
      id === "100" ? album("a.new", "Fresh Album", "Skrillex", recent) : album("a.old", "Old Album", "Other", "2020-01-01"),
      ...(id === "100" ? [album("a.soon", "Coming Soon", "Skrillex", soon)] : []),
    ] } } })) };
    else if (path === "/v1/catalog/de/artists/100") data = { data: [skrillex] };
    else if (path.startsWith("/v1/catalog/de/artists/100/view/")) {
      const view = artistViews[path.split("/").at(-1)!];
      if (!view) return Response.json({ errors: [{ status: "404" }] }, { status: 404 });
      data = { data: view };
    }
    else if (path === "/v1/me/library/albums/l.soma/artists") data = { data: [{ id: "r.one", type: "library-artists", relationships: { catalog: { data: [skrillex] } } }] };
    else if (path === "/v1/catalog/de/playlists/pl.mix/tracks") data = { data: collection.map(item => ({ id: item.id, type: "songs", attributes: item })) };
    else if (path === "/v1/catalog/de/search" && url.searchParams.get("types") === "artists") data = { results: { artists: { data: url.searchParams.get("term") === "Skrillex" ? [skrillex] : [] } } };
    else if (path === "/v1/catalog/de/search") data = { results: { artists: { data: [skrillex] }, songs: { data: [{ id: "123", type: "songs", attributes: { name: "Search result", artistName: "Artist", durationInMillis: 180000 } }] }, albums: { data: [{ id: "456", type: "albums", attributes: { name: "An album", artistName: "Artist" } }] } } };
    else if (path === "/v1/me/library/albums") data = { data: [
      { id: "l.soma", type: "library-albums", attributes: { name: "SOMA", artistName: "Skrillex", trackCount: 3, releaseDate: "2026-01-01" } },
      { id: "l.other", type: "library-albums", attributes: { name: "Other Album", artistName: "Other", trackCount: 3 } },
    ] };
    else if (path === "/v1/me/library/albums/l.soma/catalog") data = { data: [{ id: "1440", type: "albums" }] };
    else if (path === "/v1/me/library/albums/l.other/catalog") data = { data: [] };
    else if (/^\/v1\/me\/ratings\/(library-)?albums/.test(path)) {
      const id = path.split("/")[5];
      if (request.method === "PUT") lovedAlbums.add(id!);
      else if (request.method === "DELETE") { lovedAlbums.delete(id!); return new Response(null, { status: 204 }); }
      else data = { data: (url.searchParams.get("ids") ?? "").split(",").filter(id => lovedAlbums.has(id)).map(id => ({ id, type: "ratings", attributes: { value: 1 } })) };
    }
    else if (path.startsWith("/v1/me/ratings/")) {
      // Only "Selected song" is a favourite.
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      data = { data: ids.filter(id => id === "i.selected").map(id => ({ id, type: "ratings", attributes: { value: 1 } })) };
    }
    else if (path.startsWith("/v1/me/library/")) data = { data: songs };
    return Response.json(data);
  };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) return apple(request, url, url.pathname);
    return Response.json({ errors: [] }, { status: 404 });
  } });

  const start = (index: number) => {
    position = index;
    const item = queue[position];
    if (!item) return;
    playback.state = "playing"; playback.time.currentTime = 0;
    playback.nowPlaying = { name: item.name, artistName: item.artist, albumName: item.album, playParams: { id: item.id } };
    audible.push(item.id);
  };
  const pending = () => queue.slice(position + 1).filter(item => item.added);
  const expect = (index: number, id?: string) => {
    if (id && queue[index]?.id !== id) throw new Error("The queue changed in another Peel. Try again.");
  };
  const methods: Record<string, (...args: any[]) => unknown> = {
    pause: () => { playback.state = "paused"; },
    resume: () => { playback.state = "playing"; },
    toggle: () => { playback.state = playback.state === "playing" ? "paused" : "playing"; },
    next: () => { if (position + 1 < queue.length) start(position + 1); },
    previous: () => { if (position > 0) start(position - 1); },
    seek: (time: number) => { playback.time.currentTime = time; },
    volume: (value: number) => { playback.volume = Math.min(1, Math.max(0, value)); },
    shuffle: (enabled: boolean) => { playback.shuffleMode = enabled; },
    toggleShuffle: () => { playback.shuffleMode = !playback.shuffleMode; },
    toggleRepeat: () => { playback.repeatMode = playback.repeatMode === "none" ? "one" : playback.repeatMode === "one" ? "all" : "none"; },
    play: (items: Media[], index = 0) => {
      const waiting = pending();
      queue = items.map(item => entry(item));
      queue.splice(index + 1, 0, ...waiting);
      start(index);
    },
    enqueue: async (items: Media[], next: boolean) => {
      await Bun.sleep(options.queueDelay ?? 0);
      if (!queue.length) { queue = items.map((item, index) => entry(item, index > 0)); start(0); return; }
      let at = position + 1;
      if (!next) while (queue[at]?.added) at++;
      queue.splice(at, 0, ...items.map(item => entry(item, true)));
    },
    move: (from: number, to: number, id?: string, target?: string) => {
      expect(from, id); expect(to, target);
      if (Math.min(from, to) <= position) return;
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item!);
    },
    remove: (index: number, id?: string) => { expect(index, id); if (index > position) queue.splice(index, 1); },
    jump: (index: number, id?: string) => { expect(index, id); start(index); },
    added: (offset = 0, limit = 100) => {
      const entries = queue.map((item, index) => ({ item, index })).filter(({ item, index }) => index > position && item.added);
      return { more: offset + limit < entries.length, items: entries.slice(offset, offset + limit).map(({ item, index }) => ({
        id: item.id, type: item.type, attributes: { name: item.name, artistName: item.artist, albumName: item.album, durationInMillis: item.duration * 1000 }, queueIndex: index,
      })) };
    },
    position: () => ({ position, total: queue.length }),
    rating: () => rating,
    rate: (value: number, id?: string) => {
      if (id && playback.nowPlaying?.playParams?.id && playback.nowPlaying.playParams.id !== id) throw new Error("The playing song changed. Nothing was rated.");
      rating = value;
    },
    quality: () => 256,
    tokens: () => ({ userToken: "user-token", storefront: "de" }),
  };
  const transport = async (path: string, body?: any) => {
    if (path === "/state") return {
      ready: true, signIn: false, version: options.version ?? "fixture", instance: "fixture",
      playback: { ...structuredClone(playback), nowPlaying: playback.nowPlaying && { ...playback.nowPlaying, inFavorites: options.silentRating ? undefined : rating === 1 } },
    };
    if (path === "/release" || path === "/retain") return null;
    const { method, args = [] } = body ?? {};
    const run = methods[method];
    if (path !== "/call" || !run) throw new Error(`The fixture engine has no method ${method}.`);
    commands.push({ method, args: structuredClone(args) });
    return await run(...args) ?? null;
  };
  return { server, playback, calls, commands, audible, lovedAlbums, queue: () => queue, player: new Engine("/nonexistent", transport),
    library: new AppleMusic("user-token", { base: `http://127.0.0.1:${server.port}`, developerToken: async () => "dev-token", favouriteVersions: false }) };
}
