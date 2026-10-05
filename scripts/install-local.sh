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
mkdir -p "$HOME/.local/bin"
peel_launcher="$HOME/.local/bin/peel"
if [[ -e "$peel_launcher" ]] && ! head -3 "$peel_launcher" | rg -q '^# Peel launcher'; then
  echo 'An existing ~/.local/bin/peel belongs to another program. Leaving it in place.' >&2
  exit 1
fi
{
  printf '#!/usr/bin/env bash\n# Peel launcher\n'
  printf 'cd %q\n' "$peel_project_dir"
  printf 'exec %q src/index.ts "$@"\n' "$peel_bun"
} > "$peel_launcher"
chmod 755 "$peel_launcher"
peel_apps_dir="$HOME/.local/share/applications"
mkdir -p "$peel_apps_dir"
peel_desktop="$peel_apps_dir/peel.desktop"
# Ghostty requires a GTK application ID, which needs at least one dot.
peel_window_class=io.github.jr4b3.peel
if [[ -e "$peel_desktop" ]] && ! rg -q '^X-Peel-Launcher=true$' "$peel_desktop"; then
  echo 'An existing peel.desktop belongs to another program. Leaving it in place.' >&2
  exit 1
fi
# Desktop Exec fields have their own quoting rules, separate from shell quoting.
peel_desktop_launcher=${peel_launcher//\\/\\\\}
peel_desktop_launcher=${peel_desktop_launcher//\"/\\\"}
peel_desktop_launcher=${peel_desktop_launcher//\$/\\\$}
peel_desktop_launcher=${peel_desktop_launcher//\`/\\\`}
peel_desktop_launcher=${peel_desktop_launcher//%/%%}
{
  printf '[Desktop Entry]\nType=Application\nName=Peel\n'
  printf 'Comment=Search your Apple Music library and control playback\n'
  printf 'Icon=multimedia-player\nCategories=AudioVideo;Audio;Music;\nX-Peel-Launcher=true\n'
  # Ghostty shows album covers through the kitty graphics protocol and includes
  # the Nerd Font symbols Peel uses for its controls.
  if command -v ghostty >/dev/null 2>&1; then
    printf 'Terminal=false\nStartupWMClass=%s\n' "$peel_window_class"
    printf 'Exec=ghostty --class=%s --title=Peel --gtk-single-instance=false --confirm-close-surface=false -e "%s"\n' "$peel_window_class" "$peel_desktop_launcher"
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
