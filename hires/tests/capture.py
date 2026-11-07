"""Bit-perfect test of Android's audio path: plays a known signal of random 24-bit samples through
AAudio in Android, records what reaches PipeWire, and requires a sample-for-sample match."""
import argparse, array, subprocess, sys, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
import pwcap

ap = argparse.ArgumentParser()
ap.add_argument("--rate", type=int, required=True)
ap.add_argument("--adb", required=True)
ap.add_argument("--signal", default=None)
args = ap.parse_args()

with pwcap.TestSink(args.rate) as sink:
    player = subprocess.Popen(["adb", "-s", args.adb, "shell", "/data/local/tmp/aaplay", "/data/local/tmp/signal.f32", str(args.rate)],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        # The signal starts with 1.5 seconds of silence, so the move happens before anything plays.
        sink.move_waydroid()
        time.sleep(2.0)
        captures = {n: pwcap.record(n, 3, args.rate) for n in pwcap.waydroid_nodes()}
        rate = pwcap.sink_rate(sink.name)
    finally:
        out = player.communicate(timeout=30)[0]

data = max(captures.values(), key=lambda a: sum(1 for x in a[:20000] if x != 0.0), default=array.array("f"))
nonzero = [x for x in data if x != 0.0]
if len(nonzero) < 100000:
    sys.exit(f"almost nothing reached PipeWire ({len(nonzero)} samples); player said: {out.strip()[-200:]}")

# Find the captured audio inside the source signal and compare every sample. Alignment uses a
# frame from the middle of the capture, and the first half second after the stream starts is not
# compared: Android ramps a new track's volume in over a few milliseconds.
src = array.array("f"); src.frombytes(open(args.signal or __import__("os").path.expanduser("~/.cache/peel-hires/test/signal.f32"), "rb").read())
first = next(i for i, x in enumerate(data) if x != 0.0)
mid = (first + len(data)) // 2
mid -= mid % 2
pos = src.tobytes().find(data[mid:mid + 8].tobytes())
if pos < 0 or pos % 8:
    share, n = pwcap.grid_share(data)
    sys.exit(f"captured audio does not match the source (graph rate {rate}, {share:.4%} of {n} samples on the 24-bit grid)")
offset = pos // 4 - mid                 # source index = capture index + offset
start = max(first + args.rate, -offset)  # skip the ramp-in (half a second of stereo samples)
if rate != args.rate:
    sys.exit(f"the test sink ran at {rate} Hz instead of {args.rate} Hz")
end = min(len(data), len(src) - offset)
end = max(i for i in range(start, end) if data[i] != 0.0) + 1  # ignore silence after the stream stopped
mismatch = sum(1 for i in range(start, end) if data[i] != src[i + offset])
if mismatch:
    sys.exit(f"{mismatch} of {end - start} samples differ from the source (graph rate {rate})")
print(f"{end - start} samples identical to the source at {args.rate} Hz (graph rate {rate})")
