# Playback engine

A hidden MusicKit JS player in castlabs' Electron, which adds Widevine. Peel starts it and controls it through a local HTTP interface that requires a private key.

`bun run engine`, from the project folder, downloads castlabs' Electron v44.5.1+wvcus for this system into `.electron` once, on Windows and macOS the copy signed through castlabs EVS from Peel's `engine-v44.5.1+wvcus` release, then runs the engine in the terminal. `PEEL_ENGINE_SHOW=1` shows the engine window.

The engine loads `https://music.apple.com/robots.txt`, because Apple accepts the web player's token only from music.apple.com, and injects `engine.js`. The page's content policy allows MusicKit from Apple's CDN. The first run opens Apple's sign-in window. The sign-in is kept in the engine's profile folder, `~/.config/peel-engine` on Linux.

Each request from Peel carries its process ID. Once every Peel that sent one has exited, the engine quits. `POST /release` removes the calling Peel and quits when no other Peel is left. `POST /quit` stops it at once.

Measured on main on 8 October 2026:

| Step | Time after launch |
| --- | --- |
| Widevine ready | 0.11 s (0.9 s on the very first run, which installs it) |
| Developer token | 0.17 s, from Peel's cache |
| MusicKit configured | 0.30 s |
| Search to audible playback | 1.8 s |

Playback ran at the right position after ten seconds.
