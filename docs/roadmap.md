# Roadmap

Updated 12 November 2026.

## Where Peel is

Peel started on 1 October 2026. Everything below is on `main` and in the nightly build:

- The terminal app on Linux, macOS and Windows, playing through its own MusicKit engine.
- Home, search, Favourite Songs, playlists, albums and artists, filters and sorting, the queue, lyrics and hearts.
- Hi-Res Lossless on Linux through Apple Music's Android app in Waydroid, at each song's own sample rate, with nightly updates that test themselves and roll back.
- Hi-res plays playlists of any length, also over about 500 songs, and restarts Apple Music when it plays only silence. Library songs whose catalog ID Apple no longer has play under their second ID, so a click plays the song chosen.
- Android for hi-res boots in about 6 seconds instead of 37, and it stops when the last Peel closes, so it holds no memory while nobody listens.
- Devices: pairing, moving the music between computers, and control from any Peel, also away from home through Tailscale.
- Release installs that update themselves from the nightly or stable channel. v0.1.0 is the first stable release, and nightlies are 0.1.1.
- The mouse wheel over the player changes the volume, and Settings has a Text size row for Peel's Ghostty menu entry and Mac app.
- Settings shows how much memory Peel uses, and system monitors show it as one app.

## In review

These pull requests are open and not on `main` yet:

- [#101](https://github.com/JR-4B3/Peel/pull/101) restarts a hi-res host that still runs code from before an update. Such a host made Peel play a song a few rows further down than the one chosen.
- [#102](https://github.com/JR-4B3/Peel/pull/102) splits `src/ui.ts` (1,387 lines) into `src/ui/`, one file per part of the screen. Nothing changes for the listener.
- [#103](https://github.com/JR-4B3/Peel/pull/103), stacked on #102, redesigns the interface after the mocks. Search moves into a top row, and the player takes four rows with the controls centred. A quality tag names the sample rate, such as "Hi-Res Lossless · 96 kHz". The sidebar has two groups, Library and Playlists. Song lists get a Year column and show their song count. The filter bar stays inside its panel at every width.
- [#104](https://github.com/JR-4B3/Peel/pull/104) fixes [#99](https://github.com/JR-4B3/Peel/issues/99). Android's audio driver gets a larger buffer and no longer waits forever on a device that takes nothing. It changes the Android image, so it needs a nightly build and a played song before it merges.

## Next

- **The song-list filter.** The filter works, but not the way it should yet. #103 keeps its bar inside the panel. The redesign of how the filter works is still open, and it comes first once the pull requests in review merge.
- **The rest of the mocks.** The mocks also drew an Up next tab that shows what plays after the queued songs, a Recently added shelf (#88), a menu on every row (#83) and filter suggestions. #103 left them out on purpose, because they need new engine or Apple calls.
- **Windows.** Install Peel on a Windows PC from scratch and play a song. Windows has been tested much less than Linux and macOS.
- **Hi-res recovery after a night of updates.** Peel restarts Apple Music in Android when it stops streaming (#60) or plays only silence (#94), and continues the song where it was. Both issues are closed, and both recoveries work on a real computer. Confirm them after a night of updates, together with #101, which restarts a hi-res host left over from the day before.
- **Less memory while listening.** Android's container holds about 1.6 GB while hi-res plays, and Apple Music takes 325 to 515 MB of that. Peel should stay light next to a browser on an ordinary computer ([#72](https://github.com/JR-4B3/Peel/issues/72)).
- **Peel on phones.** An iPhone and iPad app in SwiftUI that plays Hi-Res Lossless itself through a USB DAC and joins the device network, then Android. [mobile/README.md](../mobile/README.md) has the design and the open questions.

## Open issues by size and importance

Size comes from a code review of each issue. Small means under about 150 changed lines and no new dependency. Large means new Apple API calls, a new dependency, a new playback contract, or work on every platform. Importance is how much the issue brings Peel closer to a complete, light Apple Music player that people other than its author install.

| Issue | Size | Importance | Why |
| --- | --- | --- | --- |
| [#99](https://github.com/JR-4B3/Peel/issues/99) silence after a switch to 88.2 kHz | Small, fix in #104 | High | On a 48 kHz-only output, the first song above 48 kHz silences hi-res until Android restarts, and Android keeps running after the last Peel closes. #104 fixes the driver and needs a played test on a new Android image. |
| [#73](https://github.com/JR-4B3/Peel/issues/73) bit-perfect test failed once | Small to medium | High | This test decides whether a nightly hi-res release stays or rolls back. A test that fails without a cause can roll back a good release or hide a bad one. #98 added a check for all-zero samples in Android's PipeWire stream, but `peel-hires test` does not use it. |
| [#75](https://github.com/JR-4B3/Peel/issues/75) measure click-to-sound | Large | High | A slow first song is the first thing a listener notices. Hi-res reports "playing" while it still buffers, so measuring the real first sound needs a new state, not a timer. The silence check from #98 runs every 5 seconds and skips a song's first 3 seconds, so it cannot time the first sound. One shared probe that tells when sound comes out would serve both this issue and #73. |
| [#72](https://github.com/JR-4B3/Peel/issues/72) cheaper hi-res | Large | High | 1.6 GB while listening is too much on an ordinary computer. Removing the home screen app (about 80 MB) and merging Peel's two helpers inside Android are the next steps to try. |
| [#92](https://github.com/JR-4B3/Peel/issues/92) install without Bun | Large | High | Needing Bun and a clone is the biggest hurdle for new users. The updater, the hi-res host and the engine lookup all assume Bun runs the source, so all three change. |
| [#80](https://github.com/JR-4B3/Peel/issues/80) edit playlists | Large | High | Playlists are core to Apple Music. Peel reads them but changes nothing, and the Apple calls for creating, renaming and reordering need checking first. |
| [#82](https://github.com/JR-4B3/Peel/issues/82) add to the library | Large | High | Without it, a song found in search can be played but not kept. Library membership is a different state from a heart, so it needs its own field and calls. |
| [#86](https://github.com/JR-4B3/Peel/issues/86) MPRIS on Linux | Large, new dependency | High | Media keys, the desktop's media panel and headphone buttons on Linux all go through MPRIS. Without it Peel only reacts inside its own window. |
| [#88](https://github.com/JR-4B3/Peel/issues/88) Recently added, Radio, Made for you | Large; Recently added alone is small to medium | Medium | Recently added is worth doing on its own soon, and the mocks already draw its shelf on Home. Radio needs a station playback contract that no engine has yet. |
| [#89](https://github.com/JR-4B3/Peel/issues/89) song-change notification | Large | Medium | Useful when Peel is in the background. A plain notification on Linux is small; actions and notifications on macOS and Windows make it large. |
| [#83](https://github.com/JR-4B3/Peel/issues/83) menu on every row | Large | Medium | It helps mouse users, and the mocks draw it, but two of its actions need #80 and #82 first. |
| [#76](https://github.com/JR-4B3/Peel/issues/76) bigger click targets | Medium | Medium | The play controls are small for a mouse. #103 gives them a centred row of their own, but each is still one glyph on one row. The clipped-button test from #79 now guards the layout while it changes. |
| [#91](https://github.com/JR-4B3/Peel/issues/91) themes | Medium to large; bundled palettes alone are small | Low to medium | Colours are read once when each part of the screen is built, so switching a theme while Peel runs touches most of the interface. The split in #102 does not change that. |
| [#81](https://github.com/JR-4B3/Peel/issues/81) playlist folders | Large | Low to medium | It is unclear whether Apple's API exposes folders at all. Check that before any interface work. |
| [#84](https://github.com/JR-4B3/Peel/issues/84) Last.fm scrobbling | Large | Low to medium | Popular with some listeners, but it needs sign-in, secure key storage and rules for which of several Peels scrobbles. |
| [#77](https://github.com/JR-4B3/Peel/issues/77) Comfortable density | Medium | Low | Nice for reading, but extra cover downloads and row redraws cost memory and speed, which matter more. |
| [#87](https://github.com/JR-4B3/Peel/issues/87) sidebar sections, pins, width | Large | Low | The sidebar works today. #103 groups it into Library and Playlists, once #102 and #103 merge. Collapsing the groups, pinned albums and artists, the dragged width and the icon-only mode remain. Pins need a new kind of sidebar entry, and the width is fixed in several places. |
| [#85](https://github.com/JR-4B3/Peel/issues/85) Discord presence | Large | Low | It shows others what plays, nothing more. It needs Discord's local socket on three systems. |
| [#78](https://github.com/JR-4B3/Peel/issues/78) text size, larger title | Small (what is left) | Low | The Text size setting shipped. Only the check for a larger now-playing title through kitty's text-sizing protocol in Ghostty is open. |

The order to work in, given size and importance: merge the four pull requests in review first, #102 before #103, and #104 once it has played on a new Android image. Then redesign the filter, and fix #73 with the shared sound probe that #75 needs too. Recently added from #88 follows, then #86 and #92. #80 and #82 come next as one Apple API investigation, since #83 depends on both.

## Ideas, not scheduled

- Hi-res on macOS through Apple's Music app, which already plays it. Peel would need to start any song and read the queue there.
- Playing the same music in several rooms at once.
- An App Store release. It needs the paid developer program and Apple's review, and makes sense only once the iPhone app works.

## Dropped

- Cider. Peel played through Cider before it had its own engine. Peel's engine and the hi-res host replaced it, and the code was removed in November 2026.
