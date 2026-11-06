import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { Engine } from "../src/engine";
import { validHost } from "../src/remote";
import { serveRemote } from "../src/remote-host";
import { Model } from "../src/model";
import { defaults } from "../src/config";
import { PeelUI } from "../src/ui";
import { fixture } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function host() {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  let retained = false, releases = 0, ready = 0;
  const commands: string[] = [];
  const transport = async (path: string, body?: any) => {
    if (path === "/retain") { retained = true; return; }
    if (path === "/release") { releases++; return; }
    if (path === "/state") return { ready: true, playback: await api.player.snapshot() };
    commands.push(body.method);
    if (body.method === "queue") return { position: 0, items: [] };
    if (body.method === "toggle") await api.player.command("/playback/toggle");
    if (body.method === "seek") await api.player.command("/playback/seek", { position: body.args[0] });
    return null;
  };
  const local = new Engine(undefined, transport);
  const client = () => new Engine(undefined, async (path, body) => {
    const replies: any[] = [];
    async function* lines() { yield JSON.stringify({ id: 1, path, body }); }
    await serveRemote(lines(), reply => replies.push(reply), local, async () => { ready++; });
    const reply = replies.find(reply => reply.id === 1);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  });
  return { ...api, local, client, commands, retained: () => retained, releases: () => releases, ready: () => ready };
}

test("remote controllers share host playback and disconnect without quitting it", async () => {
  const app = host(), first = app.client(), second = app.client();
  await first.command("/playback/toggle");
  expect((await second.snapshot()).state).toBe("playing");
  await second.command("/playback/seek", { position: 47 });
  expect((await first.snapshot()).time.currentTime).toBe(47);
  await first.command("/playback/toggle");
  expect((await second.snapshot()).state).toBe("paused");
  expect(app.retained()).toBe(true);
  expect(app.releases()).toBe(6);
  expect(app.commands).not.toContain("quit");
});

test("the SSH helper refuses lifecycle commands and malformed messages", async () => {
  const app = host(), replies: any[] = [];
  async function* lines() { yield '{"id":7,"path":"/quit","body":{}}'; yield "broken"; yield '{"id":8,"path":"/state"}'; }
  await serveRemote(lines(), reply => replies.push(reply), app.local, async () => {});
  expect(replies[0]).toMatchObject({ id: 7, error: "Invalid remote request" });
  expect(replies[1].error).toBeTruthy();
  expect(replies[2]).toMatchObject({ id: 8, value: { ready: true } });
  expect(app.releases()).toBe(1);
});

test("SSH targets cannot become options or remote shell commands", () => {
  for (const host of ["main", "rabe@main", "mac.local", "192.168.1.20", "::1"]) expect(validHost(host)).toBe(true);
  for (const host of ["", "-oProxyCommand=bad", "main;touch /tmp/x", "main$(id)", "main\nwhoami", "main other"]) expect(validHost(host)).toBe(false);
});

test("an open queue follows edits from another controller without a song change", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  let revision = "before", queue = [{ id: "a", type: "songs", name: "A", artist: "", album: "", duration: 10 }];
  api.player.snapshot = async () => ({ ...api.playback, queueRevision: revision });
  api.player.queue = async () => ({ items: structuredClone(queue), more: false });
  const model = new Model(api.library, api.player);
  await model.refresh(); await model.open("queue");
  expect(model.items.map(item => item.id)).toEqual(["a"]);
  queue = [{ ...queue[0]!, id: "b", name: "B" }]; revision = "after";
  await model.refresh(); await Bun.sleep(0);
  expect(model.items.map(item => item.id)).toEqual(["b"]);
});

test("settings switch controllers, show the host, and keep the previous target after failure", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const app = await createTestRenderer({ width: 120, height: 36 }); cleanup.push(() => app.renderer.destroy());
  const model = new Model(api.library, api.player, structuredClone(defaults));
  const selected: (string | undefined)[] = [];
  model.outputTargets = ["main", "offline"];
  model.onOutput = async host => { selected.push(host); if (host === "offline") throw new Error("Host unavailable"); };
  const ui = new PeelUI(app.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await model.open("settings");
  await model.selectOutput("main"); await app.flush();
  expect(model.preferences.remote).toBe("main");
  expect(app.captureCharFrame()).toContain("Control playback on");
  expect(app.captureCharFrame()).toContain("On main");
  await model.selectOutput("offline");
  expect(model.preferences.remote).toBe("main");
  expect(selected).toEqual(["main", "offline"]);
});


test("the host buffers the first SSH request while its engine starts", async () => {
  const app = host(), stream = new PassThrough();
  const lines = createInterface({ input: stream }), replies: any[] = [];
  let release!: () => void;
  const starting = new Promise<void>(resolve => { release = resolve; });
  const serving = serveRemote(lines, reply => replies.push(reply), app.local, () => starting);
  stream.write('{"id":1,"path":"/state"}\n');
  await Bun.sleep(5); release();
  stream.end(); await serving;
  expect(replies).toMatchObject([{ id: 1, value: { ready: true } }]);
});
