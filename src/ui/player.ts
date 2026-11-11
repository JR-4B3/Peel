import { BoxRenderable, TextRenderable, t, fg, type CliRenderer, type MouseEvent } from "@opentui/core";
import type { Model } from "../model";
import { colour, icon } from "../theme";
import { duration } from "../types";
import { Cover, tag, type Button } from "./widgets";

// What the player's buttons open elsewhere in the interface.
export interface PlayerActions {
  showCover(art: string | undefined, name: string, detail: string): void;
  toggleDevices(): void;
  toggleLyrics(): void;
  focusContent(): void;
}
type MakeButton = (id: string, glyph: string, hint: string, action: () => void, tint?: string) => Button;

// The player at the bottom: cover, song, progress and the playback buttons.
export class PlayerPanel {
  readonly panel: BoxRenderable;
  readonly cover: Cover;
  readonly lyricsButton: Button;
  // The playback buttons show no keys beside them. The ? list names their keys.
  readonly buttons: Button[] = [];
  private title: TextRenderable;
  private subtitle: TextRenderable;
  private indicator: TextRenderable;
  private quality: TextRenderable;
  private progress: TextRenderable;
  private playButton: Button;
  private favouriteButton: Button;
  private shuffleButton: Button;
  private repeatButton: Button;
  private volumeText: TextRenderable;

  // A line above the player sets it apart, without a box around it. The song is on the left, the
  // playback buttons in the middle, and the volume and lyrics on the right, as in most players.
  constructor(private ctx: CliRenderer, private model: Model, button: MakeButton, ui: PlayerActions) {
    const control = (id: string, glyph: string, action: () => void, tint?: string) => {
      const made = button(id, glyph, "", action, tint);
      made.flexShrink = 0; this.buttons.push(made);
      return made;
    };
    // The mouse wheel anywhere over the player changes the volume in 5% steps. Lists scroll as before.
    this.panel = new BoxRenderable(ctx, { id: "player-panel", border: ["top"], borderStyle: "single", borderColor: colour.line, paddingX: 1, height: 4, flexShrink: 0, flexDirection: "row", gap: 2,
      onMouseScroll: event => {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        event.stopPropagation();
        void model.volume(direction === "up" ? 0.05 : -0.05);
      } });
    this.cover = new Cover(ctx, { id: "player-cover", width: 6, height: 3, glyph: "\u{F075A}" });
    this.cover.onMouseDown = event => { const song = model.playback.nowPlaying; if (event.button === 0 && song) { event.stopPropagation(); ui.showCover(song.artwork?.url, song.albumName ?? song.name ?? "", song.artistName ?? ""); } };
    this.panel.add(this.cover);
    const deck = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0 });

    // The first row: the song, the playback buttons centred under the window, and the volume.
    // The two sides share what is left equally, so the buttons stay in the middle.
    const top = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2 });
    const side = { flexDirection: "row" as const, height: 1, gap: 2, flexGrow: 1, flexBasis: 0, minWidth: 0 };
    const song = new BoxRenderable(ctx, side);
    this.title = new TextRenderable(ctx, { id: "now-playing", fg: colour.text, attributes: 1, flexShrink: 1, minWidth: 0, height: 1, truncate: true, selectable: false });
    this.favouriteButton = control("favourite", icon.heartOutline, () => void model.toggleFavourite(), colour.faint);
    this.indicator = new TextRenderable(ctx, { id: "playback-indicator", fg: colour.faint, height: 1, flexShrink: 0, selectable: false });
    song.add(this.title); song.add(this.favouriteButton); song.add(this.indicator);
    const controls = new BoxRenderable(ctx, { id: "controls", height: 1, flexDirection: "row", gap: 3, flexShrink: 0 });
    this.shuffleButton = control("shuffle", icon.shuffleOff, () => void model.act("/playback/shuffle/toggle"), colour.faint);
    this.playButton = control("play-pause", icon.play, () => void model.act("/playback/toggle"));
    this.repeatButton = control("repeat", icon.repeatOff, () => void model.act("/playback/repeat/toggle"), colour.faint);
    for (const item of [this.shuffleButton, control("previous", icon.previous, () => void model.skip(-1)), this.playButton, control("next", icon.next, () => void model.skip(1)), this.repeatButton]) controls.add(item);
    const sound = new BoxRenderable(ctx, { ...side, justifyContent: "flex-end", gap: 1 });
    this.lyricsButton = control("lyrics-toggle", icon.lyrics, () => ui.toggleLyrics(), colour.faint);
    this.lyricsButton.marginRight = 2;
    this.volumeText = new TextRenderable(ctx, { id: "volume", content: "50%", fg: colour.muted, height: 1, flexShrink: 0, selectable: false });
    for (const item of [this.lyricsButton, control("volume-down", icon.volumeDown, () => void model.volume(-0.05), colour.muted), this.volumeText, control("volume-up", icon.volumeUp, () => void model.volume(0.05), colour.muted)]) sound.add(item);
    top.add(song); top.add(controls); top.add(sound);
    deck.add(top);

    // The second row: artist and album, and the stream's quality at the right.
    const about = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2 });
    this.subtitle = new TextRenderable(ctx, { id: "now-playing-artist", fg: colour.muted, height: 1, flexGrow: 1, minWidth: 0, truncate: true, selectable: false,
      onMouseDown: event => { const song = model.playing; if (event.button === 0 && song) { event.stopPropagation(); void model.openArtist(song); ui.focusContent(); } } });
    this.quality = new TextRenderable(ctx, { id: "quality", height: 1, flexShrink: 0, selectable: false });
    about.add(this.subtitle); about.add(this.quality);
    deck.add(about);
    this.progress = new TextRenderable(ctx, { id: "seek", content: "", fg: colour.accent, height: 1, width: "100%", selectable: false, onMouseDown: event => this.seekClick(event) });
    deck.add(this.progress);
    this.panel.add(deck);
  }

  private progressCells(state = this.model.playback) {
    const width = this.progress.width || this.ctx.terminalWidth - 16;
    return Math.max(1, width - duration(state.time.currentTime).length - duration(state.time.duration).length - 2);
  }

  // What the player streams: Apple's lossless ALAC through the hi-res player, or AAC at the
  // quality chosen in Settings.
  private qualityLabel() {
    if (this.model.player.lossless) return "Lossless";
    return this.model.preferences.quality === "standard" ? "AAC 64 kbps" : "AAC 256 kbps";
  }

  draw() {
    const state = this.model.playback;
    const connected = this.model.connected;
    const song = state.nowPlaying;
    this.title.content = song ? song.name ?? "Untitled" : "Nothing playing";
    const target = this.model.target ?? this.model.preferences.remote;
    // The device that plays may be out of reach, for example asleep or on another network. Saying so
    // explains why this computer shows nothing.
    const away = !song && !target ? this.model.devices.find(device => device.output && !device.self && device.paired && !device.online) : undefined;
    this.subtitle.content = away ? `${away.name} plays the music, but this Peel cannot reach it. Press d to see your devices.`
      : song ? [song.artistName, song.albumName].filter(Boolean).join("  /  ") : this.model.starting ? "Starting the player..." : "Choose a song to start";
    this.cover.setArt(song?.artwork?.url);
    const favourite = this.model.favourite;
    this.favouriteButton.visible = !!song;
    this.favouriteButton.set(favourite ? icon.heart : icon.heartOutline, "", favourite ? colour.heart : colour.faint);
    const playing = connected && state.state === "playing";
    // The play button already says when it plays, so only the other states are written out.
    const label = !connected ? (this.model.starting ? "Starting" : "Stopped") : playing ? "" : state.state === "paused" ? "Paused" : "Stopped";
    this.indicator.content = label;
    this.indicator.visible = !!label;
    this.playButton.set(playing ? icon.pause : icon.play);
    this.shuffleButton.set(state.shuffleMode ? icon.shuffle : icon.shuffleOff, "", state.shuffleMode ? colour.accent : colour.faint);
    this.repeatButton.set(state.repeatMode === "one" ? icon.repeatOne : state.repeatMode === "all" ? icon.repeat : icon.repeatOff, "", state.repeatMode === "none" ? colour.faint : colour.accent);
    this.volumeText.content = `${Math.round(state.volume * 100)}%`;
    this.quality.visible = !!song && connected;
    this.quality.content = tag(this.qualityLabel(), this.model.player.lossless ? colour.accent : colour.muted);
    const cells = this.progressCells(state);
    const ratio = state.time.duration > 0 ? Math.min(1, Math.max(0, state.time.currentTime / state.time.duration)) : 0;
    const filled = Math.floor(ratio * cells);
    this.progress.content = t`${fg(colour.muted)(duration(state.time.currentTime))} ${fg(colour.accent)("━".repeat(filled))}${fg(colour.faint)("─".repeat(cells - filled))} ${fg(colour.muted)(duration(state.time.duration))}`;
  }

  private seekClick(event: MouseEvent) {
    const maximum = this.model.playback.time.duration;
    if (event.button !== 0 || !(maximum > 0)) return;
    const start = duration(this.model.playback.time.currentTime).length + 1;
    const cells = this.progressCells();
    const ratio = Math.max(0, Math.min(1, (event.x - this.progress.x - start) / Math.max(1, cells - 1)));
    void this.model.act("/playback/seek", { position: maximum * ratio });
  }
}
