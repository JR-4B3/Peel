# Reads raw interleaved float32 stereo and reports whether samples lie on the 16- and 24-bit grids.
import sys, array, math
a = array.array("f"); a.frombytes(open(sys.argv[1], "rb").read())
n = len(a); nz = [x for x in a if x != 0.0]
def on_grid(bits):
    s = float(1 << (bits - 1)); return sum(1 for x in nz if (x * s) == math.floor(x * s))
print(f"samples={n} nonzero={len(nz)} seconds={n/2/96000:.2f} peak={max(abs(x) for x in a):.4f}")
for b in (16, 20, 24):
    k = on_grid(b); print(f"on {b}-bit grid: {k}/{len(nz)} ({100*k/max(1,len(nz)):.3f}%)")
lsb = {}
for x in nz:
    v = int(round(x * (1 << 23))) & 0xFF
    lsb[v] = lsb.get(v, 0) + 1
print("distinct low-8-bit patterns of 24-bit words:", len(lsb))
