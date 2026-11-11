import { BoxRenderable, TextRenderable, t, fg, type CliRenderer, type MouseEvent } from "@opentui/core";
import type { Model } from "../model";
import { colour, icon } from "../theme";
import { duration } from "../types";
import { Cover, type Button } from "./widgets";

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
  private title: TextRenderable;
  private subtitle: TextRenderable;
  private indicator: TextRenderable;
  private progress: TextRenderable;
  private controls: BoxRenderable;
  private playButton: Button;
  private favouriteButton: Button;
  private devicesButton: Button;
  private shuffleButton: Button;
  private repeatButton: Button;
  private volumeText: TextRenderable;

  constructor(private ctx: CliRenderer, private model: Model, button: MakeButton, ui: PlayerActions) {
    // The mouse wheel anywhere over the player changes the volume in 5% steps. Lists scroll as before.
    this.panel = new BoxRenderable(ctx, { id: "player-panel", border: true, borderStyle: "rounded", borderColor: colour.faint, paddingX: 1, height: 6, flexShrink: 0, flexDirection: "row", gap: 2,
      onMouseScroll: event => {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        event.stopPropagation();
        void model.volume(direction === "up" ? 0.05 : -0.05);
      } });
    this.cover = new Cover(ctx, { id: "player-cover", width: 8, height: 4, glyph: "\u{F075A}" });
    this.cover.onMouseDown = event => { const song = model.playback.nowPlaying; if (event.button === 0 && song) { event.stopPropagation(); ui.showCover(song.artwork?.url, song.albumName ?? song.name ?? "", song.artistName ?? ""); } };
    this.panel.add(this.cover);
    const deck = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0 });
    const nowPlaying = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2 });
    this.title = new TextRenderable(ctx, { id: "now-playing", fg: colour.text, attributes: 1, flexShrink: 1, minWidth: 0, height: 1, truncate: true, selectable: false });
    this.favouriteButton = button("favourite", icon.heartOutline, "f", () => void model.toggleFavourite(), colour.faint);
    this.indicator = new TextRenderable(ctx, { id: "playback-indicator", fg: colour.faint, height: 1, flexGrow: 1, minWidth: 0, selectable: false, truncate: true });
    // The devices button sits at the top right of the player, under the popup it opens.
    this.devicesButton = button("devices", icon.devices, "d", () => ui.toggleDevices(), colour.faint);
    this.devicesButton.flexShrink = 0;
    nowPlaying.add(this.title); nowPlaying.add(this.favouriteButton); nowPlaying.add(this.indicator); nowPlaying.add(this.devicesButton); deck.add(nowPlaying);
    this.subtitle = new TextRenderable(ctx, { id: "now-playing-artist", fg: colour.muted, height: 1, width: "100%", truncate: true, selectable: false,
      onMouseDown: event => { const song = model.playing; if (event.button === 0 && song) { event.stopPropagation(); void model.openArtist(song); ui.focusContent(); } } });
    deck.add(this.subtitle);
    this.progress = new TextRenderable(ctx, { id: "seek", content: "", fg: colour.accent, height: 1, width: "100%", selectable: false, onMouseDown: event => this.seekClick(event) });
    deck.add(this.progress);
    this.controls = new BoxRenderable(ctx, { id: "controls", height: 1, flexDirection: "row", gap: 2 });
    this.controls.add(button("previous", icon.previous, "p", () => void model.skip(-1)));
    this.playButton = button("play-pause", icon.play, "space", () => void model.act("/playback/toggle"));
    this.controls.add(this.playButton);
    this.controls.add(button("next", icon.next, "n", () => void model.skip(1)));
    this.controls.add(new TextRenderable(ctx, { content: " ", width: 1, height: 1 }));
    this.shuffleButton = button("shuffle", icon.shuffleOff, "s", () => void model.act("/playback/shuffle/toggle"), colour.faint);
    this.repeatButton = button("repeat", icon.repeatOff, "r", () => void model.act("/playback/repeat/toggle"), colour.faint);
    this.controls.add(this.shuffleButton); this.controls.add(this.repeatButton);
    this.controls.add(new TextRenderable(ctx, { content: " ", width: 1, height: 1 }));
    this.controls.add(button("volume-down", icon.volumeDown, "-", () => void model.volume(-0.05)));
    this.volumeText = new TextRenderable(ctx, { id: "volume", content: "50%", fg: colour.muted, height: 1, selectable: false });
    this.controls.add(this.volumeText);
    this.controls.add(button("volume-up", icon.volumeUp, "+", () => void model.volume(0.05)));
    this.controls.add(new TextRenderable(ctx, { content: " ", width: 1, height: 1 }));
    this.lyricsButton = button("lyrics-toggle", icon.lyrics, "y", () => ui.toggleLyrics(), colour.faint);
    this.controls.add(this.lyricsButton);

    deck.add(this.controls);
    this.panel.add(deck);
  }

  private progressCells(state = this.model.playback) {
    const width = this.progress.width || this.ctx.terminalWidth - 16;
    return Math.max(1, width - duration(state.time.currentTime).length - duration(state.time.duration).length - 2);
  }

  draw() {
    const state = this.model.playback;
    const connected = this.model.connected;
    const song = state.nowPlaying;
    this.title.content = song ? song.name ?? "Untitled" : "Nothing playing";
    const target = this.model.target ?? this.model.preferences.remote;
    this.devicesButton.set(icon.devices, target ? `d  ${target}` : "d", target ? colour.accent : colour.faint);
    // The device that plays may be out of reach, for example asleep or on another network. Saying so
    // explains why this computer shows nothing.
    const away = !song && !target ? this.model.devices.find(device => device.output && !device.self && device.paired && !device.online) : undefined;
    this.subtitle.content = away ? `${away.name} plays the music, but this Peel cannot reach it. Press d to see your devices.`
      : song ? [song.artistName, song.albumName].filter(Boolean).join("  /  ") : this.model.starting ? "Starting the player..." : "Choose a song to start";
    this.cover.setArt(song?.artwork?.url);
    const favourite = this.model.favourite;
    this.favouriteButton.visible = !!song;
    this.favouriteButton.set(favourite ? icon.heart : icon.heartOutline, "f", favourite ? colour.heart : colour.faint);
    const playing = connected && state.state === "playing";
    const label = !connected ? (this.model.starting ? "Starting" : "Stopped") : playing ? "Playing" : state.state === "paused" ? "Paused" : "Stopped";
    this.indicator.content = label;
    this.playButton.set(playing ? icon.pause : icon.play);
    this.shuffleButton.set(state.shuffleMode ? icon.shuffle : icon.shuffleOff, "s", state.shuffleMode ? colour.accent : colour.faint);
    this.repeatButton.set(state.repeatMode === "one" ? icon.repeatOne : state.repeatMode === "all" ? icon.repeat : icon.repeatOff, "r", state.repeatMode === "none" ? colour.faint : colour.accent);
    this.volumeText.content = `${Math.round(state.volume * 100)}%`;
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
