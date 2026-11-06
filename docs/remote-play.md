# Devices and remote play

Every Peel on the same network is a device. Any Peel can choose which device plays the music and control it. The [README](../README.md#devices) describes how to use it. This page describes how it works.

## Finding devices

Each Peel sends a small UDP broadcast every three seconds on port 10771, to `255.255.255.255` and to each network's broadcast address. It names the device, its TCP port, and the IDs of the group keys it holds. The IDs are hashes, so the keys themselves never appear. A Peel that hears a new device answers it directly, so both list each other within a second.

A device ID is a random UUID saved in `devices.json` in Peel's settings folder. Two Peels on one computer share it. Only the one that listens on the device port runs the devices: it pairs, keeps the keys, and talks to other devices. Another window shows a note in its popup and takes over when the first one closes, so pairing and forgetting devices always happen in one place.

## Pairing

Paired devices share group keys: random 32-byte secrets saved in `devices.json`, which only you can read.

Pairing is a numeric comparison, like Bluetooth's.

1. The device that asks sends a commitment, a hash of a fresh X25519 key.
2. The other device answers with its own X25519 key.
3. The first device reveals its key. The other checks it against the commitment.
4. Both derive a six-digit code from the shared secret and show it.

A device between the two would have to commit to its key before it sees the other's key, so it cannot choose keys that make both codes match. It succeeds by chance once in a million attempts. After both people accept, each device sends its group keys and the devices it knows, encrypted with the pairing keys. Paired devices also exchange keys whenever they connect, so a device paired with any member of a group reaches all of them.

A device accepts pairing requests only for two minutes after someone opened its devices popup. Only one pairing request is open at a time. After you decline one, Peel refuses every pairing request for 30 seconds. "Forget paired devices" in Settings replaces this computer's keys with a new key and closes every connection, including handshakes still in progress, so the old group can no longer reach it.

Announcements are not authenticated. Peel remembers a device only after its session proves it holds a shared key, lists at most 64 nearby devices, opens at most eight connections at a time, and closes a connection that has not finished its handshake within ten seconds.

## Sessions

Paired devices connect over TCP port 10770 and send one message per line. A connection that has not proven it is paired may send at most 16 KB per message. Devices check each other every two seconds and answer from their last known playback, without waiting for their engine, so a slow engine does not look like a lost device. Two missed checks in a row, about ten seconds, mark a device offline, as when a computer goes to sleep. Peel handles each message on the next turn of the event loop, because on Windows Bun stopped reading a socket that sent a request from inside its read callback and got the reply at once. The handshake mixes a shared group key with a fresh X25519 exchange. Each side proves it holds the key, and a device without it learns nothing. Every message after that is AES-256-GCM, numbered in each direction, so a changed, replayed, or reordered message ends the session. Each Peel connects to every paired device it hears. Paired devices also tell each other their IPv4 addresses on every network, Tailscale's included, when they connect and every two seconds after. A paired device that is not connected is tried at each of its addresses in turn, every few seconds, so devices away from home reconnect over Tailscale. When a device connected another way announces itself on the same network, Peel connects to it there. The other connection takes no new requests and closes once its answers are in. A device already reached on this network keeps its connection, even when it announces itself from a second network card. Addresses from other devices are checked: loopback, link-local, multicast, broadcast, and invalid addresses are refused, and only a device itself changes how it is reached. You never choose how a device is reached.

The popups blank the cells under them without painting a background, so the terminal's background and translucency show through them as in the rest of Peel.

Another device can read this computer's engine state and send it playback commands: play, pause, skip, seek, volume, shuffle, repeat, queue edits, ratings, and moving a queue. It cannot read the Apple sign-in, change the stream quality, or stop the engine. Engine requests from another device start this computer's engine when it is not running, as a song chosen here would.

## Network use

Only the device that plays streams music, straight from Apple, at 256 or 64 kbps. A Peel that controls another device sends no audio. Measured with a queue of 500 library songs:

| What | When | Size |
| --- | --- | --- |
| Playback state | Every second, while a Peel controls another device | 0.6 KB |
| Status check | Every two seconds, between connected devices | about 0.3 KB each way |
| Added songs | When the Queue view is open and the queue changes | 0.1 KB plus about 0.2 KB per added song |
| Moving the music | Each move | about 13 KB |
| Announcement | Every three seconds, on the local network only | about 0.2 KB |

Controlling a device needs about 1 KB/s, so it works over a weak mobile connection or a Tailscale relay. The state names the queue by an 8-character fingerprint instead of every song's ID, the Queue view asks only for the added songs, and messages larger than 2 KB are compressed before they are encrypted. Messages that carry group keys are never compressed, since compressed sizes can reveal parts of a secret.

## Which device plays

Each device keeps a claim: the device it thinks plays, with a generation number. A device that moves the music raises the generation by one and tells every device it is connected to. Devices also exchange claims every two seconds. A higher generation wins, and the larger device ID breaks a tie, so all devices end up agreeing, even when two moved the music at the same moment. A device that loses the music to another pauses its own engine.

Before anyone chose a device, every device claims itself at generation 0, which no other device adopts. The first song started on any paired device claims it at generation 1, so the others follow it.

Every Peel controls the claimed device while it can reach it. When that device goes offline, Peel controls this computer. Starting music here then makes this computer the claimed device, so a device that comes back later does not take the music away again.

## Moving the music

Moving the music to a device pauses the device that played, reads its queue with the engine's `exportPlayback`, and sends it to the new device's `importPlayback`. The export includes every queued song, the playing place, the songs you added, the position, repeat, and shuffle. The new device keeps its own volume. If the new device answers that the import failed, it pauses, the old device plays again, and the claim does not change. If the new device stops answering during the import, it may still start the music, so the old device stays paused instead, and Peel says so. Two devices never play at once. If the device that plays cannot be read at all, nothing moves and the claim stays. Once the import worked, the old device stops instead of staying paused. Apple may allow one stream per account, and a paused player still holds it, so a paused old device could stop the new one, for example when it reconnects after its network dropped.

MusicKit reports every queued song as type `song`, so the export marks library songs by their library ID. MusicKit can leave out a song it cannot play. The import then matches each queued song to the exported one by ID, so the added songs and the song to start with stay right. If the song to start with was left out, the next one starts from its beginning. The engine logs playback errors and stopped playback with the song and position, in `engine.log` or in the `peel-engine` unit's journal.

These limits apply:

- Turning shuffle on again mixes the songs after the playing one anew, so the upcoming order can differ from the old device's.
- The album or playlist the songs came from is not part of the queue. The songs themselves move.
- A paused queue starts muted on the new device to reach its position, then pauses.
- Library songs play only on devices signed in to the same Apple account.
- Apple may allow one stream per account at a time, which fits moving the music. Two devices that play different music at once may stop each other.
- A device appears only while Peel is open on it. Closing Peel there stops its music.
- Devices on different networks reach each other only through an address they can both reach, such as Tailscale. Pair them once on the same network first. Peel does not relay through the internet itself.

## SSH

`peel --remote <ssh-host>` still controls an SSH host's player without moving the music. Install the same Peel version on both computers, and check that `ssh <host>` works with a key. The host needs a running desktop session for Electron.

The host's music keeps playing while a controller or a Peel on the host is open. Once the last of them closes, the host's engine quits and the music stops, as it does for devices. Settings shows "Control over SSH" once a host is added. The devices popup does not list SSH hosts, so each computer appears there once. Choosing a device in the popup ends SSH control. `peel --local` returns to this computer. `peel --stop-host` on the host stops its engine at once.

The SSH helper starts through `~/.local/bin/peel`, which the Linux and macOS installers create. Windows can control a host through its OpenSSH client. Hosting on Windows needs a compatible remote launcher and is not tested.
