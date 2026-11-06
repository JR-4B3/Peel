#!/bin/bash
# Runs peel-hires's real check, t_props and t_apple_app against a simulated adb and root helper
# (issue #16). Each case sets ADB_MODE, which the stand-in A function below answers from.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
APPLE=com.apple.android.music
TESTS=()
log() { printf '%s\n' "$*"; }
sleep() { :; }
root() {
  printf '%s\n' build_tags=release-keys zygote=zygote64 apple_installed=1 apple_subscription=1 \
    apple_quality_wifi=HIGH_RES_LOSSLESS "fake_wifi=$APPLE"
}
screen='<?xml version="1.0"?><hierarchy rotation="0"><node text="Listen Now" package="com.apple.android.music"/></hierarchy>'
A() {
  case "$ADB_MODE:$*" in
    down:*) echo "error: device offline" >&2; return 1 ;;
    zygote32:"shell pidof zygote") echo 123 ;;
    *:"shell pidof zygote") return 1 ;;
    nodump:"shell uiautomator dump"*) return 1 ;;
    empty:"shell cat /sdcard/ui.xml") ;;
    rooted:"shell cat /sdcard/ui.xml") echo '<hierarchy><node text="Not Supported on Unrooted Devices"/></hierarchy>' ;;
    *:"shell cat /sdcard/ui.xml") echo "$screen" ;;
    *) ;;
  esac
}
# The functions under test, copied from peel-hires as they are.
eval "$(sed -n -e '/^check() {/,/^}/p' -e '/^t_props() {/,/^}/p' -e '/^t_apple_app() {/,/^}/p' "$here/../../bin/peel-hires")"

failures=0
expect() {  # expect <name> <true|false> <ADB_MODE> <test function>
  local name=$1 want=$2; TESTS=(); ADB_MODE=$3 check "$name" "$4" >/dev/null
  local got; got=$(python3 -c 'import json,sys; print(str(json.loads(sys.argv[1])["pass"]).lower())' "${TESTS[0]}")
  if [ "$got" = "$want" ]; then echo "pass $name ($3)"; else echo "FAIL $name ($3): pass=$got, expected $want"; failures=$((failures + 1)); fi
}
expect apple-music-app false down t_apple_app
expect apple-music-app false nodump t_apple_app
expect apple-music-app false empty t_apple_app
expect apple-music-app false rooted t_apple_app
expect apple-music-app true ok t_apple_app
expect properties false down t_props
expect properties false zygote32 t_props
expect properties true ok t_props
[ "$failures" = 0 ]
