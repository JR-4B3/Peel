# Engine prototype

A hidden MusicKit JS player in castlabs' Electron, which adds Widevine. It tests whether Peel can play Apple Music without Cider. Throwaway code: it plays one song and logs timings.

`./run.sh --ozone-platform=wayland` downloads castlabs' Electron v44.5.1+wvcus into `.electron` once, then starts the engine. `PEEL_PLAY_TERM="artist title"` plays the first matching song. `PEEL_ENGINE_SHOW=1` shows the engine window.

The engine loads `https://music.apple.com/robots.txt`, because Apple accepts the web player's token only from music.apple.com, and injects `engine.js`. The page's content policy allows MusicKit from Apple's CDN. The first run opens Apple's sign-in window. The sign-in is kept in `~/.config/peel-engine`.

Measured on main on 8 October 2026, with Cider running:

| Step | Time after launch |
| --- | --- |
| Widevine ready | 0.11 s (0.9 s on the very first run, which installs it) |
| Developer token | 0.17 s, from Peel's cache |
| MusicKit configured | 0.30 s |
| Search to audible playback | 1.8 s |

Playback ran at the right position after ten seconds. Known gap: the engine plays at MusicKit's full volume and has no controls yet.
