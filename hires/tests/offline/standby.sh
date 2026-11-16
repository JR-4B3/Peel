#!/bin/bash
# Runs the real peel-hires against stand-ins for waydroid, busctl, adb, sudo with the root helper,
# systemctl, pactl and curl, to check Android's standby: frozen instead of stopped when no Peel
# uses it, woken before anything talks to it, and stopped once standby ends. It also runs the root
# helper's reclaim against a simulated cgroup tree. Nothing reaches Waydroid, Android or root.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
HIRES=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
server= helpers=
trap 'kill $server $helpers 2>/dev/null || true; rm -rf "$work"' EXIT
export LC_ALL=C

F=$work/fake        # the simulated machine: session, frozen, and the log of every call
mkdir -p "$F" "$work/bin" "$work/home"
export F HOME=$work/home XDG_CACHE_HOME=$work/cache XDG_STATE_HOME=$work/state XDG_CONFIG_HOME=$work/config XDG_RUNTIME_DIR=$work/run
export PATH=$work/bin:$PATH PEEL_HIRES_PORT=1
STATE=$XDG_STATE_HOME/peel-hires
CONFIG=$XDG_CONFIG_HOME/peel-hires/config

fake() { cat >"$work/bin/$1"; chmod +x "$work/bin/$1"; }
fake waydroid <<'EOF'
#!/bin/bash
echo "waydroid $*" >>"$F/calls"
case "$1" in
  status)
    if [ -f "$F/session" ]; then echo "Session:	RUNNING"; else echo "Session:	STOPPED"; fi
    if [ -f "$F/frozen" ]; then echo "Container:	FROZEN"; else echo "Container:	RUNNING"; fi
    [ -f "$F/session" ] && echo "IP address:	192.0.2.10" ;;
  session) [ "$2" = stop ] && rm -f "$F/session" "$F/frozen" ;;
esac
exit 0
EOF
fake busctl <<'EOF'
#!/bin/bash
echo "busctl ${*: -1}" >>"$F/calls"
case "${*: -1}" in
  Freeze) [ -f "$F/freeze-fails" ] && exit 1; touch "$F/frozen" ;;
  Unfreeze) rm -f "$F/frozen" ;;
esac
EOF
# adb notes every call it gets while Android is frozen: a real one would wait until its timeout.
fake adb <<'EOF'
#!/bin/bash
echo "adb $*" >>"$F/calls"
[ -f "$F/frozen" ] && { echo "ADB WHILE FROZEN: $*" >>"$F/calls"; exit 1; }
[ "$1" = -s ] && shift 2
case "$*" in
  "shell getprop sys.boot_completed") echo 1 ;;
  "shell pm path com.apple.android.music") echo "package:/data/app/apple/base.apk" ;;
  "shell dumpsys package com.apple.android.music") echo "    versionName=5.0" ;;
esac
exit 0
EOF
# sudo runs the simulated root helper. An old helper does not know reclaim.
fake sudo <<'EOF'
#!/bin/bash
[ "$1" = -n ] && shift; shift
echo "root $*" >>"$F/calls"
case "$1" in
  reclaim) if [ -f "$F/slow-reclaim" ]; then echo $$ >"$F/reclaim.pid"; touch "$F/reclaiming"; exec /bin/sleep 30; fi
    if [ -f "$F/old-helper" ]; then echo "peel-hires-root: unknown verb 'reclaim'. Verbs: latest list" >&2; exit 1; fi
    [ -f "$F/frozen" ] || { echo "peel-hires-root: Android is not frozen; nothing reclaimed" >&2; exit 1; }
    echo "reclaimed Android's memory in standby: 1550 MB -> 290 MB" ;;
  list) echo current=A; echo good=A ;;
  latest) printf 'system 123 system.zip\nvendor 456 vendor.zip\n' ;;
esac
exit 0
EOF
fake systemctl <<'EOF'
#!/bin/bash
echo "systemctl $*" >>"$F/calls"
case "$*" in
  *"is-active peel-hires-session@headless.service") [ -f "$F/session" ] ;;
  *"is-active peel-hires-host.service") [ -f "$F/host-running" ] ;;
  *"is-active"*) exit 1 ;;
  "--user start"*) touch "$F/session" ;;
  "--user stop"*) rm -f "$F/session" "$F/frozen" ;;
esac
EOF
fake pactl <<'EOF'
#!/bin/bash
# Android's stream, while $F/stream exists. A frozen Android's stream may stay listed, uncorked.
if [ -f "$F/stream" ]; then echo '[{"properties": {"application.name": "Waydroid"}, "corked": false}]'; else echo '[]'; fi
EOF
# flock, which can also stand for a Peel's controller that wakes Android while the caller waits
# for the session lock.
fake flock <<'EOF'
#!/bin/bash
# Only the watchdog takes the session lock (7) without waiting.
[ "$*" = "-n 7" ] && [ -f "$F/wake-during-lock" ] && rm -f "$F/frozen" "$XDG_STATE_HOME/peel-hires/standby" "$F/wake-during-lock"
exec /usr/bin/flock "$@"
EOF
fake curl <<'EOF'
#!/bin/bash
printf 000
EOF
fake apkeep <<'EOF'
#!/bin/bash
echo "5.0"
EOF
mkdir -p "$XDG_CACHE_HOME/peel-hires/bin"; cp "$work/bin/apkeep" "$XDG_CACHE_HOME/peel-hires/bin/apkeep"

peel() { set +e; bash "$HIRES/bin/peel-hires" "$@" >"$F/out" 2>&1; echo $? >"$F/rc"; set -e; }
failures=0
expect() {  # expect <description> <command...>
  local name=$1; shift
  if "$@"; then echo "pass $name"; else echo "FAIL $name"; sed 's/^/    /' "$F/calls" "$F/out" 2>/dev/null | tail -20; failures=$((failures + 1)); fi
}
not() { ! "$@"; }
called() { grep -qx "$1" "$F/calls"; }
calls_like() { grep -q "$1" "$F/calls"; }
no_adb_while_frozen() { ! grep -q '^ADB WHILE FROZEN' "$F/calls"; }
running() { [ -f "$F/session" ]; }
frozen() { [ -f "$F/frozen" ]; }
in_standby() { running && frozen && [ -f "$STATE/standby" ]; }
# Whether the first line matching $1 comes before the first matching $2.
before() { local a b; a=$(grep -n "$1" "$F/calls" | head -1 | cut -d: -f1); b=$(grep -n "$2" "$F/calls" | head -1 | cut -d: -f1); [ -n "$a" ] && { [ -z "$b" ] || [ "$a" -lt "$b" ]; }; }
setting() { mkdir -p "$(dirname "$CONFIG")"; printf 'NOTIFY=off\n%s\n' "${1:-}" >"$CONFIG"; }
# A running Android that no Peel uses.
fresh() {
  rm -f "$F"/* ; rm -rf "$STATE"; mkdir -p "$STATE"; : >"$F/calls"; touch "$F/session"; setting
}
# An Android in standby since $1 seconds ago.
asleep() { fresh; touch "$F/frozen"; echo $(( $(date +%s) - ${1:-60} )) >"$STATE/standby"; }

fresh; peel session idle
expect "idle freezes Android instead of stopping it" in_standby
expect "idle stops background apps before freezing" before "am kill-all" "busctl Freeze"
expect "idle asks the root helper to reclaim after freezing" before "busctl Freeze" "root reclaim"
expect "idle does not stop the session" not calls_like "waydroid session stop"
peel session idle
expect "idle in standby leaves it frozen" in_standby
expect "idle in standby does not ask adb" no_adb_while_frozen

fresh; setting STANDBY_HOURS=0; peel session idle
expect "with standby off, idle stops Android" not running
expect "with standby off, idle does not freeze" not called "busctl Freeze"

fresh; touch "$F/stream"; peel session idle
expect "idle leaves Android running while it plays audio" running
expect "idle does not freeze Android while it plays audio" not frozen

fresh; touch "$F/freeze-fails"; peel session idle
expect "a failed freeze stops Android" not running
expect "a failed freeze leaves no standby record" [ ! -f "$STATE/standby" ]

fresh; setting STANDBY_HOURS=soon; peel session idle
expect "an invalid STANDBY_HOURS falls back to standby" in_standby

asleep; peel session stop
expect "session stop stops Android in standby" not running
expect "session stop wakes Android before stopping it" before "busctl Unfreeze" "systemctl --user stop"
expect "session stop clears the standby record" [ ! -f "$STATE/standby" ]

# An old root helper: standby works without reclaim, and says so once per installed helper.
fresh; touch "$F/old-helper"; peel session idle
expect "an old root helper still leaves Android in standby" in_standby
expect "an old root helper is reported" grep -q "reinstall it" "$F/out"
rm -f "$F/frozen"; : >"$F/calls"; peel session idle
expect "an old root helper is asked only once" not called "root reclaim"
expect "an old root helper is not reported again" not grep -q "reinstall it" "$F/out"
expect "a later standby without reclaim still freezes" in_standby

# Reclaiming runs after the session lock is released, and holds neither lock: a Peel that opens
# meanwhile is not held up, and an idle killed by the host leaves no lock behind.
fresh; touch "$F/slow-reclaim"
bash "$HIRES/bin/peel-hires" session idle >"$F/out" 2>&1 </dev/null & idle=$!
for _ in $(seq 100); do [ -f "$F/reclaiming" ] && break; /bin/sleep 0.05; done
expect "a slow reclaim has started" [ -f "$F/reclaiming" ]
expect "the session lock is free while reclaim runs" /usr/bin/flock -n "$STATE/session.lock" true
kill "$idle"; wait "$idle" 2>/dev/null || true
expect "a killed idle leaves the update lock free while reclaim still runs" /usr/bin/flock -n "$STATE/update.lock" true
expect "a killed idle leaves the session lock free while reclaim still runs" /usr/bin/flock -n "$STATE/session.lock" true
expect "the slow reclaim was still running" kill -0 "$(cat "$F/reclaim.pid")"
kill "$(cat "$F/reclaim.pid")" 2>/dev/null || true

# The watchdog leaves a fresh standby alone and stops one older than the limit.
asleep 600; echo 1 >"$STATE/watchdog.strikes"; peel watchdog
expect "the watchdog leaves a fresh standby alone" in_standby
expect "the watchdog does not ask adb while frozen" no_adb_while_frozen
expect "the watchdog counts no strike for standby" [ ! -f "$STATE/watchdog.strikes" ]
expect "the watchdog does not restart Android in standby" not calls_like "systemctl --user start"
asleep $((25 * 3600)); peel watchdog
expect "the watchdog stops a standby older than 24 hours" not running
asleep $((3 * 3600)); setting STANDBY_HOURS=2; peel watchdog
expect "the watchdog follows STANDBY_HOURS" not running
asleep 60; setting STANDBY_HOURS=0; peel watchdog
expect "with standby off, the watchdog stops a frozen Android" not running
# A Peel's controller holds the session lock while it wakes Android: the watchdog leaves it.
asleep $((25 * 3600)); /usr/bin/flock "$STATE/session.lock" /bin/sleep 3 >/dev/null 2>&1 & holder=$!; helpers="$helpers $holder"
for _ in $(seq 50); do /usr/bin/flock -n "$STATE/session.lock" true || break; /bin/sleep 0.05; done
peel watchdog
expect "the watchdog does not wait for a busy session lock" not called "busctl Unfreeze"
expect "the watchdog leaves an expired standby whose lock is busy" in_standby
kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
# A controller woke Android after the watchdog found the standby expired, before it got the lock.
asleep $((25 * 3600)); touch "$F/wake-during-lock"; peel watchdog
expect "the watchdog checks again under the lock and leaves a woken Android running" running
expect "the watchdog does not stop a woken Android" not calls_like "waydroid session stop"
expect "the controller woke Android only once the watchdog asked for the lock" [ ! -f "$F/wake-during-lock" ]

# The controller wakes Android before it pings the controller still running in it.
asleep
h=$(sha256sum "$HIRES/android/control/Control.java" | cut -c1-12)
mkdir -p "$XDG_CACHE_HOME/peel-hires/control/Control-$h"; touch "$XDG_CACHE_HOME/peel-hires/control/Control-$h/classes.dex"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 - "$port" <<'EOF' &
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(5)
while True:
    c, _ = s.accept(); f = c.makefile("rw"); f.readline(); f.write('{"ok":true}\n'); f.flush(); c.close()
EOF
server=$!
printf '{"host":"127.0.0.1","port":%s,"key":"k","build":"Control-%s","apk":"/data/app/apple/base.apk"}' "$port" "$h" >"$STATE/controller.json"
for _ in $(seq 50); do python3 -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1)' "$port" 2>/dev/null && break; /bin/sleep 0.1; done
peel controller
expect "the controller succeeds after standby" [ "$(cat "$F/rc")" = 0 ]
expect "the controller wakes Android before using adb" before "busctl Unfreeze" "^adb "
expect "the controller does not ask adb while frozen" no_adb_while_frozen
expect "the controller reuses the running controller" not calls_like "systemctl --user start"
expect "the controller leaves Android awake" not frozen
kill "$server" 2>/dev/null || true; server=

# Update and trim wake Android and put it back into standby when they end.
asleep
seen=$(bash -c "set -euo pipefail; HIRES='$HIRES'; ROOT_HELPER=/usr/local/libexec/peel-hires/peel-hires-root
  root() { sudo -n \"\$ROOT_HELPER\" \"\$@\"; }; die() { exit 1; }
  $(sed -n -e '/^latest() {/p' -e '/^host_versions() {/p' -e '/^build_sources() {/,/^}/p' -e '/^inputs_hash() {/,/^}/p' "$HIRES/bin/peel-hires")
  echo \"\$(latest | awk '{print \$2}' | tr '\n' ' ')\$(inputs_hash) \$(host_versions | sha256sum | cut -c1-8)\"" 2>/dev/null)
echo "$seen" >"$STATE/seen"; : >"$F/calls"
peel update
expect "an update in standby passes" [ "$(cat "$F/rc")" = 0 ]
expect "an update wakes Android before using adb" before "busctl Unfreeze" "^adb "
expect "an update does not ask adb while frozen" no_adb_while_frozen
expect "an update trims Android" called "adb -s 192.0.2.10:5555 shell am force-stop com.apple.android.music"
expect "an update puts Android back into standby" in_standby
expect "an update does not stop Android" not calls_like "waydroid session stop"
asleep; peel trim
expect "trim wakes Android before using adb" before "busctl Unfreeze" "^adb "
expect "trim does not ask adb while frozen" no_adb_while_frozen
expect "trim restarts Apple Music" called "adb -s 192.0.2.10:5555 shell am force-stop com.apple.android.music"
expect "trim puts Android back into standby" in_standby
fresh; touch "$F/host-running"; peel trim
expect "trim without standby leaves Android to the Peel using it" running
fresh; rm "$F/session"; peel trim
expect "trim leaves a stopped Android stopped" not running

# A frozen Android plays nothing, and neither check asks adb.
asleep; touch "$F/stream"
check_frozen() { bash -c ". '$HIRES/bin/peel-hires' help >/dev/null; $1" >/dev/null 2>&1; }
expect "apple_playing is false while frozen" not check_frozen apple_playing
expect "android_streaming is false while frozen, even with an open stream" not check_frozen android_streaming
expect "neither asks adb while frozen" no_adb_while_frozen
fresh; touch "$F/stream"
expect "android_streaming sees an awake Android's stream" check_frozen android_streaming

# Status shows standby without running a shell in the frozen Android.
asleep 3600; peel status
expect "status shows standby" grep -q "^standby since " "$F/out"
expect "status does not probe a frozen Android" not called "root probe"

# The root helper's reclaim, against a simulated cgroup tree and LXC.
R=$work/root; mkdir -p "$R/bin" "$R/proc/4242" "$R/cg/lxc.payload.waydroid/init"
cat >"$R/bin/lxc-info" <<'EOF'
#!/bin/bash
case "$*" in *-sH) cat "$R/state" ;; *-pH) echo 4242 ;; esac
EOF
chmod +x "$R/bin/lxc-info"
echo "0::/lxc.payload.waydroid/init" >"$R/proc/4242/cgroup"
cg=$R/cg/lxc.payload.waydroid
reclaim() {  # runs cmd_reclaim as the helper defines it; prints what it wrote to memory.reclaim
  : >"$cg/memory.reclaim"
  set +e
  ( export R; PATH=$R/bin:$PATH; LXC_PATH=/var/lib/waydroid/lxc LXC_NAME=waydroid CGROUPS=$R/cg PROC=$R/proc
    die() { echo "die: $*"; exit 1; }
    RECLAIM_SECONDS=${RECLAIM_SECONDS:-5}
    eval "$(sed -n -e '/^container_state() {/p' -e '/^frozen_cgroup() {/,/^}/p' -e '/^cmd_reclaim() {/,/^}/p' "$HIRES/root/peel-hires-root")"
    cmd_reclaim ) >"$R/out" 2>&1
  echo $? >"$R/rc"; set -e
}
# memory.current is 200 MB; the frozen flag sits on the container's cgroup, its child inherits it.
setcg() { echo "$1" >"$R/state"; echo "$2" >"$cg/cgroup.freeze"; echo "populated 1" >"$cg/cgroup.events"; echo "frozen $3" >>"$cg/cgroup.events"
  echo 0 >"$cg/init/cgroup.freeze"; echo 209715200 >"$cg/memory.current"; }
reclaimed() { [ -s "$cg/memory.reclaim" ]; }
setcg RUNNING 0 0; reclaim
expect "reclaim refuses while the container runs" not reclaimed
expect "reclaim fails while the container runs" [ "$(cat "$R/rc")" != 0 ]
setcg FROZEN 0 0; reclaim
expect "reclaim refuses when LXC says frozen but the cgroup is not" not reclaimed
setcg FROZEN 1 0; reclaim
expect "reclaim refuses while the cgroup is still freezing" not reclaimed
setcg RUNNING 1 1; reclaim
expect "reclaim refuses when LXC says running" not reclaimed
setcg FROZEN 1 1; reclaim
expect "reclaim writes to a frozen container's memory.reclaim" reclaimed
expect "reclaim succeeds while frozen" [ "$(cat "$R/rc")" = 0 ]
# Every 64 MB step succeeds, but takes a second: 1.5 GB would take 25 seconds without a deadline.
setcg FROZEN 1 1; echo 1610612736 >"$cg/memory.current"; rm -f "$cg/memory.reclaim"; mkfifo "$cg/memory.reclaim"
( while :; do /bin/sleep 1; cat "$cg/memory.reclaim"; done ) >/dev/null 2>&1 & reader=$!; helpers="$helpers $reader"
start=$SECONDS
set +e
( export R; PATH=$R/bin:$PATH; LXC_PATH=/var/lib/waydroid/lxc LXC_NAME=waydroid CGROUPS=$R/cg PROC=$R/proc RECLAIM_SECONDS=2
  die() { echo "die: $*"; exit 1; }
  eval "$(sed -n -e '/^container_state() {/p' -e '/^frozen_cgroup() {/,/^}/p' -e '/^cmd_reclaim() {/,/^}/p' "$HIRES/root/peel-hires-root")"
  cmd_reclaim ) >"$R/out" 2>&1
set -e
expect "reclaim stops at its deadline when every step is slow" [ $((SECONDS - start)) -le 4 ]
expect "reclaim made progress before its deadline" grep -q "MB -> " "$R/out"
kill "$reader" 2>/dev/null || true; wait "$reader" 2>/dev/null || true
# A reader that was waiting for the next step ends once a writer opens the pipe.
timeout 1 sh -c ': >"$1"' sh "$cg/memory.reclaim" 2>/dev/null || true
rm -f "$cg/memory.reclaim"; touch "$cg/memory.reclaim"; echo 209715200 >"$cg/memory.current"
echo "0::/../lxc.payload.waydroid" >"$R/proc/4242/cgroup"; reclaim
expect "reclaim refuses a cgroup path that climbs out" not reclaimed

# probe gives up on a shell in Android that does not return, as one attached to an Android
# frozen between its check and the shell.
mkdir -p "$R/probe-bin" "$R/build"
printf '#!/bin/bash\ncase "$1" in status) printf "Session:\\tRUNNING\\nContainer:\\tRUNNING\\n" ;; shell) exec /bin/sleep 60 ;; esac\n' >"$R/probe-bin/waydroid"
chmod +x "$R/probe-bin/waydroid"; echo RUNNING >"$R/state"
start=$SECONDS
set +e
( export R; PATH=$R/probe-bin:$R/bin:$PATH; LXC_PATH=/var/lib/waydroid/lxc LXC_NAME=waydroid BUILD=$R/build PROBE_SECONDS=1
  eval "$(sed -n -e '/^container_state() {/p' -e '/^in_android() {/,/^}/p' -e '/^cmd_probe() {/,/^}/p' "$HIRES/root/peel-hires-root")"
  cmd_probe ) >"$R/out" 2>&1
set -e
expect "probe gives up on a shell in Android that hangs" [ $((SECONDS - start)) -le 5 ]
expect "probe reports Android as unreachable then" grep -qx "container=unreachable" "$R/out"
expect "the root helper's reclaim takes no arguments" grep -q 'reclaim)  \[ \$# = 0 \]' "$HIRES/root/peel-hires-root"

[ "$failures" = 0 ]
