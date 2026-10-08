#!/usr/bin/env bash
# Downloads castlabs' Electron once, then starts Peel's playback engine.
set -e
cd "$(dirname "$0")"
version=v44.5.1+wvcus
if [ ! -x .electron/electron ]; then
  mkdir -p .electron
  curl -fsSL -o .electron/electron.zip "https://github.com/castlabs/electron-releases/releases/download/${version}/electron-${version}-linux-x64.zip"
  (cd .electron && unzip -q electron.zip && rm electron.zip)
fi
# Electron cannot always detect Wayland on its own, for example when started outside the desktop session.
platform=--ozone-platform-hint=auto
[ -n "$WAYLAND_DISPLAY" ] && platform=--ozone-platform=wayland
exec .electron/electron . "$platform" "$@"
