<p align="center">
  <img src="assets/peel.svg" width="112" alt="Peel's logo, a pixel-art apple with its lower half peeled">
</p>

<h1 align="center">Peel</h1>

<p align="center">
  Apple Music in your terminal, on Linux, macOS and Windows.<br>
  Hi-Res Lossless on Linux. Every Peel on your network is a speaker you can send the music to.
</p>

<p align="center">
  <a href="https://github.com/JR-4B3/Peel/actions/workflows/ci.yml"><img src="https://github.com/JR-4B3/Peel/actions/workflows/ci.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/JR-4B3/Peel/releases/tag/nightly"><img src="https://img.shields.io/badge/nightly-download-89b4fa" alt="Nightly build"></a>
</p>

Apple Music has no app for Linux. Peel is one: a keyboard-and-mouse interface for your library, search, playlists, lyrics and queue that runs in a terminal. It plays through its own engine, Apple's MusicKit player inside a hidden Electron window, so you need an Apple Music subscription and nothing else. No developer account, no Cider, no browser tab.

## What it does

- **Your library.** Home shows what you played recently and new releases from artists you marked as favourites. Favourite Songs, your playlists, All songs, Albums and Artists follow in a sidebar you can reorder and trim.
- **Search.** One field at the top finds songs, albums and artists.
- **Song lists you can work with.** Filter by words and years (`kanye 2004-2010`, `90s`, `>2018`), sort by title, artist, album, year or length, show favourites only. A filtered list plays in the order you see.
- **Albums and artists.** Albums and artists are grids of covers. An artist page has Apple's top songs and rows of albums, singles, live albums, compilations and guest appearances.
- **Queue.** `e` adds a song, album or playlist after the songs you already added. Shift+E plays it next. The Queue lists only what you added, and you can reorder or remove it.
- **Lyrics.** `y` shows time-synced lyrics from Apple Music, or from LRCLIB when Apple has none. Choose a line to play from there.
- **Favourites.** `f` hearts the playing song and `l` the open album. Peel reads the rating back from Apple before it shows the heart.
- **Devices.** Every Peel on your network is a device, like Spotify Connect. `d` moves the queue, the song and its position to another computer.
- **Hi-Res Lossless on Linux.** Peel plays Apple's ALAC streams, up to 24-bit/192 kHz, at each song's own sample rate.
- **Updates.** A release install updates itself from the nightly or stable channel.

## Install

Peel runs on Linux, macOS and Windows, on x64 and arm64. It needs [Bun](https://bun.sh) and a terminal with a [Nerd Font](https://www.nerdfonts.com). [Ghostty](https://ghostty.org) has one built in and shows album covers as images. kitty shows them too. Other terminals show covers as coloured blocks.

Clone the repository, then install the newest nightly build:

```sh
git clone https://github.com/JR-4B3/Peel.git
cd Peel
bun src/update.ts install --channel nightly
peel --connect
```

`install` puts Peel in `~/.local/share/peel` (macOS: `~/Library/Application Support/Peel`, Windows: `%LOCALAPPDATA%\Peel`). It also adds the `peel` command and an entry in your application menu, Applications folder or Start menu. The clone isn't needed after that.

`peel --connect` downloads Peel's playback engine for your system, about 110 MB, and checks it against its published checksums. Then Apple's sign-in window opens. Sign in once. After that, open Peel from the menu or run `peel`.

To run straight from the clone instead, for development:

```sh
bun install --frozen-lockfile
bun run connect
bun start
```

`bash scripts/install-local.sh` (Windows: `scripts\install-local.ps1`) adds a launcher and menu entry for the clone.

### Systems

| System | Notes |
| --- | --- |
| Linux | Any glibc distribution, such as Fedora, Nobara, Ubuntu, Debian, Arch or openSUSE. Alpine (musl) can't run the engine. On NixOS, use nix-ld. With a systemd user session the engine runs as the `peel-engine` user unit. |
| macOS | The first start may ask whether your terminal may find devices on the local network. Allow it, or devices won't appear. |
| Windows | Peel downloads a signed engine from the `engine-v44.5.1+wvcus` release. A full install on a Windows PC hasn't been tested yet. |

Widevine on macOS and Windows plays only in a signed player. Peel's maintainer signs castlabs' Electron through castlabs' EVS service and publishes it, so you need no castlabs account. Peel checks once a day for a renewed signature. See [docs/development.md](docs/development.md#signing-the-engine).

## Hi-Res Lossless on Linux

Apple's web player, and so Peel's engine, streams AAC at 256 kbps. Apple decrypts Hi-Res Lossless only inside its own apps. On Linux, Peel runs Apple Music's Android app in a slimmed-down Waydroid on an invisible display, and its audio reaches PipeWire unchanged.

- Each song plays at its own rate, from 44.1 to 192 kHz. Measured bit-exact to a Focusrite Scarlett at 96 and 192 kHz.
- Peel uses it by itself once it's set up. Search, the queue, lyrics and devices work the same. `PEEL_PLAYER=web` switches back to the web engine.
- The first start boots Android, which takes about 37 seconds. After that a new queue starts in about 50 ms.
- A timer updates Android and Apple Music every night when nothing plays. It runs tests after each update and goes back to the last working version if they fail.

Setup needs an x86_64 PC and sudo once. [hires/README.md](hires/README.md) has the steps.

## Devices

Open Peel on two computers on the same network and press `d` on both. Choose the other computer under nearby devices, and check that both screens show the same six-digit code. You pair once, and a third computer joins the whole group with one more pairing.

After that, `d` lists your devices and what each one plays. Choose one to move the music there. The queue, the playing song and its position move, and the computer that played stops. Every open Peel controls whichever device plays, and shows its song, queue and hearts.

Away from home, install [Tailscale](https://tailscale.com) on both computers. Paired devices find each other through it within a few seconds. `peel --remote <ssh-host>` controls a computer over SSH without moving the music. [docs/remote-play.md](docs/remote-play.md) explains pairing, encryption, network use and the limits.

## Keys

Every action also has a button or works with a click. `?` lists the keys for the current screen, and the bottom row shows the ones for what has focus.

| Action | Key |
| --- | --- |
| Search | `/` or Ctrl+F, then Enter. Escape leaves search |
| Play or pause | Space, or Ctrl+P while typing |
| Previous, next | `p`, `n` |
| Seek ten seconds | Left, Right. Shift+Left and Shift+Right on covers |
| Volume | `-`, `+` |
| Shuffle, repeat | `s`, `r` |
| Move around | Tab and Shift+Tab, arrow keys, Enter. Page Up, Page Down, Home, End in long lists |
| Back | Escape or Backspace |
| Large cover | `c` |
| Lyrics | `y` |
| Heart the song, the album | `f`, `l` |
| Add to the queue, play next | `e`, Shift+E |
| Show the queue | `u` |
| Move or remove a queued song | Shift+Up, Shift+Down (or `K`, `J`), `x` |
| Devices | `d` |
| Filter, sort, reverse, favourites only | Shift+F, `o`, Shift+O, `*` |
| Edit the sidebar | `e` with the sidebar focused |
| Load more than 500 songs | `m`, or scroll to the end |
| Help, quit | `?`, `q` or Ctrl+C |

Quitting stops the music, unless another Peel still uses the same player, for example one connected over SSH.

## Settings

The last sidebar entry. Enter changes the highlighted row, and Peel saves it to `layout.json`.

| Setting | Choices |
| --- | --- |
| Audio quality | High (AAC, 256 kbps) or Standard (AAC, 64 kbps, a quarter of the data). With hi-res, Apple Music's Android app chooses, and the row says Hi-Res Lossless. |
| Updates | Stable or Nightly, and a row that checks now and restarts into a new version. |
| Hearts in Favourite Songs | Show the heart on every row there, or hide it. |
| Devices, Forget paired devices | Open the devices popup, or take this computer out of its group. |
| Control over SSH | Appears after `peel --remote <host>`. |

## Files and settings

| System | Settings and sign-in | Cache | Engine profile |
| --- | --- | --- | --- |
| Linux | `~/.config/peel` | `~/.cache/peel` | `~/.config/peel-engine` |
| macOS | `~/Library/Application Support/peel` | `~/Library/Caches/peel` | `~/Library/Application Support/peel-engine` |
| Windows | `%APPDATA%\peel` | `%LOCALAPPDATA%\peel` | `%LOCALAPPDATA%\peel-engine` |

On Linux and macOS only you can read the settings folder. On Linux, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` move these folders.

| Variable | Effect |
| --- | --- |
| `PEEL_PLAYER` | `web` plays through the web engine even where hi-res is set up. `hires` forces hi-res. |
| `PEEL_DEVICES=off` | Keeps this Peel off the network. |
| `PEEL_DEVICE_PORT`, `PEEL_DISCOVERY_PORT` | Change the device ports, TCP 10770 and UDP 10771. |
| `PEEL_CONFIG_DIR`, `PEEL_CACHE_DIR`, `PEEL_ENGINE_HOME` | Move the folders above. |
| `APPLE_MUSIC_USER_TOKEN` | Uses this Apple Music user token instead of the saved one. |
| `PEEL_ENGINE_SHOW=1` | Shows the engine's window, for debugging. |

## How Peel reaches Apple Music

Peel reads your library, search, Home and artist pages from `api.music.apple.com`, so they appear while the engine is still starting. It uses the developer token from the script of Apple's web player at music.apple.com and keeps it until a day before it expires. Apple doesn't document this use of its web player's token and can change or revoke it. Playback runs in MusicKit JS inside castlabs' Electron, which adds Widevine. [engine/README.md](engine/README.md) describes the engine.

## Development

```sh
bun run check   # type check
bun test        # 200+ tests, with a stand-in engine and Apple API
```

GitHub Actions runs both on Linux, macOS and Windows for every pull request. Each night that `main` changed, the nightly workflow publishes it as the `nightly` release. A tag such as `v0.2.0` publishes a stable release. [docs/development.md](docs/development.md) covers the tests, releases and engine signing.

## Roadmap

[docs/roadmap.md](docs/roadmap.md) lists what is next: the open fixes, a first stable release, and Peel on phones. [mobile/](mobile/README.md) has the phone design and plan.
