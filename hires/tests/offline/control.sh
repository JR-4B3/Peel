#!/bin/bash
# Compiles Peel's controller with the host's JDK, as peel-hires does, and checks how it reads
# AudioFlinger's dump. Skipped without a JDK that has the compiler, since only hi-res machines
# need one.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
command -v java >/dev/null && java --list-modules 2>/dev/null | grep -q '^jdk.compiler@' ||
  { echo "skip the controller's dump reader: no JDK with the compiler"; exit 0; }
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
# javac searches the working folder for classes, so it runs in the empty build folder.
(cd "$build" && java -m jdk.compiler/com.sun.tools.javac.Main -source 17 -target 17 -Xlint:-options -d . \
  "$here/../../android/control/Control.java" "$here/ControlDump.java")
java -cp "$build" ControlDump "$here/audio-flinger.txt"
