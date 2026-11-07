#!/bin/bash
# One-time setup on the machine that runs Waydroid. Needs sudo once; afterwards the pipeline only
# runs its root-owned helper, which the sudoers rule below allows without a password.
#   sudo ./install.sh <user>     install the root helper and the sudoers rule
#   ./install.sh --user          (as the user) install the CLI, systemd units and PipeWire config
set -euo pipefail
HIRES=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = --user ]; then
  mkdir -p ~/.local/bin ~/.config/systemd/user ~/.config/pipewire/pipewire.conf.d
  ln -sfn "$HIRES/bin/peel-hires" ~/.local/bin/peel-hires
  cp "$HIRES"/systemd/*.service "$HIRES"/systemd/*.timer ~/.config/systemd/user/
  cp "$HIRES/systemd/50-peel-hires.conf" ~/.config/pipewire/pipewire.conf.d/
  systemctl --user daemon-reload
  systemctl --user enable --now peel-hires-update.timer peel-hires-watchdog.timer
  # Apply the allowed rates now; the config file applies them after PipeWire's next restart.
  pw-metadata -n settings 0 clock.allowed-rates "[ 44100 48000 88200 96000 176400 192000 ]" >/dev/null || true
  echo "installed: peel-hires CLI, systemd units, PipeWire rates"
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo "run with sudo, or with --user for the user part" >&2; exit 1; }
USER_NAME=${1:-${SUDO_USER:?give the user name}}
install -d -o root -g root -m 755 /usr/local/libexec/peel-hires /var/lib/peel-hires
install -o root -g root -m 755 "$HIRES/root/peel-hires-root" /usr/local/libexec/peel-hires/peel-hires-root
printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/peel-hires/peel-hires-root\n' "$USER_NAME" > /etc/sudoers.d/peel-hires.tmp
chmod 440 /etc/sudoers.d/peel-hires.tmp
visudo -cf /etc/sudoers.d/peel-hires.tmp >/dev/null && mv /etc/sudoers.d/peel-hires.tmp /etc/sudoers.d/peel-hires
for pkg in waydroid erofs-utils weston android-tools; do command -v dnf >/dev/null && { rpm -q "$pkg" >/dev/null || dnf install -y "$pkg"; }; done
echo "installed: root helper and sudoers rule for $USER_NAME"
