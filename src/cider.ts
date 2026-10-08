import { media, type Media, type Page, type Playback, type Player } from "./types";

type Resource = Record<string, any>;
// Cider expands only this many songs when a collection is added to the queue.
const collectionPage = 100;
interface Envelope { data: any; meta?: { offset: number; limit: number; total?: number }; error?: string | { code: string; message?: string } }

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
      if (code === "INSUFFICIENT_SCOPE") throw new Error("Cider denied this permission. Run bun run connect and grant every permission Peel requests.");
      throw new Error(typeof result.error === "object" ? result.error.message ?? result.error.code : code ?? `Cider returned HTTP ${response.status}`);
    }
    return result;
  }

  async connect(): Promise<{ token: string; scopes: string[] }> {
    return (await this.request("/auth/request", {
      app_name: "Peel", scopes: ["playback", "queue", "library", "audio", "account"],
    }, "POST", 125000)).data;
  }

  // Cider's Apple Music sign-in. Peel reads the library from Apple with the same user token.
  async appleTokens(): Promise<{ userToken: string; storefront?: string }> {
    const data = (await this.request("/client/tokens", undefined, "GET", 5000)).data;
    if (!data?.userToken) throw new Error("Cider is not signed in to Apple Music. Sign in to Cider, then run bun run connect.");
    return { userToken: data.userToken, storefront: data.storefront };
  }

  // Apple Music API reads through Cider's proxy, which signs them with Cider's own session.
  // The proxy rejects some query characters, so catalog searches use its search route.
  async amapi(path: string): Promise<Record<string, any>> {
    const search = path.match(/^v1\/catalog\/[^/]+\/search\?(.*)$/);
    if (search) return { results: (await this.request(`/amapi/search?${search[1]}`)).data.results };
    return (await this.request(`/amapi/raw/${path}`)).data;
  }

  async snapshot(): Promise<Playback> { return (await this.request("/playback")).data; }

  async rating(): Promise<number> { return (await this.request("/library/now-playing/status")).data?.rating ?? 0; }

  async queue(offset = 0, limit = 100): Promise<Page> {
    const response = await this.request(`/queue?offset=${offset}&limit=${limit}`);
    const items = (response.data.items ?? []).map((item: Resource, index: number) => ({ ...media(item), queueIndex: offset + index }));
    // Some Cider versions report a page count as total when Apple omits meta.total.
    // A full page must therefore remain loadable until a short page is returned.
    return { items, more: items.length === limit || offset + items.length < (response.meta?.total ?? 0) };
  }
  async queuePosition(): Promise<{ position: number; total: number }> { return (await this.request("/queue/position")).data; }
  async command(path: string, body: unknown = {}, method = "POST") {
    if (path === "/playback/play-item" || path === "/playback/play-collection" || path === "/queue/jump") this.starts++;
    await this.request(path, body, method);
  }

  // Counts playback starts, so a queue still being built stops when another song starts.
  private starts = 0;

  playItem(item: Media) { return this.command("/playback/play-item", { id: item.id, type: item.type }); }

  async playCollectionTrack(collection: { id: string; type: string }, items: Media[], index: number) {
    const track = items[index]!;
    // Songs queued after a selection beyond the collection's first page.
    const following = items.slice(index + 1, index + 1 + collectionPage);
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

    // Cider appends only a collection's first hundred songs. Beyond those, start the song
    // and queue the following songs one by one in the background, so playback controls
    // do not wait for it. The songs before the selection are not queued.
    if (index >= collectionPage - 1) {
      await this.command("/playback/shuffle", { enabled: false }, "PUT");
      await this.command("/playback/play-item", { id: track.id, type: track.type });
      const start = this.starts;
      void (async () => {
        // Cider acknowledges play-item before its decoder has started. Do not change the queue before it plays.
        await wait(async () => (await this.snapshot()).state === "playing", "the selected song beginning playback");
        for (const item of following) {
          if (this.starts !== start) return;
          await this.request("/queue/add-later", { id: item.id, type: item.type });
        }
      })().catch(() => {});
      return;
    }

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
