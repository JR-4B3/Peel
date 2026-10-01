/** Capture two seconds from Cider's own PipeWire stream, without saving the audio. */
export async function captureCiderAudio(includeFingerprint = false) {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}` };
  let serial = "";
  const until = Date.now() + 15000;
  while (!serial && Date.now() < until) {
    const list = Bun.spawn(["pactl", "-f", "json", "list", "sink-inputs"], { env, stdout: "pipe", stderr: "pipe" });
    const [text, diagnostic] = await Promise.all([new Response(list.stdout).text(), new Response(list.stderr).text()]);
    if (await list.exited !== 0) throw new Error(`Cannot inspect the desktop audio session: ${diagnostic}`);
    const item = JSON.parse(text).find((item: any) => item.properties?.["application.name"] === "Cider");
    serial = item?.properties?.["object.serial"] ?? "";
    if (!serial) await Bun.sleep(250);
  }
  if (!serial) throw new Error("Cider did not create a PipeWire audio stream");

  const recording = Bun.spawn([
    "pw-record", "--target", String(serial), "--rate", "48000", "--channels", "2",
    "--format", "f32", "--raw", "--sample-count", "96000", "-",
  ], { env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; recording.kill(); }, 10000);
  let raw: ArrayBuffer;
  let diagnostic: string;
  try {
    [raw, diagnostic] = await Promise.all([new Response(recording.stdout).arrayBuffer(), new Response(recording.stderr).text()]);
  } finally { clearTimeout(timer); }
  const exitCode = await recording.exited;
  if (timedOut || raw.byteLength !== 96000 * 2 * 4) throw new Error(`Audio capture did not produce two seconds of stereo PCM: ${raw.byteLength} bytes. ${diagnostic}`);
  const samples = new DataView(raw);
  let energy = 0, peak = 0;
  for (let offset = 0; offset < raw.byteLength; offset += 4) {
    const sample = samples.getFloat32(offset, true);
    if (!Number.isFinite(sample)) throw new Error("Cider audio contains a non-finite sample");
    peak = Math.max(peak, Math.abs(sample)); energy += sample * sample;
  }
  const rms = Math.sqrt(energy / (raw.byteLength / 4));
  if (rms < 0.0001) throw new Error("Cider's captured audio stream is silent");
  // Average 16 stereo frames into each mono sample for comparisons in memory.
  // This retains 3 kHz audio timing without saving a recording to disk.
  const fingerprint: number[] = [];
  if (includeFingerprint) {
    for (let offset = 0; offset < raw.byteLength; offset += 32 * 4) {
      let sum = 0;
      for (let sample = 0; sample < 32; sample++) sum += samples.getFloat32(offset + sample * 4, true);
      fingerprint.push(sum / 32);
    }
  }
  // pw-record can exit 1 when --sample-count is reached. Inspect the actual PCM,
  // rather than treating that process status as a substitute for audio content.
  return { source: "Cider", serial, seconds: 2, sampleRate: 48000, channels: 2, samples: raw.byteLength / 4, peak, rms, captureExitCode: exitCode, ...(includeFingerprint ? { fingerprint } : {}) };
}
