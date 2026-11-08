import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { lineAt, nextChange, parseClock, parseLrc, parseTtml, LyricsSource, type LyricsSong } from "../src/lyrics";
import { LyricsView, type Clock } from "../src/lyrics-view";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import { defaults } from "../src/config";
import type { Playback } from "../src/types";
import { fixture } from "./fixture";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><body><div>
  <p begin="0.5" end="3.2"><span begin="0.5" end="1">Is</span> <span begin="1" end="1.6">this</span> the &amp; <span>real</span> life?</p>
  <p begin="3.725" end="7.0">Is this just <span ttm:role="x-bg">(ooh)</span>fantasy?</p>
  <p begin="1:15.0" end="1:18.5">After the&#x20;break</p>
</div></body></tt>`;

describe("parsing", () => {
  test("reads Apple's clock formats", () => {
    expect(parseClock("12.5")).toBe(12.5);
    expect(parseClock("1:02.25")).toBe(62.25);
    expect(parseClock("1:00:01")).toBe(3601);
    expect(parseClock("3.5s")).toBe(3.5);
    expect(parseClock("")).toBeNaN();
  });

  test("reads TTML lines, drops background vocals, and decodes entities", () => {
    const lyrics = parseTtml(ttml)!;
    expect(lyrics.synced).toBe(true);
    expect(lyrics.lines.map(line => line.text)).toEqual(["Is this the & real life?", "Is this just fantasy?", "After the break"]);
    expect(lyrics.lines[0]).toMatchObject({ start: 0.5, end: 3.2 });
    expect(lyrics.lines[2]).toMatchObject({ start: 75, end: 78.5 });
  });

  test("treats TTML without timing as unsynced", () => {
    const lyrics = parseTtml(`<tt itunes:timing="None"><p>One</p><p>Two</p></tt>`)!;
    expect(lyrics.synced).toBe(false);
    expect(lyrics.lines.map(line => line.text)).toEqual(["One", "Two"]);
    expect(parseTtml("<tt></tt>")).toBeUndefined();
  });

  test("reads LRC with repeated timestamps, an offset, and fills end times", () => {
    const lines = parseLrc("[ar:Someone]\n[offset:+500]\n[00:10.50][00:30.00]Chorus\n[00:20.00]Verse\n[00:40.00]\n");
    expect(lines.map(line => [line.start, line.text])).toEqual([[10, "Chorus"], [19.5, "Verse"], [29.5, "Chorus"]]);
    // The empty [00:40.00] line ends the last chorus at 39.5 s instead of leaving it lit.
    expect(lines.map(line => line.end)).toEqual([19.5, 29.5, 39.5]);
  });

  test("drops nested background vocals but keeps the words after them", () => {
    const lyrics = parseTtml(`<tt itunes:timing="Word"><p begin="1" end="4"><span begin="1" end="2">Main</span> <span ttm:role="x-bg"><span begin="2" end="3">(back</span> <span begin="3" end="3.5">ground)</span></span> <span begin="3.5" end="4">line</span></p></tt>`)!;
    expect(lyrics.lines[0]!.text).toBe("Main line");
  });

  test("finds the sung line and the next change, with gaps", () => {
    const lines = parseTtml(ttml)!.lines;
    expect(lineAt(lines, 0)).toBe(-1);
    expect(lineAt(lines, 1)).toBe(0);
    expect(lineAt(lines, 3.5)).toBe(-1);
    expect(lineAt(lines, 4)).toBe(1);
    expect(lineAt(lines, 30)).toBe(-1);
    expect(nextChange(lines, 1)).toBe(3.2);
    expect(nextChange(lines, 3.5)).toBe(3.725);
    expect(nextChange(lines, 30)).toBe(75);
    expect(nextChange(lines, 80)).toBe(Infinity);
  });
});

function lrclib(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const route = routes[url.pathname];
    if (!route) return new Response("", { status: 404 });
    return route();
  }) as typeof fetch;
  return { calls, fetch: fetcher };
}
const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status });
const song: LyricsSong = { catalogId: "1440650428", name: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera", duration: 355 };

describe("the lyrics source", () => {
  test("prefers Apple's synced lyrics and asks nothing else", async () => {
    const net = lrclib({});
    const apple: string[] = [];
    const source = new LyricsSource({ apple: async id => { apple.push(id); return ttml; }, fetch: net.fetch, lrclib: "http://lrclib.test" });
    const lyrics = await source.get(song);
    expect(lyrics?.source).toBe("Apple Music");
    expect(apple).toEqual(["1440650428"]);
    expect(net.calls).toEqual([]);
  });

  test("falls back to LRCLIB's exact match, then its search within three seconds", async () => {
    const exact = lrclib({ "/api/get": json({ syncedLyrics: "[00:01.00]Hello\n[00:02.00]World" }) });
    const first = await new LyricsSource({ apple: async () => undefined, fetch: exact.fetch, lrclib: "http://lrclib.test" }).get(song);
    expect(first).toMatchObject({ source: "LRCLIB", synced: true });
    expect(exact.calls[0]).toContain("duration=355");

    const search = lrclib({ "/api/search": json([{ duration: 300, syncedLyrics: "[00:01.00]Wrong" }, { duration: 356, syncedLyrics: "[00:01.00]Right" }]) });
    const second = await new LyricsSource({ fetch: search.fetch, lrclib: "http://lrclib.test" }).get({ ...song, catalogId: "i.library" });
    expect(second?.lines[0]?.text).toBe("Right");
    expect(search.calls.map(call => call.split("?")[0])).toEqual(["/api/get", "/api/search"]);
  });

  test("reports instrumentals and plain lyrics", async () => {
    const instrumental = lrclib({ "/api/get": json({ instrumental: true }) });
    expect(await new LyricsSource({ fetch: instrumental.fetch, lrclib: "http://lrclib.test" }).get(song)).toMatchObject({ instrumental: true });
    const plain = lrclib({ "/api/get": json({ plainLyrics: "One\n\nTwo" }) });
    const lyrics = await new LyricsSource({ fetch: plain.fetch, lrclib: "http://lrclib.test" }).get(song);
    expect(lyrics).toMatchObject({ synced: false, lines: [{ text: "One" }, { text: "Two" }] });
  });

  test("remembers songs without lyrics for a while, but not network failures", async () => {
    let now = 0;
    const none = lrclib({ "/api/search": json([]) });
    const source = new LyricsSource({ apple: async () => undefined, fetch: none.fetch, lrclib: "http://lrclib.test", now: () => now });
    expect(await source.get(song)).toBeNull();
    expect(await source.get(song)).toBeNull();
    expect(none.calls.length).toBe(2);
    now += 7 * 60 * 60 * 1000;
    await source.get(song);
    expect(none.calls.length).toBe(4);

    let up = false;
    const flaky = new LyricsSource({
      apple: async () => { if (!up) throw new Error("offline"); return ttml; },
      fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, lrclib: "http://lrclib.test",
    });
    await expect(flaky.get(song)).rejects.toThrow("offline");
    up = true;
    expect((await flaky.get(song))?.source).toBe("Apple Music");
  });

  test("shares one request between concurrent callers", async () => {
    let calls = 0;
    const source = new LyricsSource({ apple: async () => { calls++; await Bun.sleep(5); return ttml; } });
    const [a, b] = await Promise.all([source.get(song), source.get(song)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});

class FakeClock implements Clock {
  time = 0;
  timers: { at: number; run: () => void; id: number }[] = [];
  private next = 1;
  now() { return this.time; }
  set(run: () => void, ms: number) { const id = this.next++; this.timers.push({ at: this.time + ms, run, id }); return id; }
  clear(handle: unknown) { this.timers = this.timers.filter(timer => timer.id !== handle); }
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter(timer => timer !== due);
      this.time = due.at; due.run();
    }
    this.time = end;
  }
}

const playing = (currentTime: number, state: Playback["state"] = "playing"): Playback => ({
  state, nowPlaying: { name: "Bohemian Rhapsody", artistName: "Queen", albumName: "A Night at the Opera", playParams: { catalogId: "1440650428" } },
  time: { currentTime, duration: 355 }, volume: 1, repeatMode: "none", shuffleMode: false,
});

describe("the lyrics pane", () => {
  async function pane() {
    const setup = await createTestRenderer({ width: 50, height: 14 }); cleanup.push(() => setup.renderer.destroy());
    const clock = new FakeClock();
    let requests = 0;
    const view = new LyricsView(setup.renderer, new LyricsSource({ apple: async () => { requests++; return ttml; } }), clock);
    view.panel.width = 40; view.panel.height = 12;
    setup.renderer.root.add(view.panel);
    return { ...setup, clock, view, requests: () => requests };
  }
  const highlighted = (frame: string, text: string) => frame.split("\n").some(line => line.includes(text));

  test("does nothing while hidden", async () => {
    const app = await pane();
    app.view.sync(playing(1));
    await Bun.sleep(5);
    expect(app.requests()).toBe(0);
    expect(app.clock.timers.length).toBe(0);
  });

  test("follows the song with one timer and stops it when paused", async () => {
    const app = await pane();
    app.view.sync(playing(1));
    app.view.show(true);
    await Bun.sleep(5); await app.renderOnce();
    let frame = app.captureCharFrame();
    expect(frame).toContain("Lyrics");
    expect(highlighted(frame, "Is this the & real life?")).toBe(true);
    expect(app.requests()).toBe(1);
    expect(app.clock.timers.length).toBe(1);

    // The view moves on by itself, between snapshots.
    app.clock.advance(3000);
    await app.renderOnce();
    frame = app.captureCharFrame();
    expect(frame).toContain("Is this just fantasy?");
    expect(app.clock.timers.length).toBe(1);

    app.view.sync(playing(4, "paused"));
    expect(app.clock.timers.length).toBe(0);
    app.view.show(false);
    expect(app.clock.timers.length).toBe(0);
  });

  test("switching between two cached songs repaints the words", async () => {
    const app = await pane();
    const other = ttml.replace(/<p begin="0.5"[\s\S]*?<\/p>/, '<p begin="0.5" end="3.2">A different first line</p>');
    expect(other).not.toBe(ttml);
    const view = new LyricsView(app.renderer, new LyricsSource({ apple: async id => id === "2" ? other : ttml }), app.clock);
    view.panel.width = 40; view.panel.height = 12; app.renderer.root.add(view.panel);
    const song = (id: string) => ({ ...playing(1), nowPlaying: { ...playing(1).nowPlaying!, name: `Song ${id}`, playParams: { catalogId: id } } });
    view.show(true);
    for (const id of ["1", "2", "1", "2"]) { view.sync(song(id)); await Bun.sleep(5); }
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("A different first line");
    view.sync(song("1")); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Is this the & real life?");
  });

  test("clicking a line plays from it, and the pane moves there at once", async () => {
    const app = await pane();
    const seeks: number[] = [];
    app.view.onSeek = time => seeks.push(time);
    app.view.sync(playing(1));
    app.view.show(true);
    await Bun.sleep(5); await app.renderOnce();
    const rows = app.captureCharFrame().split("\n");
    const y = rows.findIndex(row => row.includes("Is this just fantasy?"));
    expect(y).toBeGreaterThan(0);
    await app.mockMouse.click(rows[y]!.indexOf("Is") + 1, y);
    expect(seeks).toEqual([3.725]);
    expect(app.view.panel.focused).toBe(true);
    // A blank row plays nothing.
    await app.mockMouse.click(3, rows.findIndex(row => row.includes("Lyrics")) + 1);
    expect(seeks).toEqual([3.725]);
  });

  test("the keys choose a line, play from it, and step between lines", async () => {
    const app = await pane();
    const seeks: number[] = [];
    app.view.onSeek = time => seeks.push(time);
    app.view.sync(playing(1));
    app.view.show(true);
    await Bun.sleep(5); await app.renderOnce();

    // The highlight starts at the sung line and stops at the last one.
    app.view.move(1); app.view.move(1); app.view.move(1);
    expect(app.view.browsing).toBe(true);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("After the break");
    expect(app.view.jump()).toBe(true);
    expect(seeks).toEqual([75]);
    expect(app.view.browsing).toBe(false);

    // The pane already counts from the new time: the line before is the second one.
    expect(app.view.step(-1)).toBe(true);
    expect(seeks).toEqual([75, 3.725]);
    expect(app.view.step(1)).toBe(true);
    expect(seeks).toEqual([75, 3.725, 75]);

    // Between lines, the next line is the one after the gap.
    app.view.sync(playing(20));
    expect(app.view.step(1)).toBe(true);
    expect(seeks.at(-1)).toBe(75);
    app.view.sync(playing(20));
    expect(app.view.step(-1)).toBe(true);
    expect(seeks.at(-1)).toBe(3.725);

    // Releasing follows the song again; nothing is highlighted, so Enter plays nothing.
    app.view.move(-1); app.view.release();
    expect(app.view.jump()).toBe(false);
  });

  test("untimed lyrics scroll with the keys but play from no line", async () => {
    const setup = await createTestRenderer({ width: 50, height: 14 }); cleanup.push(() => setup.renderer.destroy());
    const untimed = `<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="None"><body><div><p>First words</p><p>Second words</p></div></body></tt>`;
    const view = new LyricsView(setup.renderer, new LyricsSource({ apple: async () => untimed, fetch: lrclib({}).fetch, lrclib: "http://lrclib.test" }), new FakeClock());
    const seeks: number[] = [];
    view.onSeek = time => seeks.push(time);
    view.panel.width = 40; view.panel.height = 12; setup.renderer.root.add(view.panel);
    view.sync(playing(1)); view.show(true);
    await Bun.sleep(20);
    view.move(1);
    expect(view.browsing).toBe(true);
    expect(view.jump()).toBe(false);
    expect(view.step(1)).toBe(false);
    expect(seeks).toEqual([]);
  });

  test("says when a song has no lyrics", async () => {
    const setup = await createTestRenderer({ width: 50, height: 10 }); cleanup.push(() => setup.renderer.destroy());
    const view = new LyricsView(setup.renderer, new LyricsSource({ apple: async () => undefined, fetch: lrclib({}).fetch, lrclib: "http://lrclib.test" }), new FakeClock());
    view.panel.width = 40; view.panel.height = 8; setup.renderer.root.add(view.panel);
    view.show(true); view.sync(playing(10));
    await Bun.sleep(5); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("No lyrics for this song.");
  });
});

describe("lyrics in the player", () => {
  async function app(width: number) {
    const api = fixture(); cleanup.push(() => api.server.stop(true));
    const setup = await createTestRenderer({ width, height: 30 }); cleanup.push(() => setup.renderer.destroy());
    const model = new Model(api.library, api.player, structuredClone(defaults));
    const net = lrclib({ "/api/search": json([{ duration: 200, syncedLyrics: "[00:25.00]Line before\n[00:29.00]Sung right now\n[00:40.00]Coming next" }]) });
    const ui = new PeelUI(setup.renderer, model, undefined, new LyricsSource({ fetch: net.fetch, lrclib: "http://lrclib.test" })); cleanup.push(() => ui.dispose());
    await model.start(); await model.refresh(); await setup.flush();
    return { ...setup, model, net, api };
  }

  test("y opens lyrics beside the content on wide windows, and asks nothing before", async () => {
    const a = await app(140);
    expect(a.net.calls.length).toBe(0);
    expect(a.captureCharFrame()).not.toContain("Sung right now");
    await a.mockInput.pressKey("y");
    await Bun.sleep(20); await a.flush();
    const frame = a.captureCharFrame();
    expect(frame).toContain("Sung right now");
    expect(frame).toContain("Coming next");
    expect(frame).toContain("Home");
    await a.mockInput.pressKey("y"); await a.flush();
    expect(a.captureCharFrame()).not.toContain("Sung right now");
  });

  test("on narrow windows lyrics replace the content until Escape", async () => {
    const a = await app(90);
    await a.mockInput.pressKey("y");
    await Bun.sleep(20); await a.flush();
    expect(a.captureCharFrame()).toContain("Sung right now");
    expect(a.renderer.root.findDescendantById("tracks-panel")?.visible).toBe(false);
    // Focus leaves the hidden songs, so no key acts on them.
    expect(a.renderer.root.findDescendantById("tracks")?.focused).toBe(false);
    a.mockInput.pressEscape();
    for (let i = 0; i < 100 && a.renderer.root.findDescendantById("tracks-panel")?.visible === false; i++) await Bun.sleep(10);
    await a.flush();
    expect(a.captureCharFrame()).not.toContain("Sung right now");
    expect(a.renderer.root.findDescendantById("tracks-panel")?.visible).toBe(true);
  });

  test("with the lyrics focused, j and Enter play from the next line, and h from the one before", async () => {
    const a = await app(90);
    a.model.playback.time.currentTime = 30; a.model.playback.state = "playing";
    await a.mockInput.pressKey("y");
    await Bun.sleep(20); await a.flush();
    expect(a.renderer.root.findDescendantById("lyrics-panel")?.focused).toBe(true);
    const seeks = () => a.api.commands.filter(call => call.method === "seek").map(call => call.args[0]);
    await a.mockInput.pressKey("j"); await a.flush();
    a.mockInput.pressEnter();
    for (let i = 0; i < 100 && !seeks().length; i++) await Bun.sleep(10);
    expect(seeks()).toEqual([40]);
    // The pane counts from 40 now, so h goes back to the line sung before it.
    await a.mockInput.pressKey("h");
    for (let i = 0; i < 100 && seeks().length < 2; i++) await Bun.sleep(10);
    expect(seeks()).toEqual([40, 29]);
    // Tab leaves the lyrics; the arrows then belong to the list again.
    await a.mockInput.pressTab(); await a.flush();
    expect(a.renderer.root.findDescendantById("lyrics-panel")?.focused).toBe(false);
  });
});
