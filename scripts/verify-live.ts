import { createTestRenderer } from "@opentui/core/testing";
import { mkdir } from "node:fs/promises";
import { AppleMusic } from "../src/apple";
import { Cider } from "../src/cider";
import { readAppleSignIn, readToken } from "../src/config";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import type { Playback } from "../src/types";
import { captureCiderAudio } from "./audio";

// This check controls the signed-in Cider instance. It restores playback settings
// and the initial position/state afterwards. Run it while no one else is controlling Cider.
const player = new Cider(undefined, await readToken());
const signIn = await readAppleSignIn();
const library = new AppleMusic(signIn.userToken, { storefront: signIn.storefront });
const report: { checkedAt: string; backend: string; checks: { name: string; value: unknown }[]; error?: string; restorationError?: string } = {
  checkedAt: new Date().toISOString(), backend: player.base, checks: [],
};
const record = (name: string, value: unknown) => { report.checks.push({ name, value }); console.log(`PASS ${name}: ${JSON.stringify(value)}`); };
const setup = await createTestRenderer({ width: 120, height: 36 });
const model = new Model(library, player);
const ui = new PeelUI(setup.renderer, model);
let original: Playback | undefined;
let restoreCollection: { type: string; id: string; position: number; ids: string[] } | undefined;
async function observe(predicate: (state: Playback) => boolean, description: string) {
  const until = Date.now() + 15000;
  do {
    const value = await player.snapshot();
    if (predicate(value)) { model.playback = value; model.connected = true; model.changed(); return value; }
    await Bun.sleep(250);
  } while (Date.now() < until);
  throw new Error(`Cider did not confirm ${description}`);
}
async function click(id: string) {
  await setup.flush();
  const target = setup.renderer.root.findDescendantById(id);
  if (!target || target.width <= 0 || target.height <= 0) throw new Error(`Missing rendered control: ${id}`);
  await setup.mockMouse.click(target.x + Math.min(1, target.width - 1), target.y);
}
try {
  original = await player.snapshot();
  record("real Cider connection", { state: original.state, track: original.nowPlaying?.name });
  await model.start();
  if (!model.connected) throw new Error(model.status);
  if (!model.playlists.length) throw new Error(`Library did not load: ${model.status}`);
  record("real library and favourites", model.navigation().map(item => ({ name: item.name, id: item.id })));
  if (!model.navigation().find(item => item.id === "favourites")?.media) throw new Error("Favourite Songs playlist was not identified");
  if (!original.nowPlaying) throw new Error("Select a song in Cider before running the live control check");

  if (original.state === "playing") {
    await model.act("/playback/pause"); await observe(state => state.state === "paused", "paused state");
  }
  await click("play-pause"); const start = await observe(state => state.state === "playing", "mouse play");
  record("mouse play", { state: start.state, track: start.nowPlaying?.name });
  const advanced = await observe(state => state.time.currentTime >= start.time.currentTime + 2, "playback time advancing");
  record("real playback time advances", { before: start.time.currentTime, after: advanced.time.currentTime });
  setup.mockInput.pressKey(" "); const paused = await observe(state => state.state === "paused", "keyboard pause");
  record("keyboard pause", paused.state);
  await setup.flush(); const frozen = setup.captureCharFrame(); ui.animate(); await setup.flush();
  if (setup.captureCharFrame() !== frozen) throw new Error("Paused playback bars changed");
  record("paused bars stay still", true);

  const beforeVolume = paused.volume;
  const volumeTarget = beforeVolume >= 0.05 ? beforeVolume - 0.05 : beforeVolume + 0.05;
  await click(beforeVolume >= 0.05 ? "volume-down" : "volume-up");
  const volume = await observe(state => Math.abs(state.volume - volumeTarget) < 0.005, "mouse volume");
  record("mouse volume", { before: beforeVolume, after: volume.volume });
  if (process.argv.includes("--audio")) {
    setup.mockInput.pressKey("p", { ctrl: true });
    await observe(state => state.state === "playing", "Ctrl+P resume for audio capture");
    record("actual Cider audio samples", await captureCiderAudio());
    setup.mockInput.pressKey(" ");
    await observe(state => state.state === "paused", "pause after audio capture");
  }
  setup.mockInput.pressKey(beforeVolume >= 0.05 ? "+" : "-");
  await observe(state => Math.abs(state.volume - beforeVolume) < 0.005, "keyboard volume");
  record("keyboard volume", beforeVolume);

  const beforeSeek = await player.snapshot();
  model.playback = beforeSeek; model.changed();
  if (beforeSeek.time.duration > 20) {
    const forward = beforeSeek.time.currentTime < beforeSeek.time.duration - 11;
    const seekTarget = Math.max(0, beforeSeek.time.currentTime + (forward ? 10 : -10));
    setup.mockInput.pressArrow(forward ? "right" : "left");
    const sought = await observe(state => Math.abs(state.time.currentTime - seekTarget) < 1, "keyboard seek");
    record("keyboard seek in seconds", { target: seekTarget, observed: sought.time.currentTime });
    await setup.flush();
    const target = setup.renderer.root.findDescendantById("seek")!;
    await setup.mockMouse.click(target.x + 55, target.y);
    const clicked = await observe(state => Math.abs(state.time.currentTime - sought.time.currentTime) > 1, "mouse seek");
    record("mouse seek", clicked.time.currentTime);
  }
  await click("shuffle"); await observe(state => state.shuffleMode !== original!.shuffleMode, "shuffle change"); record("mouse shuffle", !original.shuffleMode);
  await player.command("/playback/shuffle", { enabled: original.shuffleMode }, "PUT"); await observe(state => state.shuffleMode === original!.shuffleMode, "shuffle restoration");
  setup.mockInput.pressKey("r"); const repeated = await observe(state => state.repeatMode !== original!.repeatMode, "repeat change"); record("keyboard repeat", repeated.repeatMode);
  await player.command("/playback/repeat", { mode: original.repeatMode }, "PUT");
  await observe(state => state.repeatMode === original!.repeatMode, "repeat restoration");

  await click("search"); await setup.mockInput.typeText("Soma Skrillex"); setup.mockInput.pressEnter();
  const until = Date.now() + 35000;
  while (model.loading && Date.now() < until) await Bun.sleep(50);
  if (!model.items.length) throw new Error(`Real search returned no items: ${model.status}`);
  record("real search through the visible input", { query: ui.search.value, results: model.items.length, first: model.items[0].name });

  // Test collection selection and skips only when the existing queue can be
  // reconstructed exactly from its complete, unshuffled catalog album.
  const queue = (await player.request("/queue?offset=0&limit=100")).data;
  const context = queue.items?.[queue.position]?.containerContext;
  if (context?.type === "album" && !original.shuffleMode) {
    const resource = (await player.request(`/amapi/catalog/albums/${encodeURIComponent(context.id)}?include=tracks`)).data.data?.[0];
    const tracks = resource?.relationships?.tracks;
    const queueIds = queue.items.map((item: any) => String(item.track.id));
    const albumIds = (tracks?.data ?? []).map((item: any) => String(item.id));
    const restorable = !tracks?.next && JSON.stringify(queueIds) === JSON.stringify(albumIds);
    const albumIndex = model.items.findIndex(item => item.type === "albums" && item.name.toLowerCase() === "soma");
    if (restorable && albumIndex >= 0) {
      restoreCollection = { type: "albums", id: context.id, position: queue.position, ids: queueIds };
      ui.tracks.move(albumIndex - ui.tracks.index);
      await click(`tracks:row:${albumIndex}`);
      const deadline = Date.now() + 35000;
      while ((model.loading || !model.view.startsWith("collection:")) && Date.now() < deadline) await Bun.sleep(50);
      if (model.items.length < 3) throw new Error(`The real album did not load: ${model.status}`);
      const selected = model.items[1], next = model.items[2];
      await click("tracks:row:1");
      await observe(state => state.state === "playing" && state.nowPlaying?.name === selected.name, "selected album track");
      const startedQueue = (await player.request("/queue?offset=0&limit=100")).data;
      if (startedQueue.position !== 1 || startedQueue.items.length < 3) throw new Error("Selecting a track did not retain the album queue");
      record("mouse album and track selection retains the queue", { track: selected.name, queueLength: startedQueue.items.length, position: startedQueue.position });
      await player.command("/playback/repeat", { mode: "one" }, "PUT");
      await observe(state => state.repeatMode === "one", "repeat-one mode for manual skip check");
      setup.mockInput.pressKey("n");
      await observe(state => state.nowPlaying?.name === next.name, "keyboard Next");
      record("keyboard Next changes the actual song", next.name);
      await click("previous");
      await observe(state => state.nowPlaying?.name === selected.name, "mouse Previous");
      record("mouse Previous changes the actual song", selected.name);
      record("manual skips preserve repeat-one mode", (await player.snapshot()).repeatMode);
    } else record("collection check applicability", "Existing queue is not a complete unshuffled album, or SOMA is absent. Queue left intact.");
  } else record("collection check applicability", "Existing queue is not a catalog album. Queue left intact.");
  await setup.flush(); await mkdir("evidence", { recursive: true });
  await Bun.write("evidence/live-player.txt", setup.captureCharFrame());
  await Bun.write("evidence/live-player.json", JSON.stringify(setup.captureSpans(), (_, value) => value?.toHex ? value.toHex() : value, 2));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${report.error}`); process.exitCode = 1;
} finally {
  if (original) {
    try {
      if (restoreCollection) {
        await player.command("/playback/play-collection", { type: restoreCollection.type, id: restoreCollection.id, shuffle: false });
        const restoredQueue = (await player.request("/queue?offset=0&limit=100")).data;
        const ids = restoredQueue.items.map((item: any) => String(item.track.id));
        if (JSON.stringify(ids) !== JSON.stringify(restoreCollection.ids)) throw new Error("Restored album queue differs from the original tracks");
        await player.command("/queue/jump", { index: restoreCollection.position });
        await observe(state => state.state === "playing" && state.nowPlaying?.name === original!.nowPlaying?.name && state.time.currentTime > 0.1, "restored track loading before restoring settings");
        record("original queue restored", { tracks: ids.length, position: restoreCollection.position });
      }
      await player.command("/playback/shuffle", { enabled: original.shuffleMode }, "PUT");
      await player.command("/playback/repeat", { mode: original.repeatMode }, "PUT");
      await player.command("/playback/seek", { position: original.time.currentTime });
      // Cider can retain a stale "playing" flag after stop. Restore non-playing
      // sessions with pause, whose observed state reliably confirms silence.
      const restoredState = original.state === "playing" ? "playing" : "paused";
      const stateCommand = original.state === "playing" ? "/playback/play" : "/playback/pause";
      // Seeking/loading can complete after an earlier pause command. Reapply the
      // idempotent command until Cider confirms the final requested state.
      const stateDeadline = Date.now() + 15000;
      let stateConfirmed = false;
      while (!stateConfirmed && Date.now() < stateDeadline) {
        await player.command(stateCommand);
        await Bun.sleep(300);
        const state = await player.snapshot();
        stateConfirmed = original.state === "playing" ? state.state === "playing" : state.state !== "playing";
      }
      if (!stateConfirmed) throw new Error("Cider did not confirm the original playback state");
      await player.command("/audio/volume", { volume: original.volume }, "PATCH");
      const restored = await observe(state =>
        Math.abs(state.volume - original!.volume) < 0.005 && state.shuffleMode === original!.shuffleMode &&
        state.repeatMode === original!.repeatMode && (restoredState === "playing" ? state.state === "playing" : state.state !== "playing"), "original playback settings");
      record("original playback settings restored", { volume: restored.volume, shuffle: restored.shuffleMode, repeat: restored.repeatMode, originalState: original.state, state: restored.state });
    } catch (error) { report.restorationError = String(error); console.error(`FAIL restoration: ${error}`); process.exitCode = 1; }
  }
  ui.dispose(); setup.renderer.destroy();
  await mkdir("evidence", { recursive: true });
  await Bun.write("evidence/live-report.json", JSON.stringify(report, null, 2) + "\n");
}
