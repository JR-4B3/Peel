# Band energy of a raw f32 stereo capture: shows whether content exists above 22/24 kHz (i.e. not a 44.1/48 kHz source).
import sys, numpy as np
rate = int(sys.argv[2]) if len(sys.argv) > 2 else 96000
x = np.fromfile(sys.argv[1], dtype=np.float32).reshape(-1, 2).mean(axis=1)
n = 1 << 15; frames = len(x) // n
spec = np.zeros(n // 2 + 1)
for i in range(frames):
    spec += np.abs(np.fft.rfft(x[i*n:(i+1)*n] * np.hanning(n))) ** 2
f = np.fft.rfftfreq(n, 1 / rate); total = spec.sum()
for lo, hi in [(0, 20000), (20000, 22050), (22050, 24000), (24000, 30000), (30000, 40000), (40000, rate / 2)]:
    e = spec[(f >= lo) & (f < hi)].sum()
    print(f"{lo/1000:5.1f}-{hi/1000:5.1f} kHz: {10*np.log10(e/total + 1e-30):7.1f} dB of total")
