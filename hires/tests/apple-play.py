"""Plays a 192 kHz Hi-Res Lossless song in Apple Music, silently on a test sink, and checks that
Apple decodes ALAC at 192 kHz and that what reaches PipeWire runs at 192 kHz with full 24-bit
samples: every sample an exact 24-bit value, and almost none on the 16-bit grid (which truncated
audio would be). There is no reference to compare against, so this shows no resampling, gain or
truncation, not a sample-for-sample match; capture.py proves that for the Android path.
Stops playback afterwards. Uses the account's one stream, so only run it when nothing plays."""
import argparse, re, subprocess, sys, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
import pwcap

# Miles Davis, "So What": Apple serves it as 192 kHz / 24-bit ALAC.
SONG = "https://music.apple.com/de/album/so-what/268443092?i=268443097"
TITLE = "So What"

ap = argparse.ArgumentParser()
ap.add_argument("--adb", required=True)
ap.add_argument("--rate", type=int, default=192000)
args = ap.parse_args()
adb = ["adb", "-s", args.adb]
sh = lambda *c: subprocess.run(adb + ["shell", *c], capture_output=True, text=True, timeout=30).stdout

def tap_title():
    for _ in range(20):
        sh("uiautomator", "dump", "/sdcard/ui.xml")
        ui = sh("cat", "/sdcard/ui.xml")
        m = re.search(r'text="' + re.escape(TITLE) + r'"[^>]*resource-id="[^"]*:id/title"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', ui)
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            sh("input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
            return
        time.sleep(1)
    raise SystemExit(f"could not find '{TITLE}' on the album page")

subprocess.run(adb + ["logcat", "-c"], timeout=15)
with pwcap.TestSink(args.rate) as sink:
    try:
        sh("am", "start", "-a", "android.intent.action.VIEW", "-d", SONG, "com.apple.android.music")
        time.sleep(5)
        # The first moments of playback could reach the real output before the stream moves.
        with pwcap.muted_default_sink():
            tap_title()
            sink.move_waydroid(wait=20)
        time.sleep(8)
        sink.move_waydroid()
        log = subprocess.run(adb + ["logcat", "-d"], capture_output=True, text=True, timeout=30).stdout
        decoders = re.findall(r"(ALAC|AAC) Decoder output format: .*?SampleRate:(\d+)", log)
        captures = [pwcap.record(n, 4, args.rate) for n in pwcap.waydroid_nodes()]
        rate = pwcap.sink_rate(sink.name)
    finally:
        sh("input", "keyevent", "127")

if not decoders:
    sys.exit("Apple Music did not start decoding")
codec, decoded = decoders[-1]
if codec != "ALAC" or int(decoded) != 192000:
    sys.exit(f"Apple Music decoded {codec} at {decoded} Hz instead of ALAC at 192000 Hz")
music = max(captures, key=lambda a: sum(1 for x in a if x != 0.0))
share, n = pwcap.grid_share(music)
share16, _ = pwcap.grid_share(music, 16)
if n < 100000:
    sys.exit(f"almost no audio reached PipeWire ({n} samples)")
if rate != args.rate:
    sys.exit(f"the test sink ran at {rate} Hz instead of {args.rate} Hz")
if share < 1.0:
    sys.exit(f"only {share:.2%} of {n} samples are exact 24-bit values (graph rate {rate})")
if share16 > 0.05:
    sys.exit(f"{share16:.1%} of samples lie on the 16-bit grid; the audio looks truncated to 16 bits")
print(f"ALAC 192 kHz; {n} samples at {rate} Hz, all exact 24-bit values, {share16:.2%} on the 16-bit grid")
