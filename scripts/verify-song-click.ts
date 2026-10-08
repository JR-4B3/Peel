import { createTestRenderer } from "@opentui/core/testing";
import { mkdir } from "node:fs/promises";
import { AppleMusic } from "../src/apple";
import { Cider } from "../src/cider";
import { readAppleSignIn, readToken } from "../src/config";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import type { Playback } from "../src/types";
import { captureCiderAudio } from "./audio";

// Compare real Cider PCM after clicking a non-first playlist track against
// direct-play references for that track and the playlist's first track.
// All audio and fingerprints stay in memory. Only measurements are saved.
const player = new Cider(undefined, await readToken());
const signIn = await readAppleSignIn();
const library = new AppleMusic(signIn.userToken, { storefront: signIn.storefront });
const setup = await createTestRenderer({ width: 120, height: 60 });
const model = new Model(library, player);
const ui = new PeelUI(setup.renderer, model);
const report: { checkedAt: string; checks: { name: string; value: unknown }[]; error?: string; restorationError?: string } = { checkedAt: new Date().toISOString(), checks: [] };
const record = (name: string, value: unknown) => { report.checks.push({ name, value }); console.log(`PASS ${name}: ${JSON.stringify(value)}`); };
let original: Playback | undefined;
let originalIds: string[] = [];
let originalPosition = 0;
let collection: { id: string; type: string } | undefined;
let restoredTrack: typeof model.items[number] | undefined;
const commands: { path: string; body: unknown; method: string }[] = [];
const command = player.command.bind(player);
player.command = async (path, body, method = "POST") => {
  commands.push({ path, body, method });
  await command(path, body, method);
};
async function queueIdentity() {
  const result = await player.request("/queue?offset=0&limit=100");
  return (result.data.items ?? []).map((entry: any) => {
    const track = entry.track ?? entry, attributes = track.attributes ?? track;
    // The same Apple song may appear under its i.* library ID or catalog ID.
    // Compare catalog identities so hydration does not look like a queue change.
    return [attributes.playParams?.catalogId, attributes.playParams?.id, track.id]
      .find(id => typeof id === "string" && /^\d+$/.test(id)) ?? String(track.id);
  });
}
async function observe(predicate: (value: Playback) => boolean, description: string) {
  const until = Date.now() + 15000;
  do {
    const value = await player.snapshot();
    if (predicate(value)) return value;
    await Bun.sleep(100);
  } while (Date.now() < until);
  throw new Error(`Cider did not confirm ${description}`);
}
function similarity(a: number[], b: number[]) {
  let best = -1, bestLag = 0;
  for (let lag = -2250; lag <= 2250; lag++) {
    const start = Math.max(0, -lag), end = Math.min(a.length, b.length - lag);
    let sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0;
    for (let i = start; i < end; i++) {
      const x = a[i], y = b[i + lag];
      sumA += x; sumB += y; squareA += x * x; squareB += y * y; product += x * y;
    }
    const count = end - start;
    const divisor = Math.sqrt((squareA - sumA * sumA / count) * (squareB - sumB * sumB / count));
    if (divisor > 0) {
      const score = (product - sumA * sumB / count) / divisor;
      if (score > best) { best = score; bestLag = lag; }
    }
  }
  // Captures need not start at the same phase of a 16-frame averaging block.
  // Refine the lag between samples before comparing the downsampled waveform.
  for (let fraction = -0.5; fraction <= 0.5; fraction += 0.05) {
    const lag = bestLag + fraction;
    const start = Math.ceil(Math.max(0, -lag)), end = Math.floor(Math.min(a.length, b.length - lag - 1));
    let sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0;
    for (let i = start; i < end; i++) {
      const offset = i + lag, low = Math.floor(offset), ratio = offset - low;
      const x = a[i], y = b[low] * (1 - ratio) + b[low + 1] * ratio;
      sumA += x; sumB += y; squareA += x * x; squareB += y * y; product += x * y;
    }
    const count = end - start;
    const divisor = Math.sqrt((squareA - sumA * sumA / count) * (squareB - sumB * sumB / count));
    if (divisor > 0) best = Math.max(best, (product - sumA * sumB / count) / divisor);
  }
  return best;
}
async function capture(track: typeof model.items[number]) {
  // Compare the opening audio after real playback advances. Seeking while a
  // fresh decoder is loading can change its clock before audio is ready.
  await observe(value => value.state === "playing" && value.nowPlaying?.name === track.name &&
    value.time.currentTime >= 5 && value.time.currentTime < 7, `${track.name} playing its opening audio`);
  return captureCiderAudio(true);
}
try {
  original = await player.snapshot();
  const queue = await player.queue();
  const position = await player.queuePosition();
  if (position.total > 100 || queue.items.length !== position.total) throw new Error("This check requires a complete queue of at most 100 tracks so it can restore it exactly");
  originalIds = await queueIdentity(); originalPosition = position.position;
  record("original playback saved", { state: original.state, track: original.nowPlaying?.name, time: original.time.currentTime, volume: original.volume, position });
  await model.start();
  const favourite = model.navigation().find(item => item.id === "favourites")?.media;
  if (!favourite) throw new Error("Favourite Songs was not returned");
  collection = { id: favourite.id, type: favourite.type };
  await model.open("favourites");
  restoredTrack = queue.items[originalPosition];
  if (!restoredTrack || model.items[originalPosition]?.name !== original.nowPlaying?.name) throw new Error("The current queue is not the Favourite Songs collection in displayed order");
  const indexArgument = process.argv.indexOf("--index");
  const index = indexArgument < 0 ? 1 : Number(process.argv[indexArgument + 1]);
  if (!Number.isInteger(index) || index < 1 || !model.items[index]) throw new Error("Choose a non-first playlist row with --index, using a zero-based index");
  const selected = model.items[index], first = model.items[0];
  await player.command("/audio/volume", { volume: Math.min(original.volume || 0.1, 0.1) }, "PATCH");
  await player.command("/playback/play-item", { id: first.id, type: first.type });
  const firstReference = await capture(first);
  await player.command("/playback/play-item", { id: selected.id, type: selected.type });
  const selectedReference = await capture(selected);
  record("distinct direct-play audio references", { first: first.name, selected: selected.name, correlation: similarity(firstReference.fingerprint!, selectedReference.fingerprint!) });

  for (const clicks of [1, 2]) {
    commands.length = 0;
    await setup.flush();
    const target = setup.renderer.root.findDescendantById(`tracks:row:${index}`);
    if (!target) throw new Error("The selected song is not visible in the test terminal");
    const x = target.x + 1, y = target.y;
    for (let click = 0; click < clicks; click++) {
      await setup.mockMouse.click(x, y);
      if (click + 1 < clicks) { await Bun.sleep(50); await setup.flush(); }
    }
    // The command queue includes the full collection construction.
    await model.volume(0);
    const observedPosition = await player.queuePosition();
    if (observedPosition.position !== index || observedPosition.total !== model.items.length) throw new Error("Track selection did not retain the collection at the selected position");
    if (commands.filter(call => call.path === "/playback/play-item").length !== 1 || commands.some(call => call.path === "/playback/play-collection" || call.path === "/queue/jump")) throw new Error("Clicking started more than the selected song");
    const audio = await capture(selected);
    const selectedCorrelation = similarity(selectedReference.fingerprint!, audio.fingerprint!);
    const firstCorrelation = similarity(firstReference.fingerprint!, audio.fingerprint!);
    if (selectedCorrelation < 0.65 || selectedCorrelation - firstCorrelation < 0.3) throw new Error(`Audio did not match the selected song: selected=${selectedCorrelation}, first=${firstCorrelation}`);
    const { fingerprint, ...measurements } = audio;
    record(`${clicks === 1 ? "single" : "double"}-click plays the selected audio and retains the queue`, {
      selected: selected.name, selectedCorrelation, firstCorrelation, position: observedPosition,
      directStarts: commands.filter(call => call.path === "/playback/play-item").length, audio: measurements,
    });
    // A later deliberate click on the same song should be a fresh activation.
    await Bun.sleep(550);
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error); process.exitCode = 1;
} finally {
  if (original && collection && restoredTrack) {
    try {
      await player.playCollectionTrack(collection, restoredTrack, originalPosition);
      const restored = await player.queue();
      const queueRestored = JSON.stringify(await queueIdentity()) === JSON.stringify(originalIds);
      await player.command("/playback/shuffle", { enabled: original.shuffleMode }, "PUT");
      await player.command("/playback/repeat", { mode: original.repeatMode }, "PUT");
      await player.command("/playback/seek", { position: original.time.currentTime });
      const state = original.state === "playing" ? "playing" : "paused";
      await player.command(state === "playing" ? "/playback/play" : "/playback/pause");
      await observe(value => value.state === state, "the restored playback state");
      await player.command("/audio/volume", { volume: original.volume }, "PATCH");
      const value = await observe(value => value.volume === original!.volume, "the restored volume");
      if (!queueRestored) throw new Error("Original queue song identities were not restored");
      record("original song, queue, playback state, and volume restored", { track: value.nowPlaying?.name, tracks: restored.items.length, state: value.state, volume: value.volume });
    } catch (error) {
      report.restorationError = error instanceof Error ? error.message : String(error);
      console.error(report.restorationError); process.exitCode = 1;
      // A queue comparison failure must not leave test playback or volume active.
      try {
        await player.command(original.state === "playing" ? "/playback/play" : "/playback/pause");
        await player.command("/audio/volume", { volume: original.volume }, "PATCH");
      } catch (cleanupError) { console.error(`Playback cleanup failed: ${String(cleanupError)}`); }
    }
  }
  ui.dispose(); setup.renderer.destroy();
  await mkdir("evidence", { recursive: true });
  await Bun.write("evidence/song-click-report.json", JSON.stringify(report, null, 2) + "\n");
}
