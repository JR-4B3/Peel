"""Plays songs at different rates through Peel's controller in Android and checks every switch of
Android's mixer: that the mixer follows the rate of the audio track Apple Music opens for each song,
that the stream in PipeWire runs at that rate, and that it carries sound, not only zeros. The songs
change three ways: the first song of a new queue, which Apple Music prepares while paused, two songs
that follow on their own, and a skip. Before Peel's controller held each track through a switch,
about one switch in three of these went silent or kept the old rate.

Nothing is heard: Android's streams play into a silent test sink, every new stream is moved there
at once, and Android's media volume stays at 7 percent, about -52 dB. A check needs only to tell
sound from zeros, which that volume still shows. At 1 percent Android sends only zeros. Uses the account's one stream, so only run it when
nothing plays. Stops playback afterwards and leaves the volume to the caller.

Turns Apple Music's repeat and shuffle off first, since with repeat one the first song would play
again instead of the next, and shuffle would change the order. It cannot turn them back on, because
Apple Music does not tell its modes. Peel's host sets both itself when it connects and when it
restores a queue."""
import argparse, array, json, re, socket, subprocess, sys, threading, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
import pwcap

# Catalog songs at four rates, where each change moves Android's mixer to another buffer size: Daft
# Punk, "Get Lucky" (44.1 kHz), Pink Floyd, "Time" (96 kHz), Eagles, "Hotel California" live in
# 2018 (48 kHz), and Miles Davis, "So What" (192 kHz). The test reads each song's rate from the track
# Apple Music opens, so a song Apple serves at another rate later still tests a switch, as long as
# the songs keep at least three rates. The last one leaves the mixer at 192 kHz, where Android
# starts and where the other tests expect it.
SONGS = ["1445215790", "1065973706", "1521729317", "268443097"]
DEFAULT_RATE = 192000

ap = argparse.ArgumentParser()
ap.add_argument("--state", required=True, help="the controller's address file that peel-hires controller writes")
ap.add_argument("--adb", required=True)
args = ap.parse_args()
adb = ["adb", "-s", args.adb]

class Controller:
    def __init__(self):
        access = json.load(open(args.state))
        self.key = access["key"]
        self.socket = socket.create_connection((access["host"], access["port"]), timeout=15)
        self.lines = self.socket.makefile("rb")

    def send(self, command):
        self.socket.sendall(f"{self.key} {command}\n".encode())
        return json.loads(self.lines.readline())

    def __call__(self, command):
        answer = self.send(command)
        if answer.get("error") == "no-session":
            # Apple Music's playback service starts with a media key, as Peel's host does it.
            subprocess.run(adb + ["shell", "cmd", "media_session", "dispatch", "pause"], capture_output=True, timeout=15)
            time.sleep(1.5)
            answer = self.send(command)
        if answer.get("error"): raise SystemExit(f"the controller refused '{command}': {answer['error']}")
        return answer

def streams():
    """Android's streams in PipeWire, as PulseAudio's tools list them."""
    try: listed = json.loads(pwcap.run("pactl", "-f", "json", "list", "sink-inputs", check=False))
    except ValueError: return []
    return [s for s in listed if s.get("properties", {}).get("application.name") == "Waydroid"]

def keep_on(sink, stop):
    """Moves every new stream of Android to the test sink as soon as it appears."""
    while not stop.is_set():
        for s in streams():
            if str(s.get("sink")) not in (sink.index, "4294967295"):
                pwcap.run("pactl", "move-sink-input", str(s["index"]), sink.name, check=False)
        time.sleep(0.02)

def rate_of(stream):
    return int(re.search(r"(\d+)Hz", stream.get("sample_specification", "")).group(1))

def sounds(stream):
    """Whether half a second of the stream holds any sample that is not zero."""
    rate = rate_of(stream)
    record = subprocess.Popen(["pacat", "--record", "--raw", f"--monitor-stream={stream['index']}", "--latency-msec=50",
                               "--format=float32le", f"--rate={rate}", "--channels=2"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    threading.Timer(0.6, record.kill).start()
    data = record.stdout.read()
    samples = array.array("f"); samples.frombytes(data[: len(data) // 4 * 4])
    if len(samples) < rate / 10: raise SystemExit("could not record Android's stream")
    return any(x != 0.0 for x in samples)

def playing(control, before, timeout=30):
    """Waits for another entry than before to play, starting a paused new queue, and returns its state."""
    end, started = time.time() + timeout, False
    while time.time() < end:
        state = control("state")
        if state.get("item", -1) >= 0 and state.get("item") != before:
            if state.get("state") == 3 and state.get("position", 0) > 0: return state
            if state.get("state") == 2 and not started:
                # A new queue can wait paused. Apple Music prepares the song meanwhile, and its
                # track then exists before the mixer switches, the case that went silent.
                time.sleep(1.5); control("play"); started = True
        time.sleep(0.04)
    raise SystemExit(f"song {len(results) + 1} did not start playing")

def check(control, state):
    """Checks the song that plays from about 2 to 5 seconds in. Returns its rate."""
    song, item = state.get("id"), state["item"]
    start = time.time() - state.get("position", 0) / 1000
    while time.time() - start < 2.0: time.sleep(0.04)
    end = time.time() + 3
    while True:
        state = control("state")
        rate = state.get("songRate") if state.get("rateItem") == item else None
        if rate and state.get("mixerRate") == rate: break
        if time.time() > end:
            if not rate: raise SystemExit(f"song {song}: the controller found no audio track for it")
            raise SystemExit(f"song {song}: Android mixes at {state.get('mixerRate')} Hz, but Apple Music's track runs at {rate} Hz")
        time.sleep(0.1)
    for at in (2.5, 4.5):
        while time.time() - start < at: time.sleep(0.04)
        listed = streams()
        if not listed: raise SystemExit(f"song {song}: Android has no stream in PipeWire")
        newest = max(listed, key=lambda s: s["index"])
        if rate_of(newest) != rate: raise SystemExit(f"song {song}: Android's stream runs at {rate_of(newest)} Hz instead of {rate} Hz")
        if not sounds(newest): raise SystemExit(f"song {song}: Android's stream at {rate} Hz carries only zeros {at} seconds in")
    return rate

results = []
with pwcap.TestSink(48000) as sink:
    stop = threading.Event()
    guard = threading.Thread(target=keep_on, args=(sink, stop), daemon=True)
    control = Controller()
    try:
        guard.start()
        control("volume 0.07")
        control("repeat 0")
        control("shuffle 0")
        before = control("state").get("item")
        if control("state").get("state") == 3: control("pause")
        control(f"list 0 {','.join(SONGS)}")
        for n in range(len(SONGS)):
            state = playing(control, before)
            results.append(check(control, state))
            before = state["item"]
            if n == len(SONGS) - 1: break
            # The second and third songs follow on their own, the last one after a skip.
            if n < 2: control(f"seek {max(0, (control('state').get('duration') or 0) - 4000)}")
            else: control("next")
    finally:
        try: control("pause"); control(f"rate {DEFAULT_RATE}")
        except Exception: pass
        time.sleep(0.5)
        stop.set(); guard.join()

if len(set(results)) < 3:
    sys.exit(f"the songs played at only {len(set(results))} rates ({results}), so too few switches were tested")
print(f"{len(results)} songs at {', '.join(str(r) for r in results)} Hz: the mixer followed each one, with sound")
