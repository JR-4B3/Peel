# Remote play

Status: plan only. Nothing is built yet.

Goal: control from any device that runs Peel where the music plays, and send it to other rooms. Only an Apple Music subscription may be needed. One subscription streams to one place at a time, so this means "the same music in the rooms you pick", not different songs per room.

## Roles

| Role | Runs there | Hardware |
| --- | --- | --- |
| Source | Peel's engine, or the hi-res pipeline on Linux | A real PC that stays on (t480 or main) |
| Speakers | Snapcast client, AirPlay, or Bluetooth | Anything. A Pi Zero or an old phone is enough |
| Remotes | Peel's terminal app, the phone web app (`mobile` branch), or `ssh` into the source | Anything with a browser or an SSH client |

## Steps

1. The source accepts Peel's existing playback commands (`/playback/toggle`, `/playback/seek`, `/queue/jump` and the rest in `src/engine.ts`) over the network, protected by a key. Today they listen only on `127.0.0.1`.
2. The web frontend for phones, built as a remote (see the `mobile` branch).
3. A device switcher: the "Playing on main ▾" control in every Peel lists the devices running Peel and moves playback between them.
4. Speakers: a Snapcast server on the source sends PipeWire's output to every Snapcast client in sync, lossless (FLAC or PCM). Peel gets an Output screen built on Snapcast's JSON-RPC API, plus PipeWire's AirPlay sink.

## Notes from the checks on 2026-11-05

- PipeWire on main already has the AirPlay sink, RTP, and Snapcast discovery.
- t480's repositories have `snapserver` and `snapclient` 0.34. Main's (Nobara) don't.
- Away from home: self-hosted WireGuard keeps it subscription-only. Tailscale would work but adds an account, so it can only be optional.
- The Mac is off most of the time, so it can't be the source.
