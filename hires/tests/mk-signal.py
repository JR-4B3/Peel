# mk-signal.py OUT SECONDS RATE: raw f32 stereo test signal of random 24-bit values in [-0.25, 0.25),
# after 1.5 seconds of silence. Every sample is exactly representable, so any resampling, gain or
# dither changes it. The silence gives the test time to move the stream to its silent sink before
# anything audible plays.
import array, random, sys
out, seconds, rate = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
random.seed(7)
n = seconds * rate * 2
a = array.array("f", [0.0] * (3 * rate))
a.extend(random.randint(-(1 << 21), (1 << 21) - 1) / float(1 << 23) for _ in range(n))
open(out, "wb").write(a.tobytes())
