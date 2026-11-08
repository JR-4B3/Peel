#!/bin/bash
# One-time setup on the machine that runs Waydroid. Needs sudo once; afterwards the pipeline only
# runs its root-owned helper, which the sudoers rule below allows without a password.
#   sudo ./install.sh <user>     install packages, initialize Waydroid, install the root helper
#                                and the sudoers rule
#   ./install.sh --user          (as the user) install the CLI, systemd units and PipeWire config
set -euo pipefail
HIRES=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = --user ]; then
  mkdir -p ~/.local/bin ~/.config/systemd/user ~/.config/pipewire/pipewire.conf.d
  # In a release install, $HIRES is <root>/versions/<version>/hires. The command then runs the
  # version <root>/current names, so the timers use the newest release after each Peel update
  # instead of the one that ran this script. A source checkout links its own copy.
  versions=$(dirname "$(dirname "$HIRES")")
  if [ "$(basename "$versions")" = versions ] && [ -f "$(dirname "$versions")/current" ]; then
    root=$(dirname "$versions")
    rm -f ~/.local/bin/peel-hires
    printf '#!/bin/sh\n# Runs peel-hires from the Peel release that %s/current names.\nexec "%s/versions/$(cat "%s/current")/hires/bin/peel-hires" "$@"\n' "$root" "$root" "$root" >~/.local/bin/peel-hires
    chmod 755 ~/.local/bin/peel-hires
  else
    ln -sfn "$HIRES/bin/peel-hires" ~/.local/bin/peel-hires
  fi
  cp "$HIRES"/systemd/*.service "$HIRES"/systemd/*.timer ~/.config/systemd/user/
  cp "$HIRES/systemd/50-peel-hires.conf" ~/.config/pipewire/pipewire.conf.d/
  systemctl --user daemon-reload
  systemctl --user enable --now peel-hires-update.timer peel-hires-watchdog.timer
  # Apply the allowed rates now; the config file applies them after PipeWire's next restart.
  pw-metadata -n settings 0 clock.allowed-rates "[ 44100 48000 88200 96000 176400 192000 ]" >/dev/null || true
  echo "installed: peel-hires CLI, systemd units, PipeWire rates"
  echo "next: peel-hires setup"
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo "run with sudo, or with --user for the user part" >&2; exit 1; }
USER_NAME=${1:-${SUDO_USER:?give the user name}}
# Waydroid's images and Apple Music's Android app are x86_64 builds.
[ "$(uname -m)" = x86_64 ] || { echo "hi-res needs an x86_64 PC" >&2; exit 1; }

# Each command the pipeline runs, and the Fedora package that has it. dnf installs what is
# missing. Other distributions install them by hand first; the list says what to look for.
PACKAGES="waydroid:waydroid lxc-start:lxc mkfs.erofs:erofs-utils weston:weston adb:android-tools
  javac:java-21-openjdk-devel keytool:java-21-openjdk-devel python3:python3 curl:curl unzip:unzip
  git:git tar:tar flock:util-linux pactl:pulseaudio-utils pw-metadata:pipewire-utils"
missing=() packages=()
for entry in $PACKAGES; do
  command -v "${entry%%:*}" >/dev/null && continue
  missing+=("${entry%%:*}"); [[ " ${packages[*]} " == *" ${entry#*:} "* ]] || packages+=("${entry#*:}")
done
if [ ${#missing[@]} -gt 0 ]; then
  if command -v dnf >/dev/null; then dnf install -y "${packages[@]}"
  else
    echo "missing commands: ${missing[*]}" >&2
    echo "Install them with your distribution's packages (Fedora names: ${packages[*]}), then run this again." >&2
    exit 1
  fi
fi

# Stock Waydroid, which the first release replaces. Its images give the audio driver build
# Android's libraries, and its config is what the root helper switches.
if [ ! -f /var/lib/waydroid/waydroid.cfg ]; then
  echo "initializing Waydroid (downloads about 1 GB)"
  waydroid init -s VANILLA
fi
systemctl enable --now waydroid-container

install -d -o root -g root -m 755 /usr/local/libexec/peel-hires /var/lib/peel-hires
install -o root -g root -m 755 "$HIRES/root/peel-hires-root" /usr/local/libexec/peel-hires/peel-hires-root
printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/peel-hires/peel-hires-root\n' "$USER_NAME" > /etc/sudoers.d/peel-hires.tmp
chmod 440 /etc/sudoers.d/peel-hires.tmp
visudo -cf /etc/sudoers.d/peel-hires.tmp >/dev/null && mv /etc/sudoers.d/peel-hires.tmp /etc/sudoers.d/peel-hires
echo "installed: packages, Waydroid, root helper and sudoers rule for $USER_NAME"
