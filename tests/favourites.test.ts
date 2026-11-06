import { afterEach, expect, test } from "bun:test";
import { AppleMusic } from "../src/apple";
import type { Media } from "../src/types";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

test("a library song's favourite uses its library rating even when it has a catalog ID", async () => {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    calls.push(url.pathname);
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    const loved = url.pathname.endsWith("/library-songs") ? ["i.creep"] : ["catalog.other", "catalog.only"];
    return Response.json({ data: ids.filter(id => loved.includes(id)).map(id => ({ id, attributes: { value: 1 } })) });
  } });
  cleanup.push(() => server.stop(true));
  const library = new AppleMusic("fixture-user", { base: server.url.origin, developerToken: async () => "fixture-developer" });
  const song = (id: string, catalogId?: string): Media => ({ id, catalogId, type: "songs", name: id, artist: "Artist", album: "Album", duration: 100 });
  const loved = await library.ratings([
    song("i.creep", "catalog.creep"),
    song("i.other", "catalog.other"),
    song("catalog.only", "catalog.only"),
    song("i.upload"),
  ]);
  expect([...loved]).toEqual(["i.creep", "catalog.only"]);
  expect(calls.sort()).toEqual(["/v1/me/ratings/library-songs", "/v1/me/ratings/songs"]);
});
