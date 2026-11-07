"""PipeWire helpers for the hi-res tests: a temporary null sink, moving Waydroid's streams onto
it, and recording a stream node's own output ports (not the default source)."""
import json, subprocess, time, array, os, signal, tempfile, contextlib

def run(*cmd, check=True):
    return subprocess.run(cmd, check=check, capture_output=True, text=True).stdout

def dump():
    return json.loads(run("pw-dump"))

def waydroid_streams():
    """Waydroid's PulseAudio streams as {sink-input id: sink id}."""
    streams, cur, sink = {}, None, None
    for line in run("pactl", "list", "sink-inputs").splitlines():
        line = line.strip()
        if line.startswith("Sink Input #"): cur, sink = line.split("#")[1], None
        elif line.startswith("Sink:"): sink = line.split(":", 1)[1].strip()
        elif line == 'application.name = "Waydroid"' and cur: streams[cur] = sink
    return streams

def waydroid_nodes():
    return [o["id"] for o in dump() if o.get("type", "").endswith("Node")
            and o.get("info", {}).get("props", {}).get("node.name") == "Waydroid"]

class TestSink:
    """A silent sink at `rate`. Waydroid's streams moved onto it go back to their own sinks after."""
    def __init__(self, rate):
        self.rate, self.name, self.original = rate, "peel_hires_test", {}
    def __enter__(self):
        self.module = run("pactl", "load-module", "module-null-sink", f"sink_name={self.name}", f"rate={self.rate}",
                          f"sink_properties=device.description=Peel-hi-res-test node.rate=1/{self.rate} audio.rate={self.rate}").strip()
        # `pactl list sink-inputs` names sinks by index, so streams are matched against this one's.
        self.index = next((l.split("\t")[0] for l in run("pactl", "list", "short", "sinks").splitlines()
                           if l.split("\t")[1:2] == [self.name]), None)
        return self
    def move_waydroid(self, wait=8.0):
        """Moves every Waydroid stream here, waiting up to `wait` seconds for one to appear."""
        end = time.time() + wait
        while time.time() < end:
            streams = waydroid_streams()
            if streams:
                for sid, sink in streams.items():
                    self.original.setdefault(sid, sink)
                    run("pactl", "move-sink-input", sid, self.name, check=False)
                return list(streams)
            time.sleep(0.05)
        raise RuntimeError("no Waydroid audio stream appeared")
    def __exit__(self, *exc):
        try:
            for sid, sink in waydroid_streams().items():
                if sink not in (self.index, self.name): continue
                run("pactl", "move-sink-input", sid, self.original.get(sid) or "@DEFAULT_SINK@", check=False)
        finally:
            run("pactl", "unload-module", self.module, check=False)

@contextlib.contextmanager
def muted_default_sink():
    """Mutes the default output for a moment, restoring its previous state."""
    was = run("pactl", "get-sink-mute", "@DEFAULT_SINK@", check=False).strip().endswith("yes")
    run("pactl", "set-sink-mute", "@DEFAULT_SINK@", "1", check=False)
    try: yield
    finally: run("pactl", "set-sink-mute", "@DEFAULT_SINK@", "1" if was else "0", check=False)

def record(node, seconds, rate):
    """Records a node's output ports as interleaved float32 stereo."""
    name = f"peelcap{node}"
    out = tempfile.NamedTemporaryFile(suffix=".f32", delete=False).name
    rec = subprocess.Popen(["pw-record", "-P", f"{{ node.autoconnect=false node.name={name} }}", "--rate", str(rate),
                            "--channels", "2", "--format", "f32", "--raw", out],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ports = {}
        for _ in range(50):
            d = dump()
            cap = next((o["id"] for o in d if o.get("type", "").endswith("Node") and o["info"]["props"].get("node.name") == name), None)
            if cap is not None:
                for o in d:
                    if not o.get("type", "").endswith("Port"): continue
                    p, info = o["info"]["props"], o["info"]
                    if int(p.get("node.id", -1)) == node and info.get("direction") == "output": ports[("out", p.get("audio.channel"))] = o["id"]
                    if int(p.get("node.id", -1)) == cap and info.get("direction") == "input": ports[("in", p.get("audio.channel"))] = o["id"]
                if all(k in ports for k in [("out", "FL"), ("out", "FR"), ("in", "FL"), ("in", "FR")]): break
            time.sleep(0.1)
        for ch in ("FL", "FR"):
            run("pw-link", str(ports[("out", ch)]), str(ports[("in", ch)]))
        time.sleep(seconds)
    finally:
        rec.send_signal(signal.SIGINT); rec.wait(timeout=5)
    data = array.array("f"); data.frombytes(open(out, "rb").read()); os.unlink(out)
    return data

def grid_share(samples, bits=24):
    """Share of non-zero samples that lie exactly on the `bits` integer grid."""
    nz = [x for x in samples if x != 0.0]
    if not nz: return 0.0, 0
    s = float(1 << (bits - 1))
    return sum(1 for x in nz if (x * s).is_integer()) / len(nz), len(nz)

def sink_rate(sink):
    for o in dump():
        p = o.get("info", {}).get("props", {})
        if o.get("type", "").endswith("Node") and p.get("node.name") == sink:
            f = (o["info"].get("params", {}).get("Format") or [{}])[0]
            return f.get("rate")
