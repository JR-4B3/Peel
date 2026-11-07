#!/bin/bash
# Runs peel-hires's real update functions against a simulated root helper, session and build.
# Nothing reaches Waydroid, Android or the installed root helper.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export LC_ALL=C
HIRES=$here/../..
STATE=$work/state
ROOT_HELPER=$work/root-helper
mkdir -p "$STATE"
log() { :; }
die() { printf 'die: %s\n' "$*" >>"$STATE/events"; exit 1; }
notify() { :; }
run_agent() { :; }
remove_old_releases() { :; }
update_apple() { echo update_apple >>"$STATE/events"; }
trim_android() { :; }
host_versions() { echo offline-host; }
latest() { printf 'system 123 system.zip\nvendor 456 vendor.zip\n'; }
apple_ready() { return 0; }
cmd_test() { [ ! -f "$STATE/tests-fail" ]; }
settle_container() { :; }
cmd_session() { echo "session $1" >>"$STATE/events"; [ "$1" = stop ] && rm -f "$STATE/session"; [ "$1" = start ] && touch "$STATE/session"; return 0; }
session_running() { [ -f "$STATE/session" ]; }
apple_playing() { [ -f "$STATE/playing" ]; }
# The root helper's records. Activation fails when asked to and then restores what was current,
# as the real helper's transaction does.
root() {
  case "$1" in
    list) printf 'current=%s\ngood=%s\nprevious=%s\n' "$(cat "$STATE/current")" "$(cat "$STATE/good")" "$(cat "$STATE/previous")" ;;
    activate) echo "activate $2" >>"$STATE/events"; [ -f "$STATE/activate-fails" ] && return 1; echo "$2" >"$STATE/current" ;;
    confirm) local c g; c=$(cat "$STATE/current"); g=$(cat "$STATE/good")
      if [ "$c" != "$g" ]; then echo "$g" >"$STATE/previous"; echo "$c" >"$STATE/good"; fi ;;
    rollback) echo rollback >>"$STATE/events" ;;
  esac
}
cmd_build() { [ -f "$STATE/play-during-build" ] && touch "$STATE/playing"; echo built >>"$STATE/events"; echo C; }

eval "$(sed -n -e '/^build_sources() {/,/^}/p' -e '/^inputs_hash() {/,/^}/p' -e '/^cmd_activate() {/,/^}/p' -e '/^cmd_rollback() {/,/^}/p' \
  -e '/^restore_release() {/,/^}/p' -e '/^postpone() {/,/^}/p' -e '/^cmd_update() {/,/^}/p' "$HIRES/bin/peel-hires")"

failures=0
expect() {  # expect <description> <command...>
  local name=$1; shift
  if "$@"; then echo "pass $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}
# A, the confirmed release, is current, and B is the fallback before it. The session runs.
fresh() {
  rm -f "$STATE"/*
  echo A >"$STATE/current"; echo A >"$STATE/good"; echo B >"$STATE/previous"; touch "$STATE/session" "$STATE/events"
}
# Not inside || or if: bash would ignore set -e in cmd_update, as it never does when peel-hires runs it.
update() { local rc; set +e; (cmd_update "$@") >/dev/null 2>&1; rc=$?; set -e; echo "$rc" >"$STATE/rc"; }
records() { [ "$(cat "$STATE/current") $(cat "$STATE/good") $(cat "$STATE/previous")" = "$1" ]; }
happened() { grep -qx "$1" "$STATE/events"; }
not() { ! "$@"; }
rc() { [ "$(cat "$STATE/rc")" = "$1" ]; }

# Issue #53: the installed root helper is part of the update's fingerprint.
printf 'old helper\n' >"$ROOT_HELPER"; before=$(inputs_hash)
expect "an unchanged helper keeps the fingerprint" [ "$(inputs_hash)" = "$before" ]
printf 'new helper\n' >"$ROOT_HELPER"
expect "a changed helper changes the fingerprint" [ "$(inputs_hash)" != "$before" ]
fresh; update
fresh; echo "$(latest | awk '{print $2}' | tr '\n' ' ')$(inputs_hash) $(host_versions | sha256sum | cut -c1-8)" >"$STATE/seen"
update
expect "an unchanged fingerprint skips the build" not happened built
printf 'another helper\n' >"$ROOT_HELPER"; update
expect "a helper-only change builds and tests" happened built
expect "a helper-only change keeps the release that passed" records "C C A"

# Issue #52: music that starts during the build postpones an ordinary update.
fresh; touch "$STATE/play-during-build"; update
expect "music started during the build postpones" rc 75
expect "a postponed update does not switch" not happened "activate C"
expect "a postponed update leaves the session running" not happened "session stop"
expect "a postponed update does not update Apple Music" not happened update_apple
fresh; touch "$STATE/play-during-build"; update --force
expect "a forced update switches while music plays" happened "activate C"
expect "a forced update passes" rc 0

# Issue #48: a failed activation that the helper already undid needs no second switch.
fresh; touch "$STATE/activate-fails"; update --force
expect "a failed activation fails the update" rc 1
expect "a failed activation does not roll back past A" not happened rollback
expect "a failed activation activates nothing else" [ "$(grep -c '^activate' "$STATE/events")" = 1 ]
expect "a failed activation keeps A, confirmed, with B before it" records "A A B"
expect "a failed activation starts the session again" session_running
# The new release activates but fails its tests: back to A, records unchanged.
fresh; touch "$STATE/tests-fail"; update --force
expect "failed tests fail the update" rc 1
expect "failed tests switch back to A" happened "activate A"
expect "failed tests do not use the relative rollback" not happened rollback
expect "failed tests keep A, confirmed, with B before it" records "A A B"

[ "$failures" = 0 ]
