# Hi-res playback

Peel's standard engine plays Apple Music's web stream, which is AAC. Hi-res Lossless (ALAC up to 24-bit/192 kHz) is only decrypted inside Apple's own apps. On Linux, Peel runs Apple's Android app in a slimmed-down [Waydroid](https://waydro.id), with its window on an invisible display, and the audio reaches PipeWire bit-perfect.

This directory holds the pipeline that builds, tests and updates that Android.

## Setup (once)

Hi-res needs an x86_64 PC with Linux, systemd and PipeWire, because Waydroid's images and Apple Music's Android app are x86_64 builds. On the machine that plays the music, run these in the installed Peel's folder. Then `peel-hires` follows each Peel update. In a source checkout, run them in the checkout instead.

```sh
cd ~/.local/share/peel/versions/"$(cat ~/.local/share/peel/current)"
sudo hires/install.sh "$USER"   # packages, stock Waydroid, root helper, a sudoers rule for only that helper
hires/install.sh --user         # peel-hires CLI, systemd units, PipeWire sample rates
peel-hires setup                # first release, Apple Music, sign-in, then the full test
```

`sudo hires/install.sh` installs the commands the pipeline runs with `dnf` on Fedora and its derivatives: Waydroid, LXC, erofs-utils, Weston, android-tools, a JDK 17 or later whose `java` has the compiler and jarsigner modules, and `keytool` (java-headless, the release's default JDK), python3, curl, unzip, git, pulseaudio-utils and pipewire-utils. On other distributions it lists the commands that are missing and stops before it changes anything, so install those packages first and run it again. It then initializes stock Waydroid with `waydroid init -s VANILLA` when `/var/lib/waydroid/waydroid.cfg` does not exist yet, which downloads about 1 GB, and enables `waydroid-container`.

`peel-hires setup` first runs `peel-hires preflight`, which checks the architecture, these commands, the JDK, an initialized and running Waydroid, the root helper and the user units. It names whatever is missing and stops before it starts Android or builds anything.

`peel-hires setup` starts Android on the invisible display, builds and switches to the first release, and installs Apple Music. It then shows Apple Music once for sign-in and hides it again, and finally runs `peel-hires update --force`, which tests the release and keeps it. Until Apple Music is installed and signed in, `peel-hires update` stops with a notification instead of testing and switching back. Peel plays through hi-res by itself only once that first update has passed its tests; before that it keeps the web engine, unless `PEEL_PLAYER=hires` asks for hi-res.

Setup authorizes this machine's adb key inside Android through the root helper, because Android's confirmation prompt would appear on the invisible display.

`peel-hires apple-update` installs or updates the Apple Music app. The pipeline downloads it from APKPure and refuses any package that isn't signed with Apple's certificate.

## What a release is

`peel-hires build` has the root helper fetch Waydroid's newest system and vendor images, check them against Waydroid's published SHA-256 sums, and repack them:

- removes what [`manifest.conf`](manifest.conf) lists: apps nothing in playback uses, and the 32-bit graphics stack;
- runs Android with only the 64-bit zygote;
- adds Peel's audio driver ([`android/audio_hw.c`](android/audio_hw.c), built by [`android/build-hal.sh`](android/build-hal.sh)), which opens streams at the rate and format Android asks for;
- adds the audio policy ([`android/audio_policy_configuration.xml`](android/audio_policy_configuration.xml)) that runs Android's mixer at 192 kHz float;
- adds Peel's framework overlay ([`android/overlay`](android/overlay)), a static resource overlay in the product partition. It turns off the window manager's wait for a wallpaper at boot. `peel-hires` builds it with Google's aapt2, downloaded once and checked against its SHA-256, and signs it with the JDK's jarsigner and a key made once in `~/.cache/peel-hires/overlay-work`;
- sets release build tags, which Apple Music requires;
- skips Android's boot animation, which nobody sees on the invisible display and which held back each boot by about 5 seconds;
- writes both images as EROFS, compressed as the manifest's `[build]` section says: zstd at level 15, which makes a release 796 MB instead of 1,055 MB with LZ4HC and boots as fast. The build runs at low priority on half the cores.

A release ID combines the image dates with a hash of the manifest, the policy and the driver, for example `s20260927-v20261022-1a2b3c4d`. Releases live in `/var/lib/peel-hires/releases/`.

## The root helper

Repacking and switching images need root. `install.sh` installs [`root/peel-hires-root`](root/peel-hires-root) root-owned and adds a sudoers rule that lets the user run only that file without a password. Its boundary is that nothing the caller passes changes the host outside `/var/lib/peel-hires` and Waydroid's own state, or reveals a file the caller couldn't read:

- It downloads Waydroid's images itself and checks their SHA-256 against Waydroid's list. It never mounts an image from the caller.
- It reads the caller's inputs (manifest, audio driver, policy, adb key) through `runuser` with the caller's own permissions, so a symlink or a swapped file can't make it read root's files.
- It edits image trees one path component at a time with `O_NOFOLLOW`, so a symlink inside an image can't point a removal or a write at the host.
- Image trees live in a root-only folder, mounted `nosuid,nodev,noexec` while they are copied.
- Properties are checked to be plain `key=value` lines before they reach `waydroid.cfg`.
- Steps that change state hold one lock, and a switch stops the container before touching anything Android has mounted.

The helper doesn't update itself. After changing it, run `sudo install.sh "$USER"` again.

## Tests

`peel-hires test` writes a JSON report to `~/.local/state/peel-hires/reports/`:

| Test | Passes when |
| --- | --- |
| boot | Android finishes booting |
| properties | Release build tags are set and only the 64-bit zygote runs |
| bit-perfect-android | A random 24-bit signal played at 192 kHz through Android arrives in PipeWire sample-for-sample identical |
| audio-driver-rate | The audio driver opened a 192 kHz float stream |
| apple-music-app | Apple Music is installed, signed in, set to Hi-Res Lossless, opens, its screen can be read, and it is not blocking a "rooted" device |
| apple-music-hires-playback | Apple Music decodes ALAC at 192 kHz and every sample reaching PipeWire is an exact 24-bit value |

The audio tests play into a temporary silent sink and put Waydroid's streams back on their own sinks afterwards. The test signal starts with silence, and the default output is muted for the moment Apple Music starts, so nothing is heard. The last test uses the Apple account's single stream, so it is skipped while music is playing. It shows that Apple's audio reaches PipeWire at 192 kHz with full 24-bit samples; only the test signal is compared sample by sample, because Apple's decoded audio has no reference to compare against.

`hires/tests/offline/run.sh` tests parts of the pipeline without Waydroid, Android or audio hardware: the audio driver's write function against a simulated ALSA device, and the health checks against a simulated adb that fails in different ways. It needs bash, python3 and a C compiler, and `bun test` runs it too.

## Updates

`peel-hires-update.timer` runs `peel-hires update` daily at 04:30. When Waydroid publishes new images, the manifest, the audio policy, the audio driver, the rate helper or the installed root helper changes, or the host's Waydroid, LXC or kernel version changes, it builds a release if needed, switches to it, and runs the tests. If they pass, the release stays; if anything fails, a boot that never finishes included, it switches back to exactly the release that was current before, and sends a desktop notification. Its confirmed release and fallback stay as they were. If music is playing, in Android or in Peel's web engine, it waits for the next run. It checks again after the build, just before it switches, and before it updates Apple Music, so music that started during a build is not interrupted. `peel-hires update --force` switches and tests even while music plays.

After a passing release it updates the Apple Music app and runs the tests again. Android won't downgrade an app without wiping its data, so a bad Apple Music version is reported, not undone. Last, if nothing is playing, it restarts Apple Music and stops Android's background apps (`peel-hires trim`). Apple Music grows from about 115 to 475 MB over a day of use.

`peel-hires-watchdog.timer` runs `peel-hires watchdog` every 5 minutes. If Android stops answering over adb, isn't booted, or has no `system_server` in two checks in a row, it restarts the session and sends a notification. It waits while music plays or an update runs. It also stops an Android that runs without a Peel, for example after Peel's host was killed.

## Playback from Peel

Peel finds the pipeline through its root helper and then plays through Android instead of its web engine. Peel runs its own copy of `bin/peel-hires`, so the controller always matches the Peel version.

`peel-hires controller` starts Android when it is not running, builds [`android/control/Control.java`](android/control/Control.java) with the host's JDK and Google's D8 (downloaded once and checked against its SHA-256), and starts it inside Android with `app_process` as the shell user. It prints where the controller listens: Android's address, port 7845, and a random key. A running controller of the same build is left alone. A new build replaces it.

The controller talks to Apple Music's media session through Android's hidden `ISessionManager` and `ISessionController` interfaces, which the shell user may use. It plays catalog songs through the commands Apple's own screens use (`ADD_QUEUE_ITEMS` with a queue provider built from Apple's own classes, loaded from its APK), so Apple Music's screen never opens. It answers one command per line over TCP, in about a millisecond:

| Command | Does |
| --- | --- |
| `state`, `queue` | What plays, the position and duration, and the queue from the playing entry on |
| `list <index> <id,...>` | Replaces the queue with these catalog songs and plays the one at index |
| `add <next\|end> <id,...>` | Adds songs after the playing one or at the end |
| `play`, `pause`, `stop`, `next`, `previous`, `seek <ms>`, `skip <queue id>` | Transport |
| `move <queue id> <target> <1 after\|2 before>`, `remove <queue id>` | Queue edits |
| `shuffle <0\|1>`, `repeat <0\|1\|2>`, `autoplay <true\|false>`, `volume <0..1>` | Modes and Android's media volume, as a share of its steps |
| `rate [hz]` | The rate Android mixes at, after switching it through the rate helper |

The controller uses about 42 MB (PSS). Apple Music without its screen uses about 165 MB, against 350 MB once its screen has opened.

## Memory and disk

Turning off Android apps that playback doesn't use saved about 60 MB, but Android then booted 2 seconds slower without a home screen app, and stalled when the persistent Phone app was off. `peel-hires` therefore keeps all apps on, and the nightly trim stops the ones that linger.

Releases leave out SystemUI, the status bars and notifications, which saves about 150 MB. Android's default wallpaper is part of SystemUI, and Android 13's window manager holds the end of boot until a wallpaper is drawn. Without SystemUI it waited for its 30-second timeout, so Android booted in about 37 seconds. The framework overlay sets `config_checkWallpaperAtBoot` to false, and Android boots in about 6 seconds, also right after the PC starts with nothing cached. All tests pass without SystemUI.

Android runs only while Peel uses it. When the last Peel closes, Peel's hi-res host pauses the music and runs `peel-hires session idle` between two controller requests, so a Peel that attaches meanwhile waits and then starts Android again. `session idle` stops Android unless the sign-in window is open or Android plays audio. Setup, updates, `peel-hires test`, `build`, `apple-update` and the watchdog hold the update lock while they use Android, so `session idle` and the watchdog leave Android to them. Setup, updates, tests and the watchdog stop it when they end unless Peel's host runs: the `peel-hires-host` unit is active, or something answers on the host's port. Starting the controller and stopping Android take a second lock, so a stop that found no host finishes before that host's controller starts Android again. The next Peel starts Android as it opens, and `peel-hires controller` answers about 7 seconds later. The nightly update starts Android even when nothing changed, to check Apple Music's version.

While it runs, Android's container holds about 1.6 GB: about 800 MiB of anonymous and kernel memory after Apple Music has played, and about 800 MiB of file cache, which the kernel can reclaim.

`peel-hires prune` deletes stock Waydroid's images (2.4 GB) once no release state refers to them, and the image zips in `~/.cache/peel-hires/downloads`, which the root helper keeps its own verified copies of. It and every passing update also remove releases that are neither active, confirmed, nor the fallback.

With `AGENT=claude` in `~/.config/peel-hires/config`, a failed update starts a Claude Code agent with [`agent/repair.md`](agent/repair.md). Its instructions limit it to restoring lines removed in `manifest.conf` and to leaving a passing release active. Those instructions are not a security boundary; the agent can do what the `peel-hires` CLI can, which the root helper bounds as described above. It is off by default.

## Known limits

- Android mixes at the playing song's rate only with the rate helper. Apple Music logs each song's format when it prepares the song, about a second before it plays, and opens a new audio track when the format changes. The controller remembers that rate and, when the playing song changes, asks [`android/control/RateServe.java`](android/control/RateServe.java) to switch the mixer. RateServe runs as audioserver, the only user Android 13 lets change a mixer's rate (`filterReservedParameters`), and calls AudioFlinger's `setParameters` with `sampling_rate`. The audio driver then reopens the device at that rate. The root helper's `rate-helper` verb starts RateServe from the release image; it takes no arguments. A song whose rate differs from the one before may start with a short gap while the device reopens. Without the rate helper, Android mixes at 192 kHz and resamples other songs.
- Apple allows one stream per account. A test that plays Apple Music stops playback on every other device.
- Signing in needs the Apple Music window once. Apple can end the session at any time, and then `peel-hires signin` is needed again.

[`docs/phase-one.md`](docs/phase-one.md) describes how hi-res was first proven, with measurements.
