#!/usr/bin/env bash
# Downloads castlabs' Electron once, then starts the engine prototype.
set -e
cd "$(dirname "$0")"
version=v44.5.1+wvcus
if [ ! -x .electron/electron ]; then
  mkdir -p .electron
  curl -fsSL -o .electron/electron.zip "https://github.com/castlabs/electron-releases/releases/download/${version}/electron-${version}-linux-x64.zip"
  (cd .electron && unzip -q electron.zip && rm electron.zip)
fi
export PEEL_ENGINE_LAUNCHED=$(date +%s%3N)
exec .electron/electron . "$@"
