#!/usr/bin/env bash
# Downloads castlabs' Electron once, then starts Peel's playback engine.
set -e
cd "$(dirname "$0")"
version=v44.5.1+wvcus
# Electron's archive has a version file. An install without it, or with another version, is
# replaced. That covers an older version and an unpack that stopped partway.
if [ ! -x .electron/electron ] || [ "$(cat .electron/version 2>/dev/null)" != "${version#v}" ]; then
  # Unpack beside the final folder and rename it into place, so an interrupted download or
  # unpack is never used. The next start removes what it left and tries again.
  partial=.electron.partial
  rm -rf "$partial"
  mkdir -p "$partial"
  curl -fsSL -o "$partial/electron.zip" "https://github.com/castlabs/electron-releases/releases/download/${version}/electron-${version}-linux-x64.zip"
  (cd "$partial" && unzip -q electron.zip && rm electron.zip)
  [ -x "$partial/electron" ] && [ "$(cat "$partial/version")" = "${version#v}" ]
  rm -rf .electron
  mv "$partial" .electron
fi
# Electron cannot always detect Wayland on its own, for example when started outside the desktop session.
platform=--ozone-platform-hint=auto
[ -n "$WAYLAND_DISPLAY" ] && platform=--ozone-platform=wayland
exec .electron/electron . "$platform" "$@"
