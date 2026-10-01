import type { Media, Page, Playback, Player } from "./types";

type Resource = Record<string, any>;
interface Envelope { data: any; meta?: { offset: number; limit: number; total?: number }; error?: string | { code: string; message?: string } }

export function media(item: Resource, type = "songs"): Media {
  const resource = item.track ?? item;
  const attrs = resource.attributes ?? resource;
  return {
    id: String(resource.id), type: resource.type ?? type,
    name: attrs.name ?? "Untitled", artist: attrs.artistName ?? "", album: attrs.albumName ?? "",
    duration: (attrs.durationInMillis ?? attrs.durationMs ?? 0) / 1000,
    favourite: attrs.tags?.includes("favorited") ?? false,
  };
}

export class Cider implements Player {
  constructor(readonly base = process.env.CIDER_API_BASE ?? "http://127.0.0.1:10767", private token = "") {}

  async request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", timeout = 35000): Promise<Envelope> {
    let response: Response;
    try {
      response = await fetch(`${this.base.replace(/\/$/, "")}/api/v2${path}`, {
        method, headers: { apptoken: this.token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new Error("Cannot reach Cider. Start Cider and check CIDER_API_BASE.");
    }
    let result: Envelope;
    try { result = await response.json(); }
    catch { throw new Error(`Cider returned HTTP ${response.status}. Peel requires Cider's v2 API.`); }
    if (!response.ok || result.error) {
      const code = typeof result.error === "string" ? result.error : result.error?.code;
      if (code === "UNAUTHORIZED_APP_TOKEN") throw new Error("Connect to Cider first: bun run connect. Approve Peel in Cider.");
      if (code === "INSUFFICIENT_SCOPE") throw new Error("Cider denied this permission. Reconnect and grant playback, queue, library, and audio.");
      throw new Error(typeof result.error === "object" ? result.error.message ?? result.error.code : code ?? `Cider returned HTTP ${response.status}`);
    }
    return result;
  }

  async connect(): Promise<{ token: string; scopes: string[] }> {
    return (await this.request("/auth/request", {
      app_name: "Peel", scopes: ["playback", "queue", "library", "audio"],
    }, "POST", 125000)).data;
  }

  async snapshot(): Promise<Playback> { return (await this.request("/playback")).data; }

  async playlists(): Promise<Media[]> {
    // The raw listing preserves Apple's "favorited" tag, unlike Cider's flattened list.
    const items: Media[] = [];
    let path = "v1/me/library/playlists?limit=100&extend[library-playlists]=tags";
    const visited = new Set<string>();
    while (path && !visited.has(path)) {
      visited.add(path);
      const response = (await this.request(`/amapi/raw/${path}`)).data;
      items.push(...(response.data ?? []).map((item: Resource) => media(item, "library-playlists")));
      path = response.next ? String(response.next).replace(/^\//, "") : "";
      if (path && !path.startsWith("v1/")) throw new Error("Cider returned an unsupported playlist pagination path.");
    }
    return items;
  }

  async search(term: string): Promise<Media[]> {
    if (!term.trim()) return [];
    const response = (await this.request(`/amapi/search?${new URLSearchParams({ term, types: "songs,albums", limit: "25" })}`)).data;
    return ["songs", "albums"].flatMap(type => (response.results?.[type]?.data ?? []).map((item: Resource) => media(item, type)));
  }

  private async page(path: string, type: string, offset: number, limit = 100): Promise<Page> {
    const response = await this.request(`${path}?offset=${offset}&limit=${limit}`);
    const items = (response.data.items ?? []).map((item: Resource, index: number) => ({
      ...media(item, type), ...(path === "/queue" ? { queueIndex: offset + index } : {}),
    }));
    // Some Cider versions report a page count as total when Apple omits meta.total.
    // A full page must therefore remain loadable until a short page is returned.
    return { items, more: items.length === limit || offset + items.length < (response.meta?.total ?? 0) };
  }

  songs(id?: string, offset = 0) { return this.page(id ? `/library/playlists/${encodeURIComponent(id)}/songs` : "/library/songs", "library-songs", offset); }
  albums(offset = 0) { return this.page("/library/albums", "library-albums", offset); }
  async album(id: string, offset = 0): Promise<Page> {
    if (id.startsWith("l.")) return this.page(`/library/albums/${encodeURIComponent(id)}/songs`, "library-songs", offset);
    const response = (await this.request(`/amapi/raw/v1/catalog/$STOREFRONT/albums/${encodeURIComponent(id)}/tracks?offset=${offset}&limit=100`)).data;
    return { items: (response.data ?? []).map((item: Resource) => media(item)), more: !!response.next };
  }
  queue(offset = 0) { return this.page("/queue", "songs", offset); }
  async queuePosition(): Promise<{ position: number; total: number }> { return (await this.request("/queue/position")).data; }
  async command(path: string, body: unknown = {}, method = "POST") { await this.request(path, body, method); }

  async playCollectionTrack(collection: { id: string; type: string }, track: Media, index: number) {
    const matches = (resource: Resource | undefined) => {
      if (!resource) return false;
      const item = resource.track ?? resource, attrs = item.attributes ?? item;
      const ids = [item.id, attrs.playParams?.id, attrs.playParams?.catalogId, attrs.playParams?.libraryId];
      return ids.includes(track.id) || attrs.name === track.name && attrs.artistName === track.artist && attrs.albumName === track.album;
    };
    const at = async (position: number) => (await this.request(`/queue?offset=${position}&limit=1`)).data.items?.[0];
    const wait = async (check: () => Promise<boolean>, description: string) => {
      const until = Date.now() + 20000;
      do {
        if (await check()) return;
        await Bun.sleep(100);
      } while (Date.now() < until);
      throw new Error(`Cider did not confirm ${description}. The selected song was started directly.`);
    };

    // Starting the collection plays its first track before a later queue jump,
    // and Cider can switch metadata before switching audio. Start only the
    // requested song, then build its surrounding queue without another play.
    await this.command("/playback/shuffle", { enabled: false }, "PUT");
    await this.command("/playback/play-item", { id: track.id, type: track.type });
    await wait(async () => (await this.queuePosition()).total === 1 && matches(await at(0)), "the selected song's queue");
    // Cider acknowledges play-item before its decoder has started. Do not
    // rearrange the queue while that initial playback request is still loading.
    await wait(async () => {
      const value = await this.snapshot();
      return value.state === "playing" && value.nowPlaying?.name === track.name &&
        value.time.currentTime >= 0.25 && value.time.currentTime < 4;
    }, "the selected song beginning playback");
    await this.command("/queue/add-later", collection);
    let total = 0;
    await wait(async () => {
      total = (await this.queuePosition()).total;
      return total >= index + 2 && matches(await at(index + 1));
    }, "the collection added after the selected song");
    // The appended collection contains a second copy of the selected song.
    // Remove that copy and put the playing entry at its original position.
    await this.command(`/queue/items/${index + 1}`, undefined, "DELETE");
    await wait(async () => (await this.queuePosition()).total === total - 1, "the duplicate queue entry removed");
    if (index > 0) await this.command("/queue/move", { from: 0, to: index });
    await wait(async () => (await this.queuePosition()).position === index && matches(await at(index)), "the selected song's collection position");
  }
}
