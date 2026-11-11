import { BoxRenderable, TextRenderable, t, fg, bold, type CliRenderer, type MouseEvent } from "@opentui/core";
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
  private about: BoxRenderable;
  private sound: BoxRenderable;
  private controls: BoxRenderable;
  private right: BoxRenderable;
  private narrow = false;
  private progress: TextRenderable;
  private playButton: Button;
  private favouriteButton: Button;
  private shuffleButton: Button;
  private repeatButton: Button;
  private volumeText: TextRenderable;

  // A line above the player sets it apart, without a box around it. Beside the cover: the song and
  // the stream's quality, the artist and the volume, the playback buttons centred on a row of their
  // own, and the time.
  constructor(private ctx: CliRenderer, private model: Model, button: MakeButton, ui: PlayerActions) {
    const control = (id: string, glyph: string, action: () => void, tint?: string) => {
      const made = button(id, glyph, "", action, tint);
      made.flexShrink = 0; this.buttons.push(made);
      return made;
    };
    // The mouse wheel anywhere over the player changes the volume in 5% steps. Lists scroll as before.
    this.panel = new BoxRenderable(ctx, { id: "player-panel", border: ["top"], borderStyle: "single", borderColor: colour.line, paddingX: 1, height: 5, flexShrink: 0, flexDirection: "row", gap: 2,
      onMouseScroll: event => {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        event.stopPropagation();
        void model.volume(direction === "up" ? 0.05 : -0.05);
      } });
    // The whole cover shows. Its width follows the terminal's cell shape, so it is about square.
    this.cover = new Cover(ctx, { id: "player-cover", width: 8, height: 4, glyph: "\u{F075A}", fit: "fit" });
    this.cover.onMouseDown = event => { const song = model.playback.nowPlaying; if (event.button === 0 && song) { event.stopPropagation(); ui.showCover(song.artwork?.url, song.albumName ?? song.name ?? "", song.artistName ?? ""); } };
    this.panel.add(this.cover);
    const deck = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0 });
    const row = () => new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2, flexShrink: 0 });

    const top = row();
    const song = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2, flexGrow: 1, minWidth: 0 });
    this.title = new TextRenderable(ctx, { id: "now-playing", fg: colour.text, flexShrink: 1, minWidth: 0, height: 1, truncate: true, selectable: false });
    this.favouriteButton = control("favourite", icon.heartOutline, () => void model.toggleFavourite(), colour.faint);
    this.indicator = new TextRenderable(ctx, { id: "playback-indicator", fg: colour.faint, height: 1, flexShrink: 0, selectable: false });
    song.add(this.title); song.add(this.favouriteButton); song.add(this.indicator);
    this.quality = new TextRenderable(ctx, { id: "quality", height: 1, flexShrink: 0, selectable: false });
    top.add(song); top.add(this.quality);
    deck.add(top);

    const about = this.about = row();
    this.subtitle = new TextRenderable(ctx, { id: "now-playing-artist", fg: colour.muted, height: 1, flexGrow: 1, minWidth: 0, truncate: true, selectable: false,
      onMouseDown: event => { const song = model.playing; if (event.button === 0 && song) { event.stopPropagation(); void model.openArtist(song); ui.focusContent(); } } });
    const sound = this.sound = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 1, flexShrink: 0 });
    this.lyricsButton = control("lyrics-toggle", icon.lyrics, () => ui.toggleLyrics(), colour.faint);
    this.lyricsButton.marginRight = 2;
    this.volumeText = new TextRenderable(ctx, { id: "volume", content: "50%", fg: colour.muted, height: 1, flexShrink: 0, selectable: false });
    for (const item of [this.lyricsButton, control("volume-down", icon.volumeDown, () => void model.volume(-0.05), colour.muted), this.volumeText, control("volume-up", icon.volumeUp, () => void model.volume(0.05), colour.muted)]) sound.add(item);
    about.add(this.subtitle); about.add(sound);
    deck.add(about);

    // The two sides share what is left equally, so the buttons stay in the middle. Narrow windows
    // move the volume to the right side here, since they have no artist row.
    const middle = row();
    const side = { flexDirection: "row" as const, height: 1, flexGrow: 1, flexBasis: 0, minWidth: 0 };
    this.right = new BoxRenderable(ctx, { ...side, justifyContent: "flex-end" });
    const controls = this.controls = new BoxRenderable(ctx, { id: "controls", height: 1, flexDirection: "row", gap: 4, flexShrink: 0 });
    this.shuffleButton = control("shuffle", icon.shuffleOff, () => void model.act("/playback/shuffle/toggle"), colour.faint);
    this.playButton = control("play-pause", icon.play, () => void model.act("/playback/toggle"));
    this.repeatButton = control("repeat", icon.repeatOff, () => void model.act("/playback/repeat/toggle"), colour.faint);
    for (const item of [this.shuffleButton, control("previous", icon.previous, () => void model.skip(-1)), this.playButton, control("next", icon.next, () => void model.skip(1)), this.repeatButton]) controls.add(item);
    middle.add(new BoxRenderable(ctx, side)); middle.add(controls); middle.add(this.right);
    deck.add(middle);
    this.progress = new TextRenderable(ctx, { id: "seek", content: "", fg: colour.accent, height: 1, width: "100%", selectable: false, onMouseDown: event => this.seekClick(event) });
    deck.add(this.progress);
    this.panel.add(deck);
  }

  // Narrow windows drop the artist row: the artist joins the title, and the volume moves beside the
  // buttons.
  layout(width: number, height: number) {
    const narrow = width < 76;
    if (narrow !== this.narrow) {
      (narrow ? this.about : this.right).remove(this.sound);
      (narrow ? this.right : this.about).add(this.sound);
    }
    this.narrow = narrow;
    this.about.visible = !narrow;
    this.lyricsButton.visible = !narrow;
    this.controls.gap = narrow ? 2 : 4;
    const rows = narrow ? 3 : 4;
    this.panel.height = rows + 1;
    // A cell is about twice as tall as wide. The terminal's pixel size, when it reports one, says
    // exactly how much, so the cover box is as close to square as whole cells allow.
    const resolution = this.ctx.resolution;
    const shape = resolution && width && height ? (resolution.height / height) / (resolution.width / width) : 2;
    this.cover.setSize(Math.max(2, Math.round(rows * shape)), rows);
    this.cover.visible = width >= 44;
  }

  private progressCells(state = this.model.playback) {
    const width = this.progress.width || this.ctx.terminalWidth - 16;
    return Math.max(1, width - duration(state.time.currentTime).length - duration(state.time.duration).length - 2);
  }

  // What the player streams: Apple's lossless ALAC through the hi-res player, at the song's own
  // rate, or AAC at the quality chosen in Settings. Apple calls rates above 48 kHz Hi-Res Lossless.
  private qualityLabel() {
    const rate = this.model.playback.sampleRate;
    if (this.model.player.lossless) {
      const khz = rate ? `${Number((rate / 1000).toFixed(1))} kHz` : "";
      return [rate && rate > 48000 ? "Hi-Res Lossless" : "Lossless", khz].filter(Boolean).join(" · ");
    }
    return this.model.preferences.quality === "standard" ? "AAC · 64 kbps" : "AAC · 256 kbps";
  }

  draw() {
    const state = this.model.playback;
    const connected = this.model.connected;
    const song = state.nowPlaying;
    const name = song ? song.name ?? "Untitled" : "Nothing playing";
    this.title.content = this.narrow && song?.artistName ? t`${bold(fg(colour.text)(name))}  ${fg(colour.muted)(song.artistName)}` : t`${bold(fg(colour.text)(name))}`;
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
