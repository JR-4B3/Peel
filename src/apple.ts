import { cacheDir, readCache, saveJson } from "./config";
import { media, type ArtistPage, type Library, type Media, type Page } from "./types";

type Resource = Record<string, any>;

const collections = ["albums", "playlists", "library-albums", "library-playlists"];
const releaseWindow = 120 * 24 * 60 * 60 * 1000;
// Apple's artist views, in the order the artist page shows them.
const artistViews = [
  ["full-albums", "Albums"], ["singles", "Singles and EPs"], ["live-albums", "Live albums"],
  ["compilation-albums", "Compilations"], ["appears-on-albums", "Appears on"],
];

interface Cached { token: string; expires: number }

function claims(token: string): Resource | undefined {
  try { return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()); } catch { return undefined; }
}

// music.apple.com's web player embeds its developer token in the main script.
// Apple accepts it from the web player's origin, so no developer membership is needed.
async function scrapeToken(): Promise<Cached> {
  const page = await (await fetch("https://music.apple.com/us/new", { signal: AbortSignal.timeout(15000) })).text();
  const script = page.match(/\/assets\/index[^"'\s]*\.js/)?.[0];
  if (!script) throw new Error("Could not find Apple Music's web player script.");
  const source = await (await fetch(`https://music.apple.com${script}`, { signal: AbortSignal.timeout(30000) })).text();
  // The script holds several JWTs. Only the web player's own token is accepted.
  for (const token of source.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? []) {
    const value = claims(token);
    if (value?.iss === "AMPWebPlay" && typeof value.exp === "number") return { token, expires: value.exp * 1000 };
  }
  throw new Error("Apple Music's web player script no longer contains its developer token.");
}

let pending: Promise<string> | undefined;

// Reuse the cached token until a day before it expires. Concurrent requests share one refresh.
export function webPlayerToken(refresh = false, dir = cacheDir): Promise<string> {
  if (pending) return pending;
  pending = (async () => {
    const cached = refresh ? undefined : await readCache<Cached>("apple-developer-token.json", dir);
    if (cached?.token && cached.expires - Date.now() > 24 * 60 * 60 * 1000) return cached.token;
    const fresh = await scrapeToken();
    await saveJson("apple-developer-token.json", fresh, dir).catch(() => {});
    return fresh.token;
  })().finally(() => { pending = undefined; });
  return pending;
}

export interface AppleOptions {
  base?: string;
  developerToken?: (refresh: boolean) => Promise<string>;
  storefront?: string;
  // Asks the playback engine for a current Music User Token after Apple rejects the saved one.
  renewUser?: () => Promise<string | undefined>;
}

export class AppleMusic implements Library {
  readonly base: string;
  private developerToken: (refresh: boolean) => Promise<string>;
  private storefront?: Promise<string>;
  private renewing?: Promise<string | undefined>;

  constructor(private userToken: string, private options: AppleOptions = {}) {
    this.base = options.base ?? process.env.APPLE_MUSIC_API_BASE ?? "https://api.music.apple.com";
    this.developerToken = options.developerToken ?? (refresh => webPlayerToken(refresh));
    if (options.storefront) this.storefront = Promise.resolve(options.storefront);
  }

  private async fetch(path: string, developer: string) {
    try {
      return await fetch(`${this.base.replace(/\/$/, "")}/${path}`, {
        headers: { Authorization: `Bearer ${developer}`, "Music-User-Token": this.userToken, Origin: "https://music.apple.com" },
        signal: AbortSignal.timeout(35000),
      });
    } catch { throw new Error("Cannot reach Apple Music. Check the network connection."); }
  }

  // Apple answers 401 for a stale developer token and 403 for a stale user token.
  // Each is renewed once per request, so a lasting rejection cannot loop.
  async request(path: string): Promise<Resource> {
    this.userToken ||= await this.renewUser() ?? "";
    if (!this.userToken) throw new Error("Peel has no Apple Music sign-in. Run bun run connect.");
    path = path.replace("$STOREFRONT", await this.storefrontId(path));
    let response = await this.fetch(path, await this.developerToken(false));
    if (response.status === 401) response = await this.fetch(path, await this.developerToken(true));
    if (response.status === 401 || response.status === 403) {
      const token = await this.renewUser();
      if (token && token !== this.userToken) { this.userToken = token; response = await this.fetch(path, await this.developerToken(false)); }
    }
    if (response.status === 401 || response.status === 403) throw new Error("Apple Music rejected Peel's sign-in. Open Cider, then run bun run connect.");
    if (response.status === 404) return { data: [] };
    if (!response.ok) throw new Error(`Apple Music returned HTTP ${response.status}.`);
    return await response.json();
  }

  // Concurrent rejections share one renewal, so the saved sign-in is written once.
  private renewUser(): Promise<string | undefined> {
    if (!this.options.renewUser) return Promise.resolve(undefined);
    return this.renewing ??= this.options.renewUser().catch(() => undefined).finally(() => { this.renewing = undefined; });
  }

  private storefrontId(path: string): Promise<string> {
    if (!path.includes("$STOREFRONT")) return Promise.resolve("");
    this.storefront ??= this.request("v1/me/storefront").then(response => {
      const id = response.data?.[0]?.id;
      if (!id) throw new Error("Apple Music did not report the account's country.");
      return String(id);
    });
    // A failed lookup must be retried on the next request.
    return this.storefront.catch(error => { this.storefront = undefined; throw error; });
  }

  async playlists(): Promise<Media[]> {
    // The extended listing includes Apple's "favorited" tag for Favourite Songs.
    const items: Media[] = [];
    let path = "v1/me/library/playlists?limit=100&extend[library-playlists]=tags";
    const visited = new Set<string>();
    while (path && !visited.has(path)) {
      visited.add(path);
      const response = await this.request(path);
      items.push(...(response.data ?? []).map((item: Resource) => media(item, "library-playlists")));
      path = response.next ? String(response.next).replace(/^\//, "") : "";
      if (path && !path.startsWith("v1/")) throw new Error("Apple Music returned an unsupported playlist pagination path.");
    }
    return items;
  }

  async recent(): Promise<Media[]> {
    // Apple serves recently played collections ten at a time.
    const pages = await Promise.all([0, 10].map(offset => this.request(`v1/me/recent/played?limit=10&offset=${offset}`)));
    const items = pages.flatMap(page => page.data ?? []).filter((item: Resource) => collections.includes(item.type));
    return [...new Map(items.map((item: Resource) => [item.id, media(item)])).values()];
  }

  async releases(): Promise<Media[]> {
    // Favourite artists are library artists with Apple's inFavorites flag. Pagination
    // links drop the extend parameter, so request each offset explicitly.
    const scan = (offset: number) => this.request(`v1/me/library/artists?limit=100&offset=${offset}&extend=inFavorites&include=catalog`);
    const first = await scan(0);
    const offsets = Array.from({ length: Math.max(0, Math.ceil((first.meta?.total ?? 0) / 100) - 1) }, (_, index) => (index + 1) * 100);
    const artists = [first, ...await Promise.all(offsets.map(scan))].flatMap(page => page.data ?? [])
      .filter((artist: Resource) => artist.attributes?.inFavorites)
      .map((artist: Resource) => artist.relationships?.catalog?.data?.[0]?.id).filter(Boolean);
    const batches = Array.from({ length: Math.ceil(artists.length / 25) }, (_, index) => artists.slice(index * 25, index * 25 + 25));
    const catalog = await Promise.all(batches.map(ids => this.request(`v1/catalog/$STOREFRONT/artists?ids=${ids.join(",")}&views=latest-release`)));
    const since = Date.now() - releaseWindow;
    const releases = catalog.flatMap(page => page.data ?? []).flatMap((artist: Resource) => artist.views?.["latest-release"]?.data ?? [])
      .map((item: Resource) => media(item, "albums")).filter((item: Media) => Date.parse(item.releaseDate ?? "") >= since);
    return [...new Map(releases.map((item: Media) => [item.id, item])).values()]
      .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")).slice(0, 48);
  }

  private async page(path: string, type: string, offset: number): Promise<Page> {
    const response = await this.request(`${path}${path.includes("?") ? "&" : "?"}offset=${offset}&limit=100`);
    return { items: (response.data ?? []).map((item: Resource) => media(item, type)), more: !!response.next };
  }

  playlist(id: string, offset = 0) { return this.page(`v1/catalog/$STOREFRONT/playlists/${encodeURIComponent(id)}/tracks`, "songs", offset); }
  songs(id?: string, offset = 0) { return this.page(id ? `v1/me/library/playlists/${encodeURIComponent(id)}/tracks` : "v1/me/library/songs", "library-songs", offset); }
  albums(offset = 0) { return this.page("v1/me/library/albums", "library-albums", offset); }
  album(id: string, offset = 0) {
    return id.startsWith("l.") ? this.page(`v1/me/library/albums/${encodeURIComponent(id)}/tracks`, "library-songs", offset)
      : this.page(`v1/catalog/$STOREFRONT/albums/${encodeURIComponent(id)}/tracks`, "songs", offset);
  }

  async search(term: string): Promise<Media[]> {
    if (!term.trim()) return [];
    const response = await this.request(`v1/catalog/$STOREFRONT/search?${new URLSearchParams({ term, types: "artists,songs,albums", limit: "25" })}`);
    const results = (type: string) => (response.results?.[type]?.data ?? []).map((item: Resource) => media(item, type));
    return [...results("songs"), ...results("albums"), ...results("artists")];
  }

  // Library artists carry their catalog artist, which has the photo and the artist page.
  async artists(offset = 0): Promise<Page> {
    // Pagination links drop the include parameter, so request each offset explicitly.
    const response = await this.request(`v1/me/library/artists?limit=100&offset=${offset}&include=catalog`);
    const items = (response.data ?? []).map((artist: Resource) => {
      const catalog = artist.relationships?.catalog?.data?.[0];
      return catalog?.attributes ? { ...media(catalog, "artists"), name: artist.attributes?.name ?? catalog.attributes.name } : media(artist, "library-artists");
    });
    return { items, more: !!response.next };
  }

  // Songs and albums link to their artists. Library items reach them through the
  // catalog. Uploads and other unlinked items fall back to a search by name.
  async artistId(item: Media): Promise<string | undefined> {
    if (item.type === "artists") return item.id;
    const name = item.type === "library-artists" ? item.name : item.artist;
    let artists: Resource[] = [];
    try {
      if (item.type === "library-artists") artists = (await this.request(`v1/me/library/artists/${encodeURIComponent(item.id)}/catalog`)).data ?? [];
      else if (/^\d+$/.test(item.id)) artists = (await this.request(`v1/catalog/$STOREFRONT/${item.type.includes("album") ? "albums" : "songs"}/${item.id}/artists`)).data ?? [];
      else if (/^[il]\./.test(item.id)) {
        const linked = (await this.request(`v1/me/library/${item.id.startsWith("l.") ? "albums" : "songs"}/${encodeURIComponent(item.id)}/artists?include=catalog`)).data ?? [];
        artists = linked.map((artist: Resource) => artist.relationships?.catalog?.data?.[0]).filter(Boolean);
      }
    } catch {}
    // Collaborations list every artist. Prefer the one named in the credit.
    const linked = artists.find(artist => artist.attributes?.name === name) ?? artists[0];
    if (linked) return String(linked.id);
    if (!name) return undefined;
    const found = (await this.request(`v1/catalog/$STOREFRONT/search?${new URLSearchParams({ term: name, types: "artists", limit: "5" })}`)).results?.artists?.data ?? [];
    return (found.find((artist: Resource) => artist.attributes?.name?.toLowerCase() === name.toLowerCase()) ?? found[0])?.id;
  }

  // Apple has no per-listener play counts. Top songs are the artist's most played songs on Apple Music.
  async artist(id: string): Promise<ArtistPage> {
    const path = `v1/catalog/$STOREFRONT/artists/${encodeURIComponent(id)}`;
    const [info, top, ...views] = await Promise.all([
      this.request(path), this.request(`${path}/view/top-songs?limit=20`),
      // A view the storefront does not offer must not hide the rest of the page.
      ...artistViews.map(([view]) => this.view(`${path}/view/${view}`).catch(() => [])),
    ]);
    const artist = info.data?.[0];
    if (!artist) throw new Error("Apple Music returned no artist page.");
    return {
      artist: media(artist, "artists"),
      top: (top.data ?? []).map((item: Resource) => media(item)),
      shelves: artistViews.map(([id, title], index) => ({ id, title, items: views[index].map((item: Resource) => media(item, "albums")) })),
    };
  }

  // View links drop the limit, so request each offset explicitly. Three pages cover nearly every discography.
  private async view(path: string): Promise<Resource[]> {
    const items: Resource[] = [];
    for (let offset = 0; offset < 300; offset += 100) {
      const response = await this.request(`${path}?limit=100&offset=${offset}`);
      items.push(...response.data ?? []);
      if (!response.next) break;
    }
    return items;
  }
}
