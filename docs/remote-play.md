# Desktop remote control

Peel can control another computer through SSH. The playback computer owns the audio and queue. Every controller reads that same queue. No audio plays on the controller and no engine port opens to the network.

## Setup

Install the same Peel version on both computers. On the playback computer, run `peel --connect` once to sign in. Enable SSH access and verify that `ssh main` works from the controller with an SSH key. The host needs a running desktop session for Electron.

On the controller, run `peel --remote main`. This saves `main` as the playback target. Later launches keep using it. Add another host with `peel --remote <ssh-host>`.

In Settings, click "Control playback on" to cycle through this computer and saved hosts. The player names the remote host beside the song. Play, pause, next, previous, seek, volume, favourites, and queue controls all use the selected engine.

Closing a controller leaves the remote engine playing. Reopening Peel reads its queue again. Run `peel --stop-host` on the host to shut down a retained engine. Rebooting or upgrading the host engine clears its in-memory queue.

Use `peel --local` to return to this computer's engine. This changes which computer you control. It does not move music or a queue between engines. Selecting a remote host pauses local playback. Leaving a remote host keeps its music playing for other controllers. A failed remote connection never starts the local player as a fallback. Commands with a lost response are not replayed.

The SSH helper starts through `~/.local/bin/peel`, which the Linux and macOS installers create. Windows can control a host through its OpenSSH client. Hosting on Windows needs a compatible remote launcher and is not tested.

## Remaining work

Moving the queue and playback position between output computers, automatic discovery, and high-resolution playback still need implementation. The current engine uses Apple's MusicKit web player at 256 or 64 kbps AAC. Linux's experimental Waydroid hi-res pipeline is separate.

Mobile and synchronized room audio are outside this change.
