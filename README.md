# Peel

Peel is an OpenTUI interface for Apple Music on Linux. Cider handles sign-in and audio playback. Peel reads search, your library, Home, and artist pages from Apple Music directly, so they appear while Cider is still starting. It uses Cider's local API for playback and the token of Apple's own web player for the library, so it does not need a separate Apple developer membership. You need Cider and an Apple Music subscription.

The interface follows the requests in T3 Code thread `4b5b5eca-7ae8-4a44-898d-34ccfee77448`:

- A labelled search input stays visible in wide and narrow terminals.
- Home opens first. It shows albums and playlists you played recently, and new releases from artists you marked as favourites in Apple Music.
- Favourite Songs follows Home, above your playlists. All songs, Albums, Artists, and Queue follow them.
- Albums shows your library as a grid of covers. Selecting an album or playlist opens a page with its cover and songs.
- Artists shows your library's artists as a grid of photos. An artist page lists their top songs, then rows of their albums, singles and EPs, live albums, compilations, and albums they appear on.
- The sidebar can be rearranged in place. Edit, below the sidebar, or `e` with the sidebar focused, lists hidden entries dimmed beside an eye icon. Selecting an entry then shows or hides it instead of opening it. Search and the player stay visible.
- The logo above the sidebar is an apple peel in pixel art, coiled in the shape of the apple, beside the name. `assets/peel.svg` is the same drawing, and the application entry uses it as its icon. `bun scripts/logo.ts` rewrites it from the pixel grid in `src/logo.ts`.
- Song lists can be filtered by title, artist, or album, sorted, and narrowed to favourites. Favourite songs show a heart before their title.
- Playback controls use icons with their keyboard shortcut beside them when the terminal is at least 100 columns wide. There is one player strip at the bottom with the current cover and a favourite heart.
- Mouse clicks and keyboard shortcuts control the same actions.
- Optional animated bars indicate confirmed playback. They are a playback indicator, not a measured audio spectrum. They stop when paused or disconnected.
- Lyrics are deferred.

## Run

Install [Bun](https://bun.sh) and Cider on the playback PC. Sign in to Apple Music in Cider once. Then:

```sh
bun install --frozen-lockfile
bun run connect
bun start
```

For a `peel` command and a Peel entry in your application menu, run `bash scripts/install-local.sh` on the playback PC. Then use `peel --connect` and `peel`, or open Peel from the application menu. The launcher is installed to `~/.local/bin` and runs this checkout. The application entry opens the interface in Ghostty when available, then Alacritty or Konsole, otherwise your desktop's default terminal.

Approve Peel's request in Cider. Peel requests playback, queue, library, audio, and account permissions. The account permission lets Peel copy Cider's Apple Music user token, which Peel uses to read your library from Apple. It does not request your Apple password. Cider's token is saved to `~/.config/peel/auth.json` and the Apple Music user token to `~/.config/peel/apple.json`, both with private file permissions. If you connected Peel before it read the library directly, run `bun run connect` once more to grant the account permission. Until then, Peel reads the library through Cider, so it appears once Cider has started. `peel --connect` opens Cider from its tray, so the approval dialog is visible even when Cider was hidden. `APPLE_MUSIC_USER_TOKEN` overrides the saved user token.

If the consent request times out or Cider closes the connection, run `bun run connect` again and approve the dialog promptly. Existing application tokens can also be supplied through `CIDER_API_TOKEN`. Generate one in Cider's external application access settings.

Use a terminal of at least 48 columns and 24 rows. Peel's icons are Nerd Font symbols, which Ghostty includes. Other terminals need a Nerd Font. Covers use the kitty graphics protocol in Ghostty and kitty. Other terminals show covers as coloured blocks. Peel does not paint a background, so the terminal's own background and transparency show through. Its colours match the DankMaterialShell palette used by Ghostty and Niri on the main PC. Mouse interaction requires a terminal that forwards mouse events. Shift-click behaviour for selecting terminal text depends on your terminal.

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
| Open an artist | `a` on a highlighted song or album, otherwise the playing song's artist | The artist name on an album page or in the player |
| Jump through a long song list | Page Up / Page Down, Home / End | Scroll, three songs at a time |
| Back from an album, playlist, or artist | Escape or Backspace | Back |
| Favourite the current song | `f` | Heart |
| Load another page | `m`, or move to the last row of covers | Scroll down |
| Edit the sidebar | `e` with the sidebar focused. `e` or Escape finishes | Click Edit below the sidebar, then Done |
| Move a sidebar entry | Shift+Up / Shift+Down, or `K` / `J`, while editing | |
| Hide or show a sidebar entry | Enter while editing | Click the entry while editing |
| Filter a song list | Shift+F, then type. Escape clears the filter | Filter field above the list |
| Sort a song list | `o` cycles playlist order, title, artist, album, year, length, and shuffled | Sort |
| Reverse the order | Shift+O | The arrow beside Sort |
| Favourites only | `*` | Favourites |
| Toggle playback bars | `v` | Bars |
| Leave search | Escape | Select a sidebar entry |
| Help / quit | `?` / `q`, or Ctrl+C | Keyboard |

Plain playback shortcut letters remain text while the search input has focus. Quitting Peel leaves Cider playing.

Selecting a song in a playlist or album starts that song directly, then adds its collection and restores its position in the displayed order. Cider adds only the first hundred songs of a collection, so a song further down starts at once and the next hundred loaded songs are queued after it in the background. The songs before it are not queued then, and selecting another song stops the queueing. The collection's first song never starts as an intermediate step. Next and Previous continue through the collection. A double-click on the same song starts it once. Shuffle can change the order afterwards. Manual Next and Previous still change tracks in repeat-one mode and preserve the repeat setting.

Left and Right move between covers on Home, Albums, Artists, and artist pages, and seek in song lists. On Home and artist pages, each row scrolls sideways. Click the arrows beside a row's title to page through it. On an artist page, Down from the last top song moves into the album rows, and Up from the first row returns to the songs.

Apple Music does not report how often you played a song, so an artist page shows Apple's top songs for that artist, its most played songs across Apple Music. Selecting one plays that song. Search shows up to three matching artists above the songs and albums.

The heart sets Apple Music's favourite rating, then reads the stored rating back before it changes. It shows filled or empty only once Apple has answered. Until then `f` does nothing, so an unknown state cannot remove a favourite and move it in Favourite Songs. Ratings belong to catalog songs, so library songs are rated through their catalog entry.

The filter field takes words and release years together, for example `kanye 2004-2010`. Every word must appear in the title, artist, or album, ignoring case and accents. Years can be a range (`2015-2020`), a bound (`>2018`, `<2000`, `>=2018`, `2018+`), or a decade (`90s`, `1990s`). A bare year such as `2016` matches that release year or the number in a title.

Filtering, sorting, or narrowing to favourites first loads the rest of the list, so it covers the whole playlist. Rows keep their playlist number. Selecting a song plays the list as shown.

## Settings

Every song in Favourite Songs is a favourite, so its rows show no heart. Set `"heartsInFavourites": true` in `~/.config/peel/layout.json` to show them, then restart Peel.

Sidebar changes save to `~/.config/peel/layout.json`. Home is always first and cannot be moved or hidden. `XDG_CONFIG_HOME` selects another configuration root, and `PEEL_CONFIG_DIR` overrides Peel's directory directly. `CIDER_API_BASE` defaults to `http://127.0.0.1:10767`.

Peel keeps Home's shelves and downloaded covers in `~/.cache/peel`. `XDG_CACHE_HOME` and `PEEL_CACHE_DIR` change that location. New releases come from the latest release of each library artist with Apple's favourite flag, from the last 120 days or not yet released, newest first. Peel checks again after six hours, because the check reads every library artist. Recently played reloads each time Home opens.

Peel targets the v2 API in the installed Cider 4.0.17 build for playback, the queue, and the favourite heart. Everything else comes from `api.music.apple.com`. Peel reads the developer token from the script of Apple's web player at music.apple.com and caches it in `~/.cache/peel/apple-developer-token.json` until a day before it expires. When Apple rejects it, Peel fetches it again once. When Apple rejects the user token, Peel copies a fresh one from Cider if Cider is running. Apple does not document this use of its web player's token, and Apple can change or revoke it. Artist pages use the catalog artist linked to a song or album. Library items without a catalog link, such as uploads, fall back to a search for the artist's name, so a collaboration credit may open the first matching artist. Favourite Songs uses Apple's `favorited` playlist tag, so it also works when that playlist has a translated name. Library views load another page on demand.

Cider must keep running. Replacing its interface does not remove the playback engine's resource use. Playback format and subscription restrictions remain those of the running Cider engine.

## Playback PC and background operation

The finished player runs entirely on the main PC. That PC has its own checkout, Bun, Cider, approved Peel token, and Apple Music session. Audio plays on the main PC. T480 is the development machine and is not needed to start or use the installed player. Peel connects directly to Cider on `127.0.0.1`; it does not use an SSH tunnel or a service on T480.

Sign in to Apple Music in Cider. Peel uses that signed-in session to show your personal library and play music. Your Apple credentials stay in Cider. If Apple expires the session, open Cider to sign in again.

Opening Peel shows Home and your playlists at once and starts Cider in the background if it is stopped. Peel waits for its local API and hides its window through the tray. The player strip shows Starting until Cider answers. A song or playback control selected before then plays once Cider is ready. Until Cider runs, the Queue is empty. Cider stays running when you quit Peel. Reopening Peel reuses the running Cider process. Linux startup uses the desktop's systemd user manager and requires `systemd-run`, `pgrep`, `busctl`, and `gdbus`. Automatic startup applies to the default local API on port 10767. A custom remote API must already be running.

On main's Niri desktop, Peel installs a startup rule before launching Cider. The rule puts Cider on a temporary inactive workspace, prevents focus, and makes its window transparent, including in the workspace overview. After Cider hides to the tray, Peel clears the rule and removes the temporary named workspace. Your existing desktop configuration stays in place, with a backup at `~/.config/niri/config.kdl.before-peel` and an include for `peel-cider.kdl`. Other desktops currently hide Cider after startup and may show its window briefly.

Initial sign-in and `peel --connect` keep Cider visible so you can approve access. The tray icon must be enabled for automatic hiding. If hiding fails, Peel reports the problem and still connects to playback. You can also use **Hide** in Cider's tray menu. Closing Cider with **Close to Tray** disabled quits its engine. The hidden window still contains the playback engine; this setup is not a separate headless audio service.

The main PC's desktop has a saved notification rule that mutes Cider popups. Other applications keep their existing notification settings.

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
