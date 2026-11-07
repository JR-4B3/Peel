# Peel

Peel is an OpenTUI interface for Apple Music on Linux, macOS, and Windows. It plays music through its own engine, a hidden MusicKit JS player in castlabs' Electron. Peel reads search, your library, Home, and artist pages from Apple Music directly, so they appear while the engine is still starting. It uses the token of Apple's own web player, so it does not need a separate Apple developer membership. You need an Apple Music subscription. Cider can play instead of the engine.

The interface follows the requests in T3 Code thread `4b5b5eca-7ae8-4a44-898d-34ccfee77448`:

- A labelled search input stays visible in wide and narrow terminals.
- Home opens first. It shows albums and playlists you played recently, and new releases from artists you marked as favourites in Apple Music.
- Favourite Songs follows Home, above your playlists. All songs, Albums, Artists, and Queue follow them.
- Albums shows your library as a grid of covers. Selecting an album or playlist opens a page with its cover and songs.
- Artists shows your library's artists as a grid of photos. An artist page lists their top songs, then rows of their albums, singles and EPs, live albums, compilations, and albums they appear on.
- The sidebar can be rearranged in place. Edit, below the sidebar, or `e` with the sidebar focused, lists hidden entries dimmed beside an eye icon. Selecting an entry then shows or hides it instead of opening it. Search and the player stay visible.
- The search field spans the top of the window. Peel's logo, pixel art of an apple with its lower half peeled, is the application entry's icon, `assets/peel.svg`. `bun scripts/logo.ts` rewrites it from the pixel grid in `src/logo.ts`.
- The Queue lists only the songs you added with `e` or Shift+E that have not played yet. The rest of the playing album or playlist is not listed. Added songs play after the current song and before the rest of the collection, and they stay queued when you start another album or playlist. A song leaves the Queue when it starts playing. With `PEEL_PLAYER=cider`, the Queue still lists Cider's whole queue.
- Song lists can be filtered by title, artist, or album, sorted, and narrowed to favourites. Favourite songs show a heart before their title.
- Playback controls use icons with their keyboard shortcut beside them when the terminal is at least 100 columns wide. There is one player strip at the bottom with the current cover and a favourite heart.
- Mouse clicks and keyboard shortcuts control the same actions.
- `y` shows the playing song's lyrics, beside the songs in wide windows and in their place otherwise.
- Every Peel on the same network is a device, like Spotify Connect. `d` opens a small popup above the player that lists them. Choosing one moves the music there. See [Devices](#devices).

## Run

Peel runs on Linux, macOS, and Windows, on x64 and arm64 processors. Install [Bun](https://bun.sh), then run these in this folder:

```sh
bun install --frozen-lockfile
bun run connect
bun start
```

The first `bun run connect` downloads Peel's playback engine for your system, about 110 MB, and checks it against its published checksums. It then starts the engine, which opens Apple's sign-in window. Sign in there once. Peel saves the Apple Music user token in its settings folder.

### Windows and macOS

On Windows and macOS, Widevine plays music only in a player signed through castlabs' EVS service. Peel downloads a copy of castlabs' Electron that its maintainer has already signed, from the `engine-v44.5.1+wvcus` release, so you need no castlabs account.

To publish that release for a new Electron version, the maintainer runs `bun scripts/sign-engine.ts` on a Mac for the Mac builds, then `bun scripts/sign-engine.ts --windows` on the Mac or on Windows for the Windows builds. The script describes what it needs. It prints how long the signature stays valid. Publish again before that date. Peel compares its signed copy with the release's checksums once a day and downloads a renewed copy by itself. If the download fails, Peel keeps the copy it has.

Only one publication can change the release at a time. The script holds a `publishing.lock` file on the release while it runs. It also stops without uploading if it cannot read the checksums already published. If a publication stopped without finishing, delete `publishing.lock` from the release before running it again.

### Linux

The engine runs on glibc distributions, such as Ubuntu, Debian, Fedora, Nobara, Arch, and openSUSE. castlabs does not build Electron for musl, so Alpine is not supported. NixOS needs nix-ld or another way to run downloaded binaries. Peel unpacks the engine itself, so it needs no unzip tool. On a desktop with a systemd user manager, the engine runs as the `peel-engine` user unit. Otherwise it runs as a detached process and writes its output to `engine.log` in its profile folder.

### Launcher and menu entry

- Linux: `bash scripts/install-local.sh` installs `~/.local/bin/peel` and an application menu entry. The entry opens Peel in Ghostty when available, then kitty, Alacritty, or Konsole, otherwise in your desktop's default terminal.
- macOS: `bash scripts/install-local.sh` installs `~/.local/bin/peel` and `~/Applications/Peel.app`. The app opens Peel in Ghostty when installed, otherwise in Terminal. Add `~/.local/bin` to your PATH to use the `peel` command.
- Windows: `powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1` installs `peel.cmd` in `%LOCALAPPDATA%\Peel\bin`, adds that folder to your PATH, and adds Peel to the Start menu. The Start menu entry opens Peel in Windows Terminal when it is installed.

Each launcher runs this checkout. Then use `peel --connect` and `peel`, or open Peel from the menu.

### Release installs and updates

`bun src/update.ts install` installs the newest stable release and the same launcher and menu entry, but the launcher runs the release rather than this checkout. Add `--channel nightly` for the nightly build. Releases go to `~/.local/share/peel` on Linux, `~/Library/Application Support/Peel` on macOS, and `%LOCALAPPDATA%\Peel` on Windows. Every version there shares one engine download.

A release install checks its channel when Peel opens, at most every six hours. A newer build downloads, is checked against its published checksum, and installs beside the running one. It starts the next time you open Peel, and the version before it stays until the following update. The Settings page shows the result. `peel --version` prints the running build.

| Channel | What it gets |
| --- | --- |
| Stable | Releases tagged `v<version>`, which pass the tests on Linux, macOS, and Windows. |
| Nightly | `main` as of each night it changed, after the same tests. It has the newest features and can break. |

A source checkout like this one updates through git and does not update itself.

### Where Peel keeps its files

| System | Settings and sign-in | Cache | Engine profile |
| --- | --- | --- | --- |
| Linux | `~/.config/peel` | `~/.cache/peel` | `~/.config/peel-engine` |
| macOS | `~/Library/Application Support/peel` | `~/Library/Caches/peel` | `~/Library/Application Support/peel-engine` |
| Windows | `%APPDATA%\peel` | `%LOCALAPPDATA%\peel` | `%LOCALAPPDATA%\peel-engine` |

On Linux, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` move these folders. On every system, `PEEL_CONFIG_DIR`, `PEEL_CACHE_DIR`, and `PEEL_ENGINE_HOME` override them directly.

Quitting Peel releases the engine, which quits once no other Peel uses it. If the terminal closes before Peel can release it, the engine finds within a second that no Peel is using it and quits. `bun run engine` runs the engine in the terminal with its log visible.

### Cider instead of the engine

With `PEEL_PLAYER=cider`, Peel plays through Cider. Install Cider and sign in to Apple Music there once. On Linux, Peel starts Cider and hides its window. On macOS and Windows, open Cider before Peel.

Approve Peel's request in Cider. Peel requests playback, queue, library, audio, and account permissions. The account permission lets Peel copy Cider's Apple Music user token, which Peel uses to read your library from Apple. It does not request your Apple password. Cider's token is saved to `auth.json` and the Apple Music user token to `apple.json` in Peel's settings folder. On Linux and macOS, both files are readable only by you. If you connected Peel before it read the library directly, run `bun run connect` once more to grant the account permission. Until then, Peel reads the library through Cider, so it appears once Cider has started. `peel --connect` opens Cider from its tray, so the approval dialog is visible even when Cider was hidden. `APPLE_MUSIC_USER_TOKEN` overrides the saved user token.

If the consent request times out or Cider closes the connection, run `bun run connect` again and approve the dialog promptly. Existing application tokens can also be supplied through `CIDER_API_TOKEN`. Generate one in Cider's external application access settings.

Use a terminal of at least 48 columns and 24 rows. Peel's icons are Nerd Font symbols, which Ghostty includes. Other terminals, including Windows Terminal and macOS Terminal, need a Nerd Font. Covers use the kitty graphics protocol in Ghostty and kitty. Other terminals show covers as coloured blocks. Peel does not paint a background, so the terminal's own background and transparency show through. Its colours match the DankMaterialShell palette used by Ghostty and Niri on the main PC. Mouse interaction requires a terminal that forwards mouse events. Shift-click behaviour for selecting terminal text depends on your terminal.

## Controls

| Action | Key | Mouse |
| --- | --- | --- |
| Search | `/` or `Ctrl+F`, then Enter | Click the search field |
| Play/pause | Space, or `Ctrl+P` while typing | Play/Pause |
| Previous/next | `p` / `n` | Previous / Next |
| Seek ten seconds | Left / Right | Click the progress bar |
| Volume | `-` / `+` | Vol - / Vol + |
| Shuffle / repeat | `s` / `r` | Shuffle / Repeat |
| Navigate music | Tab or Shift+Tab, then arrow keys and Enter | Click a playlist, cover, or song |
| Seek while covers have focus | Shift+Left / Shift+Right | Click the progress bar |
| Open an artist | | The artist name on an album page or in the player |
| Jump through a long song list | Page Up / Page Down, Home / End | Scroll, three songs at a time |
| Back from an album, playlist, or artist | Escape or Backspace | Back |
| Show the cover large, the open album's or else the playing song's | `c`. Escape or `c` closes it | The cover beside an album's name or in the player |
| Favourite the current song | `f` | Heart |
| Favourite the open album | `l` | Favourite, beside Play |
| Add the highlighted song, album, or playlist to the queue, after the songs already added | `e` | |
| Play the highlighted song, album, or playlist next | Shift+E | |
| Show the queue | `u` | Queue in the sidebar |
| Choose which device plays, or pair one | `d`, then Up / Down and Enter. Escape closes it | The devices button beside lyrics |
| Show lyrics | `y` | The lyrics button |
| Move a song in the queue | Shift+Up / Shift+Down, or `K` / `J` | |
| Play a queued song next | Shift+E in the queue | |
| Remove a song from the queue | `x` or Delete | |
| Load past the first 500 | Move near the end of the list, or `m` | Scroll down |
| Edit the sidebar | `e` with the sidebar focused. `e` or Escape finishes | Click Edit below the sidebar, then Done |
| Move a sidebar entry | Shift+Up / Shift+Down, or `K` / `J`, while editing | |
| Hide or show a sidebar entry | Enter while editing | Click the entry while editing |
| Filter a song list | Shift+F, then type. Escape clears the filter | Filter field above the list |
| Sort a song list | `o` cycles playlist order, title, artist, album, year, length, and shuffled | Sort |
| Reverse the order | Shift+O | The arrow beside Sort |
| Favourites only | `*` | Favourites |
| Leave search | Escape | Select a sidebar entry |
| Help / quit | `?` / `q`, or Ctrl+C | Keyboard |

The bottom right of the window lists the keys for what has focus, such as play next, move, and remove on a queued song. `?` lists the other keys that apply on the current screen. It leaves out keys already shown beside a button, such as the player's, and filter and sort keys outside song lists. Plain playback shortcut letters remain text while the search input has focus. Quitting Peel with `q` or Ctrl+C, or closing its window, stops Peel's playback engine and the music, unless another Peel, for example one opened over SSH, still uses the engine. The engine then keeps playing until the last Peel closes. With `PEEL_PLAYER=cider`, quitting leaves Cider playing.

Selecting a song in a playlist or album starts that song directly, then adds its collection and restores its position in the displayed order. Cider adds only the first hundred songs of a collection, so a song further down starts at once and the next hundred loaded songs are queued after it in the background. The songs before it are not queued then, and selecting another song stops the queueing. The collection's first song never starts as an intermediate step. Next and Previous continue through the collection. A double-click on the same song starts it once. Shuffle can change the order afterwards. Manual Next and Previous still change tracks in repeat-one mode and preserve the repeat setting.

Left and Right move between covers on Home, Albums, Artists, and artist pages, and seek in song lists. On Home and artist pages, each row scrolls sideways. Click the arrows beside a row's title to page through it. On an artist page, Down from the last top song moves into the album rows, and Up from the first row returns to the songs.

Apple Music does not report how often you played a song, so an artist page shows Apple's top songs for that artist, its most played songs across Apple Music. Selecting one plays that song. Search shows up to three matching artists above the songs and albums.

The heart sets Apple Music's favourite rating, then reads the stored rating back before it changes. It shows filled or empty only once Apple has answered. Until then `f` does nothing, so an unknown state cannot remove a favourite and move it in Favourite Songs. Ratings belong to catalog songs, so library songs are rated through their catalog entry.

An album page has its own heart, beside Play. Library albums are rated through their catalog album, and albums only in your library are rated as library albums. Rating an album needs Peel's own Apple Music sign-in, because Cider's proxy only reads.

The filter field takes words and release years together, for example `kanye 2004-2010`. Every word must appear in the title, artist, or album, ignoring case and accents. Years can be a range (`2015-2020`), a bound (`>2018`, `<2000`, `>=2018`, `2018+`), or a decade (`90s`, `1990s`). A bare year such as `2016` matches that release year or the number in a title.

Filtering, sorting, or narrowing to favourites first loads the rest of the list, so it covers the whole playlist. Rows keep their playlist number. Selecting a song plays the list as shown.

## Devices

Every Peel on the same network is a device. Press `d`, or click the devices button beside the lyrics button, to open a popup above the player. It lists this computer, your paired devices with what each one plays, and nearby Peels you have not paired yet.

- **Pairing.** Press `d` on both computers. On one, choose the other under the nearby devices. A device accepts pairing requests only for two minutes after its popup was opened, so nobody else on the network can put a pairing prompt on your screen. Both screens show the same six-digit code. You do not type it anywhere. It is there so you can check that you pair with your own device: if both screens show the same code, press Enter on both. You pair once. Pairing a device with any device in your group adds it to the whole group, so three computers need two pairings, not three.
- **Moving the music.** Choose a paired device. Peel moves the queue, the playing song, and its position there, and the device that played stops. If the new device cannot start, the music keeps playing where it was.
- **Controlling.** Every Peel controls whichever device plays. Play, pause, skip, seek, volume, favourites, and queue edits all go to that device, and every open Peel shows its song, queue, and hearts. When another Peel moves the music, this one follows.
- **No device is in charge.** The device that plays holds the queue only because it plays it. Each device keeps working without the others.

A device appears while Peel is open on it. Closing Peel there stops its music, and the other Peels control their own computer again. Devices find each other by UDP broadcast on port 10771 and connect on TCP port 10770. `PEEL_DEVICE_PORT` and `PEEL_DISCOVERY_PORT` change them, and `PEEL_DEVICES=off` keeps a Peel off the network. The first time, macOS may ask whether your terminal may find devices on the local network. Allow it.

### Away from home

Devices find each other only on the same network. To control a device from elsewhere, install [Tailscale](https://tailscale.com) on both computers and sign in to the same account. Then:

1. Pair the devices once while both are on the same network.
2. Paired devices tell each other all their addresses, their Tailscale addresses too. Away from home, Peel tries each one, so the devices reconnect over Tailscale within a few seconds.

Peel needs nothing else from Tailscale. The connection between the devices stays encrypted by Peel as well.

[docs/remote-play.md](docs/remote-play.md) describes how it works and its limits.

## Settings

Settings, at the end of the sidebar, lists these. Enter switches the highlighted one, and Peel saves it in `layout.json` in its settings folder.

| Setting | Choices |
| --- | --- |
| Audio quality | High, AAC at 256 kbps, or Standard, AAC at 64 kbps, which uses a quarter of the data. With Cider, Cider's own settings choose. Hi-Res Lossless is not available in Peel yet. |
| Updates | Stable or Nightly. Choosing one checks it at once. |
| Hearts in Favourite Songs | Every song in Favourite Songs is a favourite, so its rows show no heart unless this is on. |
| Devices | Opens the devices popup, like `d`. |
| Forget paired devices | Takes this computer out of its device group. Press Enter twice. |
| Control over SSH | Shown once you added an SSH host with `peel --remote <host>`. See [remote play](docs/remote-play.md). |

Sidebar changes save to `layout.json` in Peel's settings folder. Home is always first and cannot be moved or hidden. `CIDER_API_BASE` defaults to `http://127.0.0.1:10767`.

Peel keeps Home's shelves and downloaded covers in its cache folder. New releases come from the latest release of each library artist with Apple's favourite flag, from the last 120 days or not yet released, newest first. Peel checks again after six hours, because the check reads every library artist. Recently played reloads each time Home opens.

Peel targets the v2 API in the installed Cider 4.0.17 build for playback, the queue, and the favourite heart. Everything else comes from `api.music.apple.com`. Peel reads the developer token from the script of Apple's web player at music.apple.com and caches it in `apple-developer-token.json` in its cache folder until a day before it expires. When Apple rejects it, Peel fetches it again once. When Apple rejects the user token, Peel copies a fresh one from Cider if Cider is running. Apple does not document this use of its web player's token, and Apple can change or revoke it. Artist pages use the catalog artist linked to a song or album. Library items without a catalog link, such as uploads, fall back to a search for the artist's name, so a collaboration credit may open the first matching artist. Favourite Songs uses Apple's `favorited` playlist tag, so it also works when that playlist has a translated name. Apple returns a hundred items per request. Lists show the first hundred at once and load the next hundreds in the background, up to 500. Past that, each move near the end of the list loads another hundred.

Cider must keep running. Replacing its interface does not remove the playback engine's resource use. Playback format and subscription restrictions remain those of the running Cider engine.

## Playback PC and background operation

The finished player runs entirely on the main PC. That PC has its own checkout, Bun, Cider, approved Peel token, and Apple Music session. Audio plays on the main PC. T480 is the development machine and is not needed to start or use the installed player. Peel connects directly to Cider on `127.0.0.1`; it does not use an SSH tunnel or a service on T480.

Sign in to Apple Music in Cider. Peel uses that signed-in session to show your personal library and play music. Your Apple credentials stay in Cider. If Apple expires the session, open Cider to sign in again.

Opening Peel shows Home and your playlists at once and starts Cider in the background if it is stopped. Peel waits for its local API and hides its window through the tray. The player strip shows Starting until Cider answers. A song or playback control selected before then plays once Cider is ready. Until Cider runs, the Queue is empty. Cider stays running when you quit Peel. Reopening Peel reuses the running Cider process. Linux startup uses the desktop's systemd user manager and requires `systemd-run`, `pgrep`, `busctl`, and `gdbus`. Automatic startup applies to the default local API on port 10767. A custom remote API must already be running.

On main's Niri desktop, Peel installs a startup rule before launching Cider. The rule puts Cider on a temporary inactive workspace, prevents focus, and makes its window transparent, including in the workspace overview. After Cider hides to the tray, Peel clears the rule and removes the temporary named workspace. Your existing desktop configuration stays in place, with a backup at `~/.config/niri/config.kdl.before-peel` and an include for `peel-cider.kdl`. Other desktops currently hide Cider after startup and may show its window briefly.

Initial sign-in and `peel --connect` keep Cider visible so you can approve access. The tray icon must be enabled for automatic hiding. If hiding fails, Peel reports the problem and still connects to playback. You can also use **Hide** in Cider's tray menu. Closing Cider with **Close to Tray** disabled quits its engine. The hidden window still contains the playback engine; this setup is not a separate headless audio service.

The main PC's desktop has a saved notification rule that mutes Cider popups. Other applications keep their existing notification settings.

## Releases and CI

GitHub Actions runs the type check and tests on Linux, macOS, and Windows for every pull request and every push to `main` (`.github/workflows/ci.yml`). GitHub's standard runners cost nothing for a public repository.

- Nightly (`nightly.yml`) runs at 02:17 UTC. When `main` has new commits, it runs the tests and publishes `main` as the `nightly` prerelease. Start it from the Actions tab to build at once.
- Release (`release.yml`) runs when you push a tag such as `v0.2.0`. It runs the tests and publishes the stable release. The tag must match the version in `package.json`.

Both publish the same three files: `peel.tar.gz`, `SHASUMS256.txt`, and `version.json`. `bun scripts/package.ts --channel nightly` builds them locally. One archive serves every system, because Peel runs on Bun and each machine installs its own native packages after unpacking. A feature written in `src/` therefore works on every system without a separate build. Only the playback engine differs per system, and Peel downloads the right one itself.

GitHub turns off scheduled workflows in a repository without activity for 60 days. A push or a manual run turns the nightly back on.

## Verification

```sh
bun run check
bun test
bun scripts/capture-ui.ts
bun run verify:live
bun scripts/verify-live.ts --audio
```

The tests feed terminal mouse and keyboard sequences through OpenTUI's real parser and inspect the rendered controls. Their Cider server is a fixture. `capture-ui.ts` saves actual terminal frames at several widths, also with fixture data.

`verify:live` requires your authorised, signed-in Cider instance with a song selected. It clicks the rendered player controls, checks Cider's observed state and advancing playback time, enters a real search, and writes `evidence/live-report.json` and terminal frames. When the current queue is a complete, unshuffled catalog album, it also checks album and song selection, Next, and Previous, then reconstructs and checks the original queue. It temporarily changes playback, seek, volume, shuffle, and repeat, then restores them. A previously stopped session is left paused because Cider can report a stale playback flag after Stop. Run it while you are not controlling Cider elsewhere.

On a Linux desktop with PipeWire, `--audio` also captures two seconds of PCM directly from Cider's own output stream and checks that its samples contain sound. The audio stays in memory; the report saves the source, sample count, peak, and RMS measurements. A passing fixture test alone does not prove playback or audible output. See [PipeWire's capture documentation](https://docs.pipewire.org/page_man_pw-cat_1.html).

On the main PC's Niri desktop, hide Cider from its tray menu, open the installed Peel application, and run `bun scripts/verify-background.ts`. It checks the actual desktop windows and process ownership, confirms that Peel uses the main PC's loopback API, and captures Cider's audio while its window is hidden. It saves `evidence/background-report.json` and restores the initial volume and playback state.

With Cider stopped on main, run `bun scripts/verify-startup.ts` to check automatic startup. It closes the current Peel window, launches the installed application, checks the authorised API and personal library, and confirms Cider's window stays hidden. It monitors Niri's window and workspace events from before launch to verify Cider never occupies an active workspace on either monitor or takes focus. It then quits and reopens Peel to confirm the same Cider process keeps running. It leaves Peel open and saves `evidence/startup-report.json` and `evidence/main-auto-start.png`.

For the playlist selection regression, run `bun scripts/verify-song-click.ts --index 12` on main with Favourite Songs as the current queue. The index is zero-based and must name a non-first song in the loaded page. The check drives single and double mouse clicks through the rendered controls and compares Cider's actual audio against direct-play references for the selected song and the first song. It verifies that each click sequence starts the selected song once and preserves the collection queue. It saves `evidence/song-click-report.json` and restores the original song, queue order, volume, and playback settings. Audio comparisons stay in memory. Run it while you are not controlling playback elsewhere.

API references: [Cider v2 documentation](https://taproom.cider.sh/docs/api), [OpenTUI interaction documentation](https://opentui.com/docs/core-concepts/interaction/).

## Desktop remote control

Run `peel --remote main` on a computer with SSH access to `main`. Audio and the queue stay on `main`, while the local Peel controls it. The target is saved. Settings lets you switch between saved computers, and `peel --local` returns to this computer's engine. Switching controllers preserves the host queue. Moving playback between engines is not implemented yet.

Both computers need this version of Peel. The host needs an Apple Music sign-in and an active desktop session. See [remote setup and limits](docs/remote-play.md).
