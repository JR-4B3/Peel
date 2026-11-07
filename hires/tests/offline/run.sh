#!/bin/bash
# Tests parts of the hi-res pipeline that run without Waydroid, Android or audio hardware.
# Needs bash, python3 and a C compiler. `bun test` runs it too.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

# The driver's out_write, from its signature to the function after it.
sed -n '/^static ssize_t out_write(/,/^static int out_get_render_position(/p' "$here/../../android/audio_hw.c" | sed '$d' > "$build/out_write.c"
"${CC:-cc}" -std=gnu11 -Wall -Wno-unused-function -I"$build" "$here/hal-write.c" -o "$build/hal-write" -lpthread
timeout 10 "$build/hal-write"
bash "$here/health.sh"
bash "$here/update.sh"
