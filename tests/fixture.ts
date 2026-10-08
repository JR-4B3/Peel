import { Cider } from "../src/cider";
import { stopped, type Playback } from "../src/types";

// Serve Cider's actual v2 envelopes, including flat library items and native Apple results.
export function fixture(options: { waitForDecoder?: boolean } = {}) {
  const playback: Playback = { ...structuredClone(stopped), nowPlaying: { name: "Soma", artistName: "Skrillex" }, time: { currentTime: 30, duration: 200 } };
  const calls: { path: string; method: string; body: any }[] = [];
  const song = { id: "i.soma", name: "Soma", artistName: "Skrillex", albumName: "SOMA", durationMs: 200000 };
  const collection = [song,
    { ...song, id: "i.selected", name: "Selected song" },
    { ...song, id: "i.last", name: "Last song" },
  ];
  let queue = collection.map(item => ({ track: { id: item.id, type: "songs", attributes: item } }));
  let position = 1;
  const audible: string[] = [];
  let rating = 0;
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
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname.replace("/api/v2", "");
    if (request.headers.get("apptoken") !== "test-token") return Response.json({ error: "UNAUTHORIZED_APP_TOKEN" }, { status: 403 });
    const body = request.method === "GET" ? undefined : await request.json();
    calls.push({ path, method: request.method, body });
    let data: any = {};
    if (path === "/playback") data = { ...playback, nowPlaying: playback.nowPlaying && { ...playback.nowPlaying, inFavorites: rating === 1 } };
    else if (path === "/playback/toggle") playback.state = playback.state === "playing" ? "paused" : "playing";
    else if (path === "/playback/pause") playback.state = "paused";
    else if (path === "/playback/play") playback.state = "playing";
    else if (path === "/playback/play-item") {
      const item = collection.find(item => item.id === body.id) ?? { ...song, id: body.id, name: "Search result" };
      queue = [{ track: { id: item.id, type: "songs", attributes: item } }]; position = 0;
      playback.state = "playing"; playback.nowPlaying = { name: item.name, artistName: item.artistName, albumName: item.albumName };
      playback.time.currentTime = options.waitForDecoder ? 0 : 1;
      audible.push(item.id);
    }
    else if (path === "/playback/play-collection") {
      queue = collection.map(item => ({ track: { id: item.id, type: "songs", attributes: item } })); position = 0;
      playback.nowPlaying = { name: song.name, artistName: song.artistName };
      audible.push(song.id);
    }
    else if (path === "/queue/add-later") queue.push(...collection.map(item => ({ track: { id: item.id, type: "songs", attributes: item } })));
    else if (path.startsWith("/queue/items/") && request.method === "DELETE") queue.splice(Number(path.split("/").at(-1)), 1);
    else if (path === "/queue/move") {
      const playing = queue[position]; const [item] = queue.splice(body.from, 1); queue.splice(body.to, 0, item);
      position = queue.indexOf(playing);
    }
    else if (path === "/queue/jump") {
      position = body.index;
      const item = queue[position]?.track;
      if (item) { playback.nowPlaying = { name: item.attributes.name, artistName: item.attributes.artistName }; audible.push(item.id); }
    }
    else if (path === "/playback/seek") playback.time.currentTime = body.position;
    else if (path === "/audio/volume") playback.volume = body.volume;
    else if (path === "/playback/shuffle/toggle") playback.shuffleMode = !playback.shuffleMode;
    else if (path === "/playback/shuffle") playback.shuffleMode = body.enabled;
    else if (path === "/playback/repeat/toggle") playback.repeatMode = playback.repeatMode === "none" ? "one" : "none";
    else if (path === "/amapi/raw/v1/me/library/playlists") data = { data: [
      { id: "p.chill", type: "library-playlists", attributes: { name: "Background Chill" } },
      { id: "p.favourites", type: "library-playlists", attributes: { name: "Lieblingstitel", ...(url.searchParams.get("extend[library-playlists]") === "tags" ? { tags: ["favorited"] } : {}) } },
    ] };
    else if (path === "/library/now-playing/rating") rating = request.method === "PUT" ? body.rating : 0;
    else if (path === "/library/now-playing/status") data = { inLibrary: false, rating };
    else if (path === "/amapi/raw/v1/me/recent/played") data = Number(url.searchParams.get("offset")) ? { data: [] } : { data: [
      album("a.soma", "SOMA", "Skrillex"), { id: "st.radio", type: "stations", attributes: { name: "Radio" } },
      { id: "pl.mix", type: "playlists", attributes: { name: "Favourites Mix", curatorName: "Apple Music" } },
    ] };
    else if (path === "/amapi/raw/v1/me/library/artists") data = Number(url.searchParams.get("offset")) ? { data: [] } : { meta: { total: 2 }, data: [
      { id: "r.one", attributes: { name: "Skrillex", inFavorites: url.searchParams.get("extend") === "inFavorites" }, relationships: { catalog: { data: [skrillex] } } },
      { id: "r.two", attributes: { name: "Other", inFavorites: false }, relationships: { catalog: { data: [{ id: "200" }] } } },
    ] };
    else if (path === "/amapi/raw/v1/catalog/$STOREFRONT/artists") data = { data: (url.searchParams.get("ids") ?? "").split(",").map(id => ({ id, views: { "latest-release": { data: [
      id === "100" ? album("a.new", "Fresh Album", "Skrillex", recent) : album("a.old", "Old Album", "Other", "2020-01-01"),
      ...(id === "100" ? [album("a.soon", "Coming Soon", "Skrillex", soon)] : []),
    ] } } })) };
    else if (path === "/amapi/raw/v1/catalog/$STOREFRONT/artists/100") data = { data: [skrillex] };
    else if (path.startsWith("/amapi/raw/v1/catalog/$STOREFRONT/artists/100/view/")) data = { data: artistViews[path.split("/").at(-1)!] ?? [] };
    else if (path === "/amapi/raw/v1/me/library/albums/l.soma/artists") data = { data: [{ id: "r.one", type: "library-artists", relationships: { catalog: { data: [skrillex] } } }] };
    else if (path === "/amapi/raw/v1/catalog/$STOREFRONT/playlists/pl.mix/tracks") data = { data: collection.map(item => ({ id: item.id, type: "songs", attributes: item })) };
    else if (path === "/amapi/search" && url.searchParams.get("types") === "artists") data = { results: { artists: { data: url.searchParams.get("term") === "Skrillex" ? [skrillex] : [] } } };
    else if (path === "/amapi/search") data = { results: { artists: { data: [skrillex] }, songs: { data: [{ id: "123", type: "songs", attributes: { name: "Search result", artistName: "Artist", durationInMillis: 180000 } }] }, albums: { data: [{ id: "456", type: "albums", attributes: { name: "An album", artistName: "Artist" } }] } } };
    else if (path === "/queue") {
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
      data = { items: queue.slice(offset, offset + limit), position, total: queue.length };
    }
    else if (path === "/queue/position") data = { position, total: queue.length };
    else if (path === "/library/albums") data = { items: [
      { id: "l.soma", name: "SOMA", artistName: "Skrillex", trackCount: 3, releaseDate: "2026-01-01" },
      { id: "l.other", name: "Other Album", artistName: "Other", trackCount: 3 },
    ] };
    else if (path.startsWith("/library/")) data = { items: collection };
    return Response.json({ data, meta: { offset: 0, limit: 100, total: data.items?.length ?? 0 } });
  } });
  return { server, playback, calls, audible, beginPlayback: () => { playback.time.currentTime = 1; }, player: new Cider(`http://127.0.0.1:${server.port}`, "test-token") };
}
