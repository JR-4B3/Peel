// Runs inside https://music.apple.com/robots.txt. Loads MusicKit JS and reports progress with "peel:" logs.
(() => {
  const log = text => console.log(`peel:${text}`);
  document.addEventListener("musickitloaded", async () => {
    log("musickit loaded");
    const music = await MusicKit.configure({ developerToken: window.peel.token, app: { name: "Peel", build: "0.0.1" } });
    log(`configured, authorized=${music.isAuthorized}, storefront=${music.storefrontId}`);
    music.addEventListener("playbackStateDidChange", () => log(`state ${MusicKit.PlaybackStates[music.playbackState]}`));
    music.addEventListener("mediaPlaybackError", event => log(`playback error ${JSON.stringify(event?.message ?? event)}`));
    if (!music.isAuthorized) {
      log("signing in: complete Apple's sign-in window");
      try { await music.authorize(); } catch (error) { log(`sign-in failed ${error}`); return; }
      log(`authorized=${music.isAuthorized}, storefront=${music.storefrontId}`);
    }
    if (!window.peel.play) return log("ready, nothing to play");
    const found = await music.api.music("/v1/catalog/{{storefrontId}}/search", { term: window.peel.play, types: "songs", limit: 1 });
    const song = found.data.results.songs?.data?.[0];
    if (!song) return log("no song found");
    log(`queueing ${song.attributes.name} by ${song.attributes.artistName} (${song.id})`);
    await music.setQueue({ song: song.id, startPlaying: true });
    log(`setQueue done, nowPlaying=${music.nowPlayingItem?.title}`);
    setTimeout(() => log(`after 10 s: time=${music.currentPlaybackTime?.toFixed(1)} s, state=${MusicKit.PlaybackStates[music.playbackState]}`), 10000);
  });
  const script = document.createElement("script");
  script.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
  script.dataset.webComponents = "";
  document.head.append(script);
})();
