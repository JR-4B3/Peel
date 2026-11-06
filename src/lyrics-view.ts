import { BoxRenderable, TextRenderable, StyledText, fg, bold, type CliRenderer, type MouseEvent } from "@opentui/core";
import { lineAt, nextChange, LyricsSource, type Lyrics, type LyricsSong } from "./lyrics";
import { colour } from "./theme";
import type { Playback } from "./types";

export interface Clock { now(): number; set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
const realClock: Clock = { now: () => performance.now(), set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

function songOf(playback: Playback): LyricsSong | undefined {
  const song = playback.nowPlaying;
  if (!song?.name || !song.artistName) return undefined;
  return { catalogId: song.playParams?.catalogId ?? song.playParams?.id, name: song.name, artist: song.artistName, album: song.albumName ?? "", duration: playback.time.duration };
}

interface Rows { width: number; text: string[]; line: number[]; first: number[] }

// Word-wraps every lyric line to the pane's width once, with a blank row where the song pauses.
function wrap(lyrics: Lyrics, width: number): Rows {
  const rows: Rows = { width, text: [], line: [], first: [] };
  const push = (text: string, line: number) => { rows.text.push(text); rows.line.push(line); };
  lyrics.lines.forEach((lyric, index) => {
    rows.first[index] = rows.text.length;
    let row = "";
    for (const word of lyric.text.split(" ")) {
      const candidate = row ? `${row} ${word}` : word;
      if (Bun.stringWidth(candidate) <= width) { row = candidate; continue; }
      if (row) push(row, index);
      row = "";
      // A word wider than the pane is split by characters.
      for (const char of word) {
        if (Bun.stringWidth(row + char) > width) { push(row, index); row = ""; }
        row += char;
      }
    }
    if (row) push(row, index);
    const next = lyrics.lines[index + 1];
    if (lyrics.synced && next && next.start - lyric.end >= 4) push("", -1);
  });
  return rows;
}

// The lyrics pane. While it is hidden it does nothing: no requests, no timers. While it is shown it
// redraws only when the sung line changes, using one timer for the next change, and corrects its
// clock from each playback snapshot (once a second, and after seeks and pauses).
//
// Clicking a timed line plays from it. With the pane focused, the arrows and j/k move a highlight
// through the lines and Enter plays from it; h/l and Left/Right play from the previous or next line.
export class LyricsView {
  readonly panel: BoxRenderable;
  // Asked to play from a time, in seconds, when a line is clicked or chosen.
  onSeek?: (seconds: number) => void;
  // One text row per line of the pane, so blank lines and the sung line's place are exact.
  private lines: TextRenderable[] = [];
  // The lyric line under each painted row, or -1 for a blank row or a message.
  private rowLines: number[] = [];
  // The line the keys or the wheel moved to. Undefined while the view follows the song.
  private browse?: number;
  private shown = false;
  private song?: LyricsSong;
  private key = "";
  private lyrics?: Lyrics | null;
  private loading = false;
  private failedAt = -Infinity;
  private request = 0;
  private anchor = { position: 0, at: 0, playing: false, duration: 0 };
  private timer?: unknown;
  private rows?: Rows;
  private drawn = "";

  constructor(private renderer: CliRenderer, private source: LyricsSource, private clock: Clock = realClock) {
    this.panel = new BoxRenderable(renderer, { id: "lyrics-panel", border: true, borderStyle: "rounded", borderColor: colour.faint, title: "Lyrics",
      titleColor: colour.muted, paddingX: 1, flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden", visible: false, focusable: true,
      onMouseScroll: (event: MouseEvent) => { event.stopPropagation(); this.panel.focus(); this.move(event.scroll?.direction === "up" ? -1 : 1); } } as any);
    // Layout runs inside a render pass, so the redraw for a new size waits for the next tick.
    this.panel.onSizeChange = () => process.nextTick(() => { this.rows = undefined; this.drawn = ""; if (this.shown) this.draw(); });
  }

  // The pane's text area, inside its border and padding.
  private size() { return { width: Math.max(8, (this.panel.width || 34) - 4), height: Math.max(1, (this.panel.height || 12) - 2) }; }

  private paint(rows: (StyledText | string)[], height: number, rowLines: number[] = []) {
    while (this.lines.length < height) {
      const row = this.lines.length;
      const line = new TextRenderable(this.renderer, { content: "", height: 1, width: "100%", flexShrink: 0, wrapMode: "none", selectable: false,
        onMouseDown: (event: MouseEvent) => { if (event.button === 0) { event.stopPropagation(); this.click(row); } } });
      this.lines.push(line); this.panel.add(line);
    }
    while (this.lines.length > height) this.lines.pop()!.destroy();
    this.rowLines = rowLines;
    this.lines.forEach((line, index) => {
      line.content = rows[index] ?? "";
      line.bg = this.browse !== undefined && rowLines[index] === this.browse ? colour.selected : undefined;
    });
  }

  private click(row: number) {
    this.panel.focus();
    const line = this.rowLines[row] ?? -1;
    if (line < 0) return;
    if (!this.jump(line)) { this.browse = line; this.draw(); }
  }

  // Lines the keys can move through: none for messages and instrumentals.
  private browsable() {
    const lyrics = this.lyrics;
    return this.shown && lyrics && !lyrics.instrumental && lyrics.lines.length ? lyrics : undefined;
  }

  get browsing() { return this.browse !== undefined; }

  // Moves the highlight by `delta` lines, starting from the line being sung.
  move(delta: number) {
    const lyrics = this.browsable();
    if (!lyrics) return;
    const from = this.browse ?? this.follow(lyrics).focus;
    this.browse = Math.max(0, Math.min(lyrics.lines.length - 1, from + delta));
    this.draw();
  }

  // Lets the view follow the song again.
  release() {
    if (this.browse === undefined) return;
    this.browse = undefined;
    if (this.shown) this.draw();
  }

  // Plays from a line of timed lyrics, the highlighted one by default. False when there is none.
  jump(line = this.browse): boolean {
    const lyrics = this.browsable();
    if (!lyrics?.synced || line === undefined || !this.onSeek) return false;
    const start = lyrics.lines[line]?.start;
    if (start === undefined || !Number.isFinite(start)) return false;
    this.browse = undefined;
    // The pane moves at once; the next playback snapshot corrects the time.
    this.anchor = { ...this.anchor, position: start, at: this.clock.now() };
    this.onSeek(start);
    this.draw();
    return true;
  }

  // Plays from the line after (1) or before (-1) the one being sung.
  step(direction: 1 | -1): boolean {
    const lyrics = this.browsable();
    if (!lyrics?.synced) return false;
    const { current, focus } = this.follow(lyrics);
    // Between lines the next line counts as the one after.
    const target = current >= 0 ? current + direction : direction > 0 ? focus : focus - 1;
    return this.jump(Math.max(0, Math.min(lyrics.lines.length - 1, target)));
  }

  // The line being sung (-1 between lines) and the line the view centres on.
  private follow(lyrics: Lyrics) {
    const time = this.position(), lines = lyrics.lines;
    if (!lyrics.synced) {
      // Untimed lyrics scroll with the song's progress.
      const progress = this.anchor.duration > 0 ? time / this.anchor.duration : 0;
      return { time, current: -1, focus: Math.min(lines.length - 1, Math.floor(progress * lines.length)) };
    }
    const current = lineAt(lines, time);
    // Between lines the view waits on the next one.
    let focus = current >= 0 ? current : lines.findIndex(line => line.start > time);
    if (focus < 0) focus = lines.length - 1;
    return { time, current, focus };
  }

  get isShown() { return this.shown; }

  show(shown: boolean) {
    if (shown === this.shown) return;
    this.shown = shown;
    this.panel.visible = shown;
    if (!shown) { this.stop(); return; }
    this.load(); this.draw();
  }

  // Takes each playback snapshot. A new song resets the pane; the time corrects its clock.
  sync(playback: Playback) {
    const song = songOf(playback);
    const key = song ? LyricsSource.key(song) : "";
    this.anchor = { position: playback.time.currentTime, at: this.clock.now(), playing: playback.state === "playing", duration: playback.time.duration };
    if (key !== this.key) {
      this.key = key; this.song = song; this.lyrics = undefined; this.rows = undefined; this.drawn = ""; this.browse = undefined;
      this.loading = false; this.failedAt = -Infinity; this.request++;
    }
    if (song && this.song) this.song.duration = song.duration;
    if (!this.shown) return;
    this.load(); this.draw();
  }

  dispose() { this.stop(); this.shown = false; this.lines = []; }

  private stop() { if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined; } }

  private position() {
    const { position, at, playing, duration } = this.anchor;
    const now = playing ? position + (this.clock.now() - at) / 1000 : position;
    return duration > 0 ? Math.min(now, duration) : now;
  }

  private load() {
    const song = this.song;
    if (!song || this.lyrics !== undefined || this.loading) return;
    const cached = this.source.peek(song);
    if (cached !== undefined) { this.lyrics = cached; return; }
    // After a network failure, wait a minute before asking again.
    if (this.clock.now() - this.failedAt < 60000) return;
    const request = ++this.request;
    this.loading = true;
    this.source.get(song).then(lyrics => {
      if (request !== this.request) return;
      this.loading = false; this.lyrics = lyrics; this.rows = undefined;
      if (this.shown) this.draw();
    }, () => {
      if (request !== this.request) return;
      this.loading = false; this.failedAt = this.clock.now();
      if (this.shown) this.draw();
    });
  }

  private message(text: string) {
    const { height } = this.size();
    const key = `message:${text}:${height}`;
    if (key !== this.drawn) { this.drawn = key; this.paint([new StyledText([fg(colour.faint)(text)])], height, []); }
  }

  private draw() {
    this.stop();
    const lyrics = this.lyrics;
    this.panel.title = lyrics?.source === "LRCLIB" ? `Lyrics  ${lyrics.synced ? "" : "not synced  "}from LRCLIB` : lyrics && !lyrics.synced ? "Lyrics  not synced" : "Lyrics";
    if (!this.song) return this.message("Lyrics appear here when a song plays.");
    if (lyrics === undefined) return this.message(this.loading ? "Looking for lyrics..." : "Lyrics are unavailable right now. Peel tries again in a minute.");
    if (lyrics === null) return this.message("No lyrics for this song.");
    if (lyrics.instrumental) return this.message("Instrumental");

    const { width, height } = this.size();
    if (!this.rows || this.rows.width !== width) this.rows = wrap(lyrics, width);
    const rows = this.rows, lines = lyrics.lines;
    const { time, current, focus: sung } = this.follow(lyrics);
    // The highlighted line, while browsing, takes the sung line's place in the view.
    const focus = this.browse ?? sung;
    // The focused line sits a third of the way down, so the next lines are visible. Timed lyrics
    // start there too, with blank rows above the first line.
    const third = (rows.first[focus] ?? 0) - Math.floor(height / 3);
    const top = lyrics.synced ? Math.min(third, Math.max(0, rows.text.length - height)) : Math.max(0, Math.min(third, rows.text.length - height));
    const key = `${width}x${height}:${top}:${current}:${this.browse ?? ""}`;
    if (key !== this.drawn) {
      this.drawn = key;
      const shown: (StyledText | string)[] = [], under: number[] = [];
      for (let row = top; row < top + height; row++) {
        const text = rows.text[row];
        under.push(text ? rows.line[row]! : -1);
        if (!text) { shown.push(""); continue; }
        const line = rows.line[row]!;
        shown.push(new StyledText([!lyrics.synced ? fg(line === this.browse ? colour.text : colour.muted)(text) : line === current ? bold(fg(colour.accent)(text))
          : fg(line === this.browse ? colour.text : line < sung ? colour.faint : colour.muted)(text)]));
      }
      this.paint(shown, height, under);
    }
    if (!this.anchor.playing) return;
    // One timer, for the moment the highlighted line changes.
    const next = lyrics.synced ? nextChange(lines, time) : (sung + 1) / lines.length * this.anchor.duration;
    if (Number.isFinite(next) && next > time) this.timer = this.clock.set(() => { this.timer = undefined; this.draw(); }, Math.max(20, (next - time) * 1000 + 15));
  }
}
