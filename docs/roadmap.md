# Roadmap

Updated 8 November 2026.

## Where Peel is

Peel started on 1 October 2026. Everything below is on `main` and in the nightly build:

- The terminal app on Linux, macOS and Windows, playing through its own MusicKit engine.
- Home, search, Favourite Songs, playlists, albums and artists, filters and sorting, the queue, lyrics and hearts.
- Hi-Res Lossless on Linux through Apple Music's Android app in Waydroid, at each song's own sample rate, with nightly updates that test themselves and roll back.
- Devices: pairing, moving the music between computers, and control from any Peel, also away from home through Tailscale.
- Release installs that update themselves from the nightly or stable channel. v0.1.0 is the first stable release.
- Settings shows how much memory Peel uses, and system monitors show it as one app.

## Next

- **The song-list filter.** The filter works, but not the way it should yet. It gets redesigned before anything else.
- **Windows.** Install Peel on a Windows PC from scratch and play a song. Windows has been tested much less than Linux and macOS.
- **Hi-res recovery on real hardware.** Peel now restarts Apple Music in Android when it stops streaming. Confirm it on main after a night of updates.
- **Less memory.** Peel with hi-res uses about 1.2 GB on main, most of it Android. The goal is as little as possible.
- **Peel on phones.** An iPhone and iPad app in SwiftUI that plays Hi-Res Lossless itself through a USB DAC and joins the device network, then Android. [mobile/README.md](../mobile/README.md) has the design and the open questions.

## Ideas, not scheduled

- Hi-res on macOS through Apple's Music app, which already plays it. Peel would need to start any song and read the queue there.
- Playing the same music in several rooms at once.
- An App Store release. It needs the paid developer program and Apple's review, and makes sense only once the iPhone app works.

## Dropped

- Cider. Peel played through Cider before it had its own engine. Peel's engine and the hi-res host replaced it, and the code was removed in November 2026.
