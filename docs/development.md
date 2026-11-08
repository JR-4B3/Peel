# Developing Peel

## Layout

| Folder | What is there |
| --- | --- |
| `src/` | The terminal app: interface (`ui.ts`), state (`model.ts`), Apple Music API (`apple.ts`), engine client (`engine.ts`), devices (`devices.ts`, `link.ts`, `remote.ts`), SSH helper (`remote-host.ts`), hi-res host (`hires.ts`), updates (`update.ts`) |
| `engine/` | The playback engine: MusicKit JS in castlabs' Electron, controlled over a local HTTP interface with a private key |
| `hires/` | The Linux hi-res pipeline: Waydroid image builder, audio driver, rate helper, root helper, controller, systemd units and tests |
| `tests/` | Bun tests. `fixture.ts` is a stand-in for Apple's API and for Peel's engine |
| `scripts/` | Install scripts, release packaging, engine signing, and checks that need real hardware |
| `docs/` | How devices work, this page, and the roadmap |
| `mobile/` | The phone design and plan |

## Words

The code and its comments use these words in one sense each.

| Word | Meaning |
| --- | --- |
| engine | A player process that Peel sends commands to: the web engine in `engine/`, or the hi-res host. |
| hi-res host | `src/hires.ts` running as the `peel-hires-host` service. It speaks the engine's protocol and drives Android. |
| SSH host | The computer `peel --remote <ssh-host>` controls. `DevicePlayer.sshHost` holds its name. |
| remote Peel | A Peel that controls another computer, over SSH or through the devices popup. |
| controller | Only the Java program inside Android (`hires/android/control/Control.java`) that `peel-hires controller` starts. |
| owner | A Peel process that keeps an engine running. When the last one exits, the engine stops. |
| claim | The shared record of which device plays, with a generation number. The highest generation wins. |

## Running from source

```sh
bun install --frozen-lockfile
bun run connect
bun start
```

`bash scripts/install-local.sh` (Windows: `scripts\install-local.ps1`) adds a launcher and menu entry that run the checkout instead of a release. A checkout updates through git, not through Peel's updater. `bun run engine` runs the playback engine in the terminal with its log visible, and `PEEL_ENGINE_SHOW=1` shows its window.

On Linux with a systemd user session, the engine runs as the `peel-engine` user unit and the hi-res host as `peel-hires-host`, both in `app-peel.slice`. Without systemd, the engine runs as a detached process and logs to `engine.log` in its profile folder.

## Files and variables

| System | Settings and sign-in | Cache | Engine profile |
| --- | --- | --- | --- |
| Linux | `~/.config/peel` | `~/.cache/peel` | `~/.config/peel-engine` |
| macOS | `~/Library/Application Support/peel` | `~/Library/Caches/peel` | `~/Library/Application Support/peel-engine` |
| Windows | `%APPDATA%\peel` | `%LOCALAPPDATA%\peel` | `%LOCALAPPDATA%\peel-engine` |

Release installs live in `~/.local/share/peel`, `~/Library/Application Support/Peel` or `%LOCALAPPDATA%\Peel`, one folder per version under `versions/`, with `current` naming the one the launcher starts.

| Variable | Effect |
| --- | --- |
| `PEEL_PLAYER` | `web` plays through the web engine where hi-res is set up, `hires` forces hi-res. |
| `PEEL_DEVICES=off` | Keeps a Peel off the device network. |
| `PEEL_DEVICE_PORT`, `PEEL_DISCOVERY_PORT` | The device ports, TCP 10770 and UDP 10771. |
| `PEEL_CONFIG_DIR`, `PEEL_CACHE_DIR`, `PEEL_ENGINE_HOME` | Move the folders above. On Linux, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` do too. |
| `APPLE_MUSIC_USER_TOKEN` | An Apple Music user token instead of the saved one. |
| `PEEL_ENGINE_SHOW=1` | Shows the engine's window. |

`peel --remote <ssh-host>` controls another computer's player over SSH without moving the music, and `peel --local` returns to this computer. [remote-play.md](remote-play.md#ssh) has the details.

Peel reads the library from `api.music.apple.com` with the developer token from the script of Apple's web player, cached in `apple-developer-token.json` until a day before it expires. Apple doesn't document this use and can change or revoke it.

## Tests

```sh
bun run check
bun test
```

The tests drive the real interface through OpenTUI's test renderer. They feed it the same mouse and keyboard sequences a terminal sends and read back the rendered cells. Playback runs against `tests/fixture.ts`, which keeps a queue the way `engine/engine.js` does and records each engine method Peel calls. Apple Music's API is a local server with fixed answers. Nothing reaches Apple, starts a real engine or plays sound.

`tests/hires-host.test.ts` runs the real hi-res host against a simulated Android controller. `hires/tests/offline/run.sh` checks the hi-res updater, health checks and audio driver without Waydroid.

Checks that need real machines:

- `bun scripts/capture-ui.ts` saves the rendered interface at 48, 80 and 120 columns to `evidence/`, with fixture data.
- `bun scripts/verify-devices.ts wait` on one computer and `bun scripts/verify-devices.ts pair` on another pair two real computers over the network and move a queue between stand-in engines. Neither computer's music changes.
- `peel-hires test` on a hi-res machine boots the current release, plays a known signal through Android and checks that the samples reach PipeWire unchanged. With `APPLE_PLAY_TEST=on` it also plays a real Apple Music song.

## Releases

GitHub Actions runs the type check and tests on Linux, macOS and Windows for every pull request and every push to `main` (`.github/workflows/ci.yml`).

- `nightly.yml` runs at 02:17 UTC. When `main` changed, it tests it and publishes it as the `nightly` prerelease. Start it from the Actions tab to build at once.
- `release.yml` runs for a tag such as `v0.2.0`. The tag must match the version in `package.json`. It tests the tag and publishes a stable release.

Both publish `peel.tar.gz`, `SHASUMS256.txt` and `version.json`. `bun scripts/package.ts --channel nightly` builds them locally. One archive serves every system, because Peel runs on Bun and each machine installs its own packages after unpacking. Only the playback engine differs per system, and Peel downloads it itself.

A release install checks its channel when Peel opens, at most every six hours. A newer build downloads, is checked against its checksum, and installs beside the running one. It starts when Peel next opens, or at once from the update row in Settings. The version before it stays until the following update.

GitHub turns off scheduled workflows in a repository without activity for 60 days. A push or a manual run turns the nightly back on.

## Signing the engine

Widevine on macOS and Windows plays only in a player signed through castlabs' EVS service. The maintainer signs castlabs' Electron once per Electron version and publishes it as the `engine-v<version>` release, so listeners need no castlabs account.

`bun scripts/sign-engine.ts` does it. It explains what it needs and prints how long the signature stays valid. Sign and publish again before that date. Peel compares its copy with the release's checksums once a day and downloads a renewed one by itself. If that download fails, Peel keeps the copy it has.

Only one publication can change the release at a time. The script holds a `publishing.lock` file on the release while it runs, and stops without uploading if it can't read the checksums already published. If a publication stopped without finishing, delete `publishing.lock` from the release before running it again.

Linux uses castlabs' build directly, without a signature.
