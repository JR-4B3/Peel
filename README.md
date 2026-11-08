<p align="center">
  <img src="assets/peel.svg" width="112" alt="Peel's logo, a pixel-art apple with its lower half peeled">
</p>

<h1 align="center">Peel</h1>

<p align="center">
  Apple Music in your terminal, on Linux, macOS and Windows.<br>
  Hi-Res Lossless on Linux. Every Peel on your network is a speaker you can send the music to.
</p>

<p align="center">
  <a href="https://github.com/JR-4B3/Peel/releases"><img src="https://img.shields.io/github/v/release/JR-4B3/Peel?label=download&color=89b4fa" alt="Download"></a>
</p>

Apple Music has no app for Linux. Peel is one: a fast, keyboard-and-mouse player for your library, search, playlists, lyrics and queue that runs in a terminal. You need an Apple Music subscription and nothing else.

## What it does

- **Your library.** Home shows what you played recently and new releases from artists you marked as favourites. Favourite Songs, your playlists, All songs, Albums and Artists follow in a sidebar you can reorder and trim.
- **Search.** One field at the top finds songs, albums and artists.
- **Song lists you can work with.** Filter by words and years (`kanye 2004-2010`, `90s`, `>2018`), sort by title, artist, album, year or length, show favourites only. A filtered list plays in the order you see.
- **Albums and artists.** Albums and artists are grids of covers. An artist page has Apple's top songs and rows of albums, singles, live albums, compilations and guest appearances.
- **Queue.** `e` adds a song, album or playlist after the songs you already added. Shift+E plays it next. The Queue lists only what you added, and you can reorder or remove it.
- **Lyrics.** `y` shows time-synced lyrics. Choose a line to play from there.
- **Favourites.** `f` hearts the playing song and `l` the open album.
- **Devices.** Every Peel on your network is a device, like Spotify Connect. `d` moves the queue, the song and its position to another computer.
- **Hi-Res Lossless on Linux.** Up to 24-bit/192 kHz, at each song's own sample rate.
- **Updates.** Peel updates itself.

## Install

Peel needs [Bun](https://bun.sh) and a terminal with a [Nerd Font](https://www.nerdfonts.com). [Ghostty](https://ghostty.org) has one built in and shows album covers as images, and so does kitty. Other terminals show covers as coloured blocks.

```sh
git clone https://github.com/JR-4B3/Peel.git
cd Peel
bun src/update.ts install
peel --connect
```

`install` sets Peel up in your user folder and adds the `peel` command and an entry in your application menu, Applications folder or Start menu. You can delete the clone afterwards. `peel --connect` downloads Peel's player, about 110 MB, and opens Apple's sign-in window. Sign in once. After that, open Peel from the menu or run `peel`.

Add `--channel nightly` to `install` for each night's build, with the newest features. You can switch channels in Settings later.

| System | Notes |
| --- | --- |
| Linux | Any glibc distribution, such as Fedora, Nobara, Ubuntu, Debian, Arch or openSUSE. Alpine (musl) isn't supported. On NixOS, use nix-ld. |
| macOS | The first start may ask whether your terminal may find devices on the local network. Allow it, or devices won't appear. |
| Windows | Works, but a fresh install on a Windows PC hasn't been tested much yet. Please report anything that goes wrong. |

## Hi-Res Lossless on Linux

Apple's web player streams AAC at 256 kbps, and Apple decrypts Hi-Res Lossless only inside its own apps. On Linux, Peel runs Apple Music's Android app in a slimmed-down Android on an invisible display, and its audio reaches your sound card unchanged.

- Each song plays at its own rate, from 44.1 to 192 kHz. Measured bit-exact to a Focusrite Scarlett at 96 and 192 kHz.
- Once it's set up, Peel uses it by itself. Search, the queue, lyrics and devices work the same.
- Android runs only while Peel is open. Peel starts it as it opens, which takes about 7 seconds, so it is usually ready by the first song. After that a new queue starts in about 50 ms.
- Android and Apple Music update themselves at night when nothing plays, and go back to the last working version if an update fails its tests.

It needs an x86_64 PC and sudo once. [hires/README.md](hires/README.md) has the steps.

## Devices

Open Peel on two computers on the same network and press `d` on both. Choose the other computer under nearby devices, and check that both screens show the same six-digit code. You pair once, and a third computer joins the whole group with one more pairing.

After that, `d` lists your devices and what each one plays. Choose one to move the music there. The queue, the playing song and its position move, and the computer that played stops. Every open Peel controls whichever device plays.

Away from home, install [Tailscale](https://tailscale.com) on both computers, and paired devices find each other through it. [docs/remote-play.md](docs/remote-play.md) explains how pairing and the connection work.

## Keys

Everything also works with the mouse. `?` lists the keys for the current screen, and the bottom row shows the ones for what has focus.

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

## Settings

The last entry in the sidebar.

| Setting | Choices |
| --- | --- |
| Audio quality | High (256 kbps) or Standard (64 kbps, a quarter of the data). With hi-res, Apple Music's own setting chooses. |
| Updates | Stable or Nightly, and a row that checks now and restarts into a new version. |
| Hearts in Favourite Songs | Show the heart on every row there, or hide it. |
| Memory | On Linux, how much memory Peel uses, Android included. |
| Devices | Pair a device, or forget the paired ones. |

## Good to know

- Peel isn't made by Apple. It uses the same token as Apple's web player at music.apple.com, which Apple could change or block.
- Your settings and sign-in are in `~/.config/peel` on Linux, `~/Library/Application Support/peel` on macOS, and `%APPDATA%\peel` on Windows.
- `PEEL_PLAYER=web` plays through the web player even where hi-res is set up. `PEEL_DEVICES=off` keeps a Peel off the network.
- Peel on phones is planned. [docs/roadmap.md](docs/roadmap.md) has what's next.
