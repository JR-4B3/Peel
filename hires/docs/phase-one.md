# Hi-res Apple Music on Linux: phase one

Result: Apple Music's own Android app, running in Waydroid on a Linux desktop, plays Hi-Res Lossless and the samples reach the USB audio interface unchanged. Only an Apple Music subscription is needed. No Google account, no Windows, no Mac.

Measured on 2026-11-05:

| Song | Apple's ALAC stream | Android mixer | PipeWire stream | Audio interface | Samples exact? |
| --- | --- | --- | --- | --- | --- |
| Pink Floyd, "Time" (album 1065973699) | 96 kHz / 24-bit | 96 kHz float | F32LE 96 kHz | S32_LE 96 kHz | yes, 2,878,973 of 2,878,973 on the 24-bit grid over 15 s |
| Miles Davis, "So What" (268443097) | 192 kHz / 24-bit | 192 kHz float | F32LE 192 kHz | S32_LE 192 kHz | yes, 3,837,946 of 3,837,946 over 10 s |

"On the 24-bit grid" means every float sample times 2^23 is an integer. Resampling, a volume other than unity, or any filter pushes almost all samples off that grid (we saw 3 to 8 percent on it whenever something was wrong). A spectrum check showed content above 24 kHz (96 kHz song) and above 48 kHz (192 kHz song), so neither was an upsampled lower-rate source.

## What it took

Each step below fixed one thing that blocked hi-res. They are all on `main` now.

1. **Waydroid with the VANILLA image.** `dnf install waydroid android-tools`, then `waydroid init -s VANILLA -c https://ota.waydro.id/system -v https://ota.waydro.id/vendor`. Some distributions package Waydroid without default OTA URLs, so `-c` and `-v` are required.
2. **Apple Music APK without a Google account.** `apkeep -a com.apple.android.music -d apk-pure -o acknowledge_dangers=true,arch=x86_64`. The split APKs are signed by Apple (`CN=Apple Inc`); Android refuses mixed signatures, so the base APK is Apple's too. Installed with `adb install-multiple` (base, `config.x86_64`, `config.xhdpi`). Version 5.1.0-beta.
3. **Root check.** The app refuses to start on "rooted devices". It checks `ro.build.tags` (`test-keys`), `ro.build.type` (`userdebug`) and a few `su` paths. Waydroid has no `su`; overriding the build props in `[properties]` of `/var/lib/waydroid/waydroid.cfg` and running `waydroid upgrade --offline` was enough. Side effect: Android shows "There's an internal problem with your device" once per boot because the fingerprints no longer match. It is harmless.
4. **Network type.** The app picks its stream by network: Wi-Fi uses the Wi-Fi quality setting, cellular uses the cellular one, anything else falls back to AAC 256. Waydroid's network is Ethernet. `waydroid prop set persist.waydroid.fake_wifi com.apple.android.music` makes the app see Wi-Fi. This probably also causes the "You're Offline" screens.
5. **App settings.** Lossless on, Wi-Fi and cellular streaming set to Hi-Res Lossless, Sound Check off, Crossfade off. Also `key_is_bit_stream_switching_enabled=false` in `shared_prefs/com.apple.android.music.playback_preferences.xml`, so the player starts on the best variant instead of ramping up from AAC. Not yet tested whether this one is still needed once Wi-Fi is faked.
6. **Audio HAL.** Waydroid's published vendor image (2026-10-22) has an audio HAL that always opens 48 kHz S16. Upstream fixed this on 2026-11-02 (commit `503d82229c`). `hires/android/build-hal.sh` builds the current upstream source with the Android NDK. The HAL service is 32-bit, so the build goes to `/var/lib/waydroid/overlay/vendor/lib/hw/audio.primary.waydroid.so`.
7. **Audio policy.** `hires/android/audio_policy_configuration.xml` (in the overlay at `vendor/etc/`) sets Android's primary mixer to float at 192 kHz instead of 16-bit at 48 kHz. It also declares a direct output, which Apple Music does not use (on Android 13 apps must request it explicitly).
8. **Android music volume at maximum** (`cmd media_session volume --stream 3 --set 15`). Anything lower scales the samples.
9. **PipeWire allowed rates.** `pw-metadata -n settings 0 clock.allowed-rates "[ 44100 48000 88200 96000 176400 192000 ]"`. This is a runtime setting and resets when PipeWire restarts. PipeWire only switches a device's rate when no other stream holds it at another rate.

## Known gaps for phase two

- **The mixer rate is fixed.** At 192 kHz, a 44.1 kHz or 96 kHz song is resampled by Android. Bit-perfect for every song needs the mixer to follow the song. The HAL ignores `sampling_rate` in `out_set_parameters`; adding that and a small controller that sets the rate when a track starts is the likely route.
- **Starting songs works by link.** `am start -a android.intent.action.VIEW -d <music.apple.com link> com.apple.android.music` opens the album at the song but does not start playback; a tap (or a media key) does. Play, pause and resume work with `input keyevent 126/127`.
- **The app needs a visible Waydroid window.** Running it fully headless is untested.
- **Many Apple "hi-res" songs are 48 kHz.** Apple's `hi-res-lossless` trait is set on songs whose best variant is 48 kHz/24-bit. `hires/tests/scan.ts` reads the HLS master to show the real rates.

## Scripts

The phase-one scripts became the pipeline's tests in [`hires/tests/`](../tests):

- `pwcap.py`: records a PipeWire stream's own output ports (not the default source), and moves Waydroid's streams to a silent test sink.
- `grid.py FILE`: reports how many float samples lie on the 16-, 20- and 24-bit grids.
- `spec.py FILE RATE`: energy per frequency band.
- `mk-signal.py`, `aaplay.c`, `capture.py`: a known 24-bit test signal played through Android's mixer with AAudio and compared sample by sample in PipeWire. This shows the Android path is transparent independently of Apple Music.
- `scan.ts`, `ehls.ts`: catalog search with audio traits and the real ALAC rates from the HLS master, using Peel's saved tokens.

The steps above were done by hand. The pipeline in [`hires/`](../README.md) now does them, except signing in.
