# Peel on phones

Status: concept only. Nothing here runs yet. Open [`concept.html`](concept.html) in a browser to see the layout.

## Layout

- Same look as the terminal app: panels with titles in the border, Peel's colors, monospace type.
- Four tabs at the bottom: Home, Library, Queue, Settings. Settings may change.
- Library holds songs, albums, artists and playlists, switched by a row at the top of the tab.
- Screens opened on top of a tab, such as lyrics or an album, show a `‹` back arrow in their panel title. No text hints like "swipe down to close".
- Settings holds the same settings as the desktop's Settings page, saved in the same place: audio quality (High 256 kbps or Standard 64 kbps), updates (Stable or Nightly), and hearts in Favourite Songs. The phone app reads and changes them through the playing machine, so both always agree.
- The player strip sits above the tabs and says where the music plays ("Playing on main"). Tapping the device name picks another device.

## How it would run

The first version is a web app that Peel serves from the machine that plays, added to the phone's home screen. It needs no Apple developer account and no re-signing every 7 days, and it works on iPhone and Android.

A web page on the phone can only play Apple Music's standard AAC stream itself. As a remote it doesn't need to, because the playing machine does the hi-res playback. It depends on the `remote-play` branch, which adds the network API the phone talks to.

A native app is only worth it later for lock-screen controls, widgets and Live Activities. On iPhone that means sideloading with SideStore or AltStore, which re-sign every 7 days, until there is a paid developer account.
