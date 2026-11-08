#!/usr/bin/env bash
set -euo pipefail
peel_project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
peel_bun=$(command -v bun || true)
if [[ -z "$peel_bun" && -x "$HOME/.bun/bin/bun" ]]; then
  peel_bun="$HOME/.bun/bin/bun"
fi
if [[ -z "$peel_bun" ]]; then
  echo 'Install Bun before installing Peel.' >&2
  exit 1
fi
cd "$peel_project_dir"
"$peel_bun" install --frozen-lockfile
# A release install (bun src/update.ts install) sets PEEL_RELEASE_ROOT. Its launcher starts whichever
# version $PEEL_RELEASE_ROOT/current names, so updates need no new launcher. The icons are copied
# there, because old versions are removed after an update.
peel_release_root=${PEEL_RELEASE_ROOT:-}
peel_assets_dir="$peel_project_dir/assets"
if [[ -n "$peel_release_root" ]]; then
  mkdir -p "$peel_release_root/assets"
  cp "$peel_project_dir"/assets/peel.* "$peel_release_root/assets/"
  peel_assets_dir="$peel_release_root/assets"
fi
mkdir -p "$HOME/.local/bin"
peel_launcher="$HOME/.local/bin/peel"
if [[ -e "$peel_launcher" ]] && ! head -3 "$peel_launcher" | grep -q '^# Peel launcher'; then
  echo 'An existing ~/.local/bin/peel belongs to another program. Leaving it in place.' >&2
  exit 1
fi
{
  printf '#!/usr/bin/env bash\n# Peel launcher\n'
  if [[ -n "$peel_release_root" ]]; then
    printf 'root=%q\n' "$peel_release_root"
    printf 'cd "$root/versions/$(cat "$root/current")" || exit 1\n'
    # Every version shares one engine download.
    printf 'export PEEL_ELECTRON_DIR="$root/electron"\n'
  else
    printf 'cd %q\n' "$peel_project_dir"
  fi
  printf 'exec %q src/index.ts "$@"\n' "$peel_bun"
} > "$peel_launcher"
chmod 755 "$peel_launcher"
if [[ "$(uname -s)" == Darwin ]]; then
  # macOS opens apps, not desktop entries. Peel.app opens a terminal window that runs the launcher.
  peel_app="$HOME/Applications/Peel.app"
  if [[ -e "$peel_app" && ! -e "$peel_app/Contents/Resources/peel-launcher" ]]; then
    echo 'An existing ~/Applications/Peel.app belongs to another program. Leaving it in place.' >&2
    exit 1
  fi
  mkdir -p "$peel_app/Contents/MacOS" "$peel_app/Contents/Resources"
  printf '%s\n' "$peel_launcher" > "$peel_app/Contents/Resources/peel-launcher"
  cat > "$peel_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Peel</string>
  <key>CFBundleIdentifier</key><string>io.github.jr4b3.peel</string>
  <key>CFBundleName</key><string>Peel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>peel</string>
</dict></plist>
PLIST
  # Ghostty shows album covers and includes the Nerd Font symbols. Terminal.app needs a Nerd Font
  # and shows covers as coloured blocks.
  cat > "$peel_app/Contents/MacOS/Peel" <<'APP'
#!/bin/bash
launcher=$(cat "$(dirname "$0")/../Resources/peel-launcher")
if [[ -d /Applications/Ghostty.app || -d "$HOME/Applications/Ghostty.app" ]]; then
  # With -e, Ghostty asks for confirmation each time another app passes it a command. --command does not.
  # Ghostty runs --command through a shell, so the path is single-quoted for it. A quote in the
  # path becomes '\'' and spaces stay part of the path. sed does the replacement, because macOS's
  # bash 3.2 keeps quotes in a ${var//...} replacement and would break the command.
  # Ghostty already starts the command with "exec -l", so the command must not begin with exec.
  escaped=$(printf '%s' "$launcher" | sed "s/'/'\\\\''/g")
  quoted="'$escaped'"
  # Peel's Text size setting writes ghostty.conf. The ? lets Ghostty start without it.
  config=${PEEL_CONFIG_DIR:-$HOME/Library/Application Support/peel}
  exec open -na Ghostty --args --title=Peel --config-file="?$config/ghostty.conf" --command="$quoted"
fi
exec osascript - "$launcher" <<'SCRIPT'
on run argv
  tell application "Terminal"
    do script "exec " & quoted form of (item 1 of argv)
    activate
  end tell
end run
SCRIPT
APP
  chmod 755 "$peel_app/Contents/MacOS/Peel"
  # iconutil builds the app's icon from the logo's PNG at each size macOS asks for.
  peel_icons=$(mktemp -d)
  mkdir -p "$peel_icons/peel.iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$peel_assets_dir/peel.png" --out "$peel_icons/peel.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$peel_assets_dir/peel.png" --out "$peel_icons/peel.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$peel_app/Contents/Resources/peel.icns" "$peel_icons/peel.iconset"
  rm -rf "$peel_icons"
  printf 'Installed %s and %s. Run peel --connect once, then peel.\n' "$peel_launcher" "$peel_app"
  exit 0
fi
peel_apps_dir="$HOME/.local/share/applications"
mkdir -p "$peel_apps_dir"
peel_desktop="$peel_apps_dir/peel.desktop"
# Ghostty requires a GTK application ID, which needs at least one dot.
peel_window_class=io.github.jr4b3.peel
if [[ -e "$peel_desktop" ]] && ! grep -q '^X-Peel-Launcher=true$' "$peel_desktop"; then
  echo 'An existing peel.desktop belongs to another program. Leaving it in place.' >&2
  exit 1
fi
# Desktop Exec fields have their own quoting rules, separate from shell quoting.
desktop_quote() {
  local value=${1//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  value=${value//\`/\\\`}
  printf '%s' "${value//%/%%}"
}
peel_desktop_launcher=$(desktop_quote "$peel_launcher")
# Peel's Text size setting writes ghostty.conf there (src/config.ts). The ? lets Ghostty start without it.
peel_ghostty_config=$(desktop_quote "${PEEL_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/peel}/ghostty.conf")
{
  printf '[Desktop Entry]\nType=Application\nName=Peel\n'
  printf 'Comment=Search your Apple Music library and control playback\n'
  printf 'Icon=%s\nCategories=AudioVideo;Audio;Music;\nX-Peel-Launcher=true\n' "$peel_assets_dir/peel.svg"
  # Ghostty shows album covers through the kitty graphics protocol and includes
  # the Nerd Font symbols Peel uses for its controls.
  if command -v ghostty >/dev/null 2>&1; then
    printf 'Terminal=false\nStartupWMClass=%s\n' "$peel_window_class"
    printf 'Exec=ghostty --class=%s --title=Peel --gtk-single-instance=false --confirm-close-surface=false "--config-file=?%s" -e "%s"\n' "$peel_window_class" "$peel_ghostty_config" "$peel_desktop_launcher"
  elif command -v kitty >/dev/null 2>&1; then
    printf 'Terminal=false\nStartupWMClass=peel\nExec=kitty --class peel --title Peel "%s"\n' "$peel_desktop_launcher"
  elif command -v alacritty >/dev/null 2>&1; then
    printf 'Terminal=false\nExec=alacritty --title Peel --class peel -e "%s"\n' "$peel_desktop_launcher"
  elif command -v konsole >/dev/null 2>&1; then
    printf 'Terminal=false\nExec=konsole --separate -p tabtitle=Peel -e "%s"\n' "$peel_desktop_launcher"
  else
    printf 'Terminal=true\nExec="%s"\n' "$peel_desktop_launcher"
  fi
} > "$peel_desktop"
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$peel_desktop"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$peel_apps_dir"
fi
printf 'Installed %s and the Peel application entry. Run peel --connect once, then peel.\n' "$peel_launcher"
