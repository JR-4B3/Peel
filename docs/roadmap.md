# Roadmap

Updated 8 November 2026.

## Where Peel is

Peel started on 1 October 2026. Everything below is on `main` and in the nightly build:

- The terminal app on Linux, macOS and Windows, playing through its own MusicKit engine.
- Home, search, Favourite Songs, playlists, albums and artists, filters and sorting, the queue, lyrics and hearts.
- Hi-Res Lossless on Linux through Apple Music's Android app in Waydroid, at each song's own sample rate, with nightly updates that test themselves and roll back.
- Devices: pairing, moving the music between computers, and control from any Peel, also away from home through Tailscale.
- Release installs that update themselves from the nightly or stable channel.

## First stable release, v0.1.0

The stable channel has no release yet. Before tagging `v0.1.0`:

1. Merge the open pull requests: the signed Windows engine, the device display fixes, and the clean-up that removes Cider.
2. Fix the open issues that a listener can hit: hi-res recovery after Apple Music restarts or stops streaming (#59, #60), the web engine left running after a restart into hi-res (#63), lost settings (#64) and the wrong copy of a repeated song (#65).
3. Install Peel on a Windows PC from scratch and play a song. It has only been tested on Linux and macOS.
4. Run a week of daily use on the nightly with no new playback bugs.

## Next

- **Peel as one app.** Group Peel's processes so system monitors show one entry with its total memory, Android included, and show that total in Settings (#61).
- **Peel on phones.** First a remote that runs in the phone's browser, then an iPhone app that plays Hi-Res Lossless through a USB DAC and joins the device network. [mobile/README.md](../mobile/README.md) has the design and the open questions.

## Ideas, not scheduled

- Hi-res on macOS through Apple's Music app, which already plays it. Peel would need to start any song and read the queue there.
- Playing the same music in several rooms at once.
- An App Store release. It needs the paid developer program and Apple's review, and makes sense only once the iPhone app works.

## Dropped

- Cider. Peel played through Cider before it had its own engine. Peel's engine and the hi-res host replaced it, and the code was removed in November 2026.
