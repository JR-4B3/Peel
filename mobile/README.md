# Peel on phones

Status: design and plan. Nothing here runs yet. Open [`concept.html`](concept.html) in a browser to see the layout.

The goal is a phone that is a full Peel device. It plays Hi-Res Lossless itself through a USB DAC, and it can control the computers and send music to them, as every Peel can today.

## Layout

The concept keeps the terminal app's look: panels with their titles in the border, Peel's colours and monospace type, stacked in one column.

- Four tabs at the bottom: Home, Library, Queue and Settings.
- Library holds songs, albums, artists and playlists, switched by a row at the top.
- Screens opened on top of a tab, such as lyrics or an album, show a `‹` back arrow in their panel title. There are no text hints like "swipe down to close".
- The player sits above the tabs and says where the music plays, for example "Playing on main". Tapping the device name sends the music to another device.
- Settings has the desktop's settings: audio quality, update channel, and hearts in Favourite Songs.

A native iPhone app would draw Peel's panels as its content and use Apple's standard controls around them, such as the tab bar and sheets.

## Plan

### 1. Phone as a remote

The computer that plays serves a small web app, which the phone adds to its home screen. It shows the screens from the concept and sends the same commands a Peel window sends: play, pause, skip, seek, queue edits, hearts, and moving the music between devices.

This works on iPhone and Android with no developer account and no app signing. The phone plays nothing itself. The computer does, in hi-res where it's set up.

Work:

- A small HTTP server in Peel that serves the app and forwards commands to whichever device plays, with the same allowlist that paired devices use.
- Pairing a phone with the six-digit code the devices popup already shows. Whether the browser can run the same X25519 handshake through WebCrypto on every phone needs testing. A QR code with a one-time key is the fallback.
- Reaching the computer from outside home through Tailscale, as devices do today.

### 2. iPhone that plays hi-res

A native app in SwiftUI. It plays through MusicKit's `SystemMusicPlayer`, which drives the Music app's own player. That player plays Lossless and Hi-Res Lossless, up to 24-bit/192 kHz, through a USB DAC when the listener turns on Lossless in the Music app's settings. The app joins the device network as a device, so music moves between the phone and the computers.

Before building the app, a test app has to answer three questions on a real iPhone with a DAC:

1. Does `SystemMusicPlayer` start any song, album or queue Peel picks, with the Music app's lossless setting?
2. Can the app read the queue and the position back, so the music can move from the phone to a computer?
3. Does a free Apple account allow MusicKit, or does it need the paid developer program?

Work after that:

- The device protocol in Swift. `src/link.ts` uses X25519, HKDF, HMAC, SHA-256, AES-256-GCM and raw deflate. CryptoKit has the first five, and Apple's Compression framework has raw deflate.
- The screens from the concept, and the library and search through Apple's MusicKit catalog API.
- Builds on the Mac with Xcode.

Distribution: a free Apple account signs an app for 7 days and allows three of them on a phone. SideStore can renew the signature on the phone. The paid developer program, 99 USD a year, signs for a year and opens TestFlight.

### 3. Android

Apple Music's Android app plays hi-res through a USB DAC too. An Android Peel could control it the way the hi-res host does on Linux, through Android's media session API, which a normal app may use with notification access. Whether that can start any song Peel picks without root is open. This waits until the iPhone app works.

## What stays the same

The device that plays holds the queue. A phone is one more device, so the pairing, the claim of which device plays, and moving the music work as [docs/remote-play.md](../docs/remote-play.md) describes.
