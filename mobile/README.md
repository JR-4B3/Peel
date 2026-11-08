# Peel on phones

Status: design and plan. Nothing here runs yet. Open [`concept.html`](concept.html) in a browser to see the layout.

The goal is a phone that is a full Peel device. It plays Hi-Res Lossless itself through a USB DAC, and it can control the computers and send music to them, as every Peel can today. It isn't only a remote.

## Layout

The concept keeps the terminal app's look: panels with their titles in the border, Peel's colours and monospace type, stacked in one column.

- Four tabs at the bottom: Home, Library, Queue and Settings.
- Library holds songs, albums, artists and playlists, switched by a row at the top.
- Screens opened on top of a tab, such as lyrics or an album, show a `‹` back arrow in their panel title. There are no text hints like "swipe down to close".
- The player sits above the tabs and says where the music plays, for example "Playing on Desktop". Tapping the device name sends the music to another device.
- Settings has the desktop's settings: audio quality, update channel, and hearts in Favourite Songs.

The app is SwiftUI. Peel's panels, cover grids and rows are custom views with Peel's colours and JetBrains Mono. Apple's standard controls around them, such as the tab bar, navigation bar and search field, get iOS 26's Liquid Glass by themselves. The same layout adapts to the iPad's larger screen.

## Plan

### 1. iPhone and iPad app that plays hi-res

The app plays through MusicKit's `SystemMusicPlayer`, which drives the Music app's own player. That player sends Lossless and Hi-Res Lossless, up to 24-bit/192 kHz, to a USB DAC when the listener turns on Hi-Res Lossless in Settings > Music > Audio Quality. A browser can't do this, because MusicKit JS streams AAC only.

The app joins the device network as a device. Music moves between the phone and the computers, and the phone controls whichever device plays, as every Peel does.

Before building the app, a small test app answers three questions on a real iPhone with a DAC:

1. Does `SystemMusicPlayer` start any song, album or queue Peel picks, with the Music app's lossless setting?
2. Can the app read the queue and the position back, so the music can move from the phone to a computer?
3. Does a free Apple account allow MusicKit, or does it need the paid developer program?

Work after that:

- The device protocol in Swift. `src/link.ts` uses X25519, HKDF, HMAC, SHA-256, AES-256-GCM and raw deflate. CryptoKit has the first five, and Apple's Compression framework has raw deflate.
- The screens from the concept, and the library and search through Apple's MusicKit catalog API.
- Builds on a Mac with Xcode.

### Sideloading

The app is sideloaded unless a community grows around Peel. A free Apple account signs an app for 7 days and allows three apps on a phone. SideStore re-signs it on the phone itself, and a daily Shortcuts automation that runs SideStore's "Refresh All Apps" keeps it from expiring. The paid developer program, 99 USD a year, signs for a year and opens TestFlight.

### 2. Android

Apple Music's Android app plays hi-res through a USB DAC too. An Android Peel could control it the way the hi-res host does on Linux, through Android's media session API, which a normal app may use with notification access. Whether that can start any song Peel picks without root is open. It follows once the iPhone app works.

## What stays the same

The device that plays holds the queue. A phone is one more device, so the pairing, the claim of which device plays, and moving the music work as [docs/remote-play.md](../docs/remote-play.md) describes.
