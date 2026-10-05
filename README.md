# Peel

Peel is an OpenTUI interface for Apple Music on Linux. Cider handles sign-in and audio playback. Peel handles search, your music, and player controls. It uses Cider's local API, so it does not need a separate Apple developer membership. You need Cider and an Apple Music subscription.

The interface follows the requests in T3 Code thread `4b5b5eca-7ae8-4a44-898d-34ccfee77448`:

- A labelled search input stays visible in wide and narrow terminals.
- Home opens first. It shows albums and playlists you played recently, and new releases from artists you marked as favourites in Apple Music.
- Favourite Songs follows Home, above your playlists. All songs, Albums, and Queue follow them.
- Albums shows your library as a grid of covers. Selecting an album or playlist opens a page with its cover and songs.
- The layout editor saves sidebar order and hidden entries. Search and the player stay visible.
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

Approve Peel's request in Cider. Peel requests playback, queue, library, and audio permissions. It does not request your Apple credentials. The token is saved to `~/.config/peel/auth.json` with private file permissions.

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
| Back from an album or playlist | Escape or Backspace | Back |
| Favourite the current song | `f` | Heart |
| Load another page | `m`, or move to the last row of covers | Scroll down |
| Edit sidebar layout | `l` | Layout |
| Move a layout entry | `K` / `J` | Up / Down in the editor |
| Hide/show a layout entry | `h` | Hide/show in the editor |
| Toggle playback bars | `v` | Bars |
| Leave search or layout editing | Escape | Select a sidebar entry |
| Help / quit | `?` / `q`, or Ctrl+C | Keyboard |

Plain playback shortcut letters remain text while the search input has focus. Quitting Peel leaves Cider playing.

Selecting a song in a playlist or album starts that song directly, then adds its collection and restores its position in the displayed order. The collection's first song never starts as an intermediate step. Next and Previous continue through the collection. A double-click on the same song starts it once. Shuffle can change the order afterwards. Manual Next and Previous still change tracks in repeat-one mode and preserve the repeat setting.

Left and Right move between covers on Home and Albums, and seek in song lists. On Home, each row scrolls sideways. Click the arrows beside a row's title to page through it.

The heart sets Apple Music's favourite rating through Cider, then reads the stored rating back before it changes. Apple Music may also add the song to your library.

## Settings

Layout changes save to `~/.config/peel/layout.json`. Home is always first and is not part of the layout editor. `XDG_CONFIG_HOME` selects another configuration root, and `PEEL_CONFIG_DIR` overrides Peel's directory directly. `CIDER_API_BASE` defaults to `http://127.0.0.1:10767`.

Peel keeps Home's shelves and downloaded covers in `~/.cache/peel`. `XDG_CACHE_HOME` and `PEEL_CACHE_DIR` change that location. New releases come from the latest release of each library artist with Apple's favourite flag, from the last 120 days or not yet released, newest first. Peel checks again after six hours, because the check reads every library artist. Recently played reloads each time Home opens.

Peel targets the v2 API in the installed Cider 4.0.17 build. Search uses Cider's read-only Apple Music proxy. Favourite Songs uses Apple's `favorited` playlist tag, so it also works when that playlist has a translated name. Library views load another page on demand.

Cider must keep running. Replacing its interface does not remove the playback engine's resource use. Playback format and subscription restrictions remain those of the running Cider engine.

## Playback PC and background operation

The finished player runs entirely on the main PC. That PC has its own checkout, Bun, Cider, approved Peel token, and Apple Music session. Audio plays on the main PC. T480 is the development machine and is not needed to start or use the installed player. Peel connects directly to Cider on `127.0.0.1`; it does not use an SSH tunnel or a service on T480.

Sign in to Apple Music in Cider. Peel uses that signed-in session to show your personal library and play music. Your Apple credentials stay in Cider. If Apple expires the session, open Cider to sign in again.

Opening Peel starts Cider if it is stopped, waits for its local API, and hides its window through the tray. Cider stays running when you quit Peel. Reopening Peel reuses the running Cider process. Linux startup uses the desktop's systemd user manager and requires `systemd-run`, `pgrep`, `busctl`, and `gdbus`. Automatic startup applies to the default local API on port 10767. A custom remote API must already be running.

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
