import { BoxRenderable, TextRenderable, InputRenderable, type CliRenderer, type KeyEvent, type MouseEvent } from "@opentui/core";
import { Model } from "./model";
import { duration } from "./types";

const colour = { background: "#101419", panel: "#161d25", text: "#e5e9ef", muted: "#93a1b2", accent: "#a8dab5", border: "#354453", selected: "#294437" };
interface Row { id: string; name: string; description?: string; activate: () => void }

class ClickList extends BoxRenderable {
  rows: Row[] = [];
  index = 0;
  offset = 0;
  private rowHeight: number;
  onSelection?: (row: Row) => void;

  constructor(renderer: CliRenderer, id: string, rowHeight = 2) {
    super(renderer, { id, flexGrow: 1, minHeight: 0, width: "100%", overflow: "hidden", focusable: true,
      onMouseScroll: event => { event.stopPropagation(); this.move(event.scroll?.direction === "up" ? -1 : 1); },
    });
    this.rowHeight = rowHeight;
  }

  setRows(rows: Row[]) {
    const id = this.rows[this.index]?.id;
    this.rows = rows;
    this.index = Math.max(0, id ? rows.findIndex(row => row.id === id) : 0);
    this.drawRows();
  }
  move(delta: number) { this.index = Math.min(Math.max(0, this.rows.length - 1), Math.max(0, this.index + delta)); this.drawRows(); this.onSelection?.(this.rows[this.index]); }
  activate() { this.rows[this.index]?.activate(); }
  selectedId() { return this.rows[this.index]?.id; }
  protected onResize() { if (this.rows) this.drawRows(); }
  drawRows() {
    if (!this.rows || !this.rowHeight) return;
    const visible = Math.max(1, Math.floor(this.height / this.rowHeight));
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + visible) this.offset = this.index - visible + 1;
    this.offset = Math.min(this.offset, Math.max(0, this.rows.length - visible));
    for (const child of this.getChildren()) { this.remove(child); child.destroyRecursively(); }
    this.rows.slice(this.offset, this.offset + visible).forEach((row, position) => {
      const index = this.offset + position;
      const box = new BoxRenderable(this.ctx, {
        id: `${this.id}:row:${row.id}`, position: "absolute", top: position * this.rowHeight, width: "100%", height: this.rowHeight,
        paddingX: 1, flexDirection: "column", backgroundColor: index === this.index ? colour.selected : colour.panel,
        onMouseDown: event => {
          if (event.button !== 0) return;
          event.stopPropagation(); this.focus(); this.index = index; this.drawRows(); row.activate();
        },
      });
      box.add(new TextRenderable(this.ctx, { content: row.name, fg: colour.text, width: "100%", height: 1, truncate: true, selectable: false }));
      if (this.rowHeight > 1) box.add(new TextRenderable(this.ctx, { content: row.description ?? "", fg: colour.muted, width: "100%", height: 1, truncate: true, selectable: false }));
      this.add(box);
    });
  }
}

export class PeelUI {
  readonly root: BoxRenderable;
  readonly search: InputRenderable;
  readonly sidebar: ClickList;
  readonly tracks: ClickList;
  private body: BoxRenderable;
  private sidebarPanel: BoxRenderable;
  private trackPanel: BoxRenderable;
  private controls: BoxRenderable;
  private secondary: BoxRenderable;
  private playerPanel: BoxRenderable;
  private layoutControls: BoxRenderable;
  private title: TextRenderable;
  private indicator: TextRenderable;
  private progress: TextRenderable;
  private status: TextRenderable;
  private empty: TextRenderable;
  private playButton: TextRenderable;
  private shuffleButton: TextRenderable;
  private repeatButton: TextRenderable;
  private volumeText: TextRenderable;
  private counter: TextRenderable;
  private tick = 0;
  private interval?: ReturnType<typeof setInterval>;
  private lastRows = "";
  private lastSidebar = "";
  private disposed = false;
  private focusChange = () => {
    this.sidebarPanel.borderColor = this.sidebar.focused ? colour.accent : colour.border;
    this.trackPanel.borderColor = this.tracks.focused ? colour.accent : colour.border;
    const searchPanel = this.renderer.root.findDescendantById("search-panel") as BoxRenderable;
    if (searchPanel) searchPanel.borderColor = this.search.focused ? colour.accent : colour.border;
  };
  private change = () => this.update();
  private resize = () => this.resizeLayout();
  private key = (event: KeyEvent) => this.handleKey(event);

  constructor(readonly renderer: CliRenderer, readonly model: Model, private quit = () => renderer.destroy()) {
    const ctx = renderer;
    this.root = new BoxRenderable(ctx, { id: "peel", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colour.background, paddingX: 1 });
    renderer.root.add(this.root);
    const heading = new BoxRenderable(ctx, { height: 1, flexDirection: "row", justifyContent: "space-between" });
    heading.add(new TextRenderable(ctx, { content: "PEEL  /  Apple Music", fg: colour.accent, height: 1 }));
    heading.add(this.button("layout", "Layout [l]", () => this.toggleLayout()));
    this.root.add(heading);
    const searchBox = new BoxRenderable(ctx, { id: "search-panel", border: true, title: "Search songs and albums  /  Ctrl+F", borderColor: colour.border, height: 3, paddingX: 1 });
    this.search = new InputRenderable(ctx, { id: "search", width: "100%", placeholder: "Type a song, album, or artist and press Enter", textColor: colour.text, backgroundColor: colour.background, focusedBackgroundColor: colour.panel });
    this.search.on("enter", () => { void this.model.search(this.search.value); this.tracks.focus(); });
    searchBox.add(this.search); this.root.add(searchBox);

    this.body = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1, minHeight: 0, gap: 1 });
    this.sidebarPanel = new BoxRenderable(ctx, { id: "sidebar-panel", title: "Your music", border: true, borderColor: colour.border, backgroundColor: colour.panel, width: 27, flexShrink: 0 });
    this.sidebar = new ClickList(renderer, "sidebar", 1);
    this.sidebarPanel.add(this.sidebar); this.body.add(this.sidebarPanel);
    this.trackPanel = new BoxRenderable(ctx, { id: "tracks-panel", title: "Favourite Songs", border: true, borderColor: colour.border, backgroundColor: colour.panel, flexGrow: 1, minWidth: 0, minHeight: 0 });
    this.empty = new TextRenderable(ctx, { id: "empty", content: "Connecting...", fg: colour.muted, height: 2, paddingX: 1 });
    this.trackPanel.add(this.empty);
    this.tracks = new ClickList(renderer, "tracks");
    this.trackPanel.add(this.tracks);
    this.layoutControls = new BoxRenderable(ctx, { height: 2, flexDirection: "row", gap: 2, paddingX: 1 });
    this.layoutControls.add(this.button("move-up", "Up [K]", () => this.reorder(-1)));
    this.layoutControls.add(this.button("move-down", "Down [J]", () => this.reorder(1)));
    this.layoutControls.add(this.button("hide", "Hide/show [h]", () => this.hideSelected()));
    this.trackPanel.add(this.layoutControls);
    this.counter = this.button("more", "", () => { if (model.more) void model.load(true); });
    this.trackPanel.add(this.counter); this.body.add(this.trackPanel); this.root.add(this.body);

    this.playerPanel = new BoxRenderable(ctx, { id: "player-panel", title: "Player", border: true, borderColor: colour.border, paddingX: 1, height: 8, flexShrink: 0 });
    const nowPlaying = new BoxRenderable(ctx, { flexDirection: "row", height: 1 });
    this.title = new TextRenderable(ctx, { id: "now-playing", fg: colour.text, flexGrow: 1, minWidth: 0, height: 1, truncate: true, selectable: false });
    this.indicator = new TextRenderable(ctx, { id: "playback-indicator", fg: colour.accent, width: 16, height: 1, selectable: false });
    nowPlaying.add(this.title); nowPlaying.add(this.indicator); this.playerPanel.add(nowPlaying);
    this.progress = new TextRenderable(ctx, { id: "seek", content: "", fg: colour.accent, height: 1, width: "100%", selectable: false, onMouseDown: event => this.seekClick(event) });
    this.playerPanel.add(this.progress);
    this.controls = new BoxRenderable(ctx, { height: 2, flexDirection: "row", gap: 3, alignItems: "center" });
    this.controls.add(this.button("previous", "Previous [p]", () => void model.skip(-1)));
    this.playButton = this.button("play-pause", "Play [Space]", () => void model.act("/playback/toggle"));
    this.controls.add(this.playButton);
    this.controls.add(this.button("next", "Next [n]", () => void model.skip(1)));
    this.playerPanel.add(this.controls);
    this.secondary = new BoxRenderable(ctx, { height: 2, flexDirection: "row", rowGap: 0, columnGap: 2, flexWrap: "wrap" });
    this.shuffleButton = this.button("shuffle", "Shuffle off [s]", () => void model.act("/playback/shuffle/toggle"));
    this.repeatButton = this.button("repeat", "Repeat none [r]", () => void model.act("/playback/repeat/toggle"));
    this.secondary.add(this.shuffleButton); this.secondary.add(this.repeatButton);
    this.secondary.add(this.button("volume-down", "Vol -", () => void model.volume(-0.05)));
    this.volumeText = new TextRenderable(ctx, { id: "volume", content: "50%", fg: colour.muted, height: 1 });
    this.secondary.add(this.volumeText);
    this.secondary.add(this.button("volume-up", "Vol +", () => void model.volume(0.05)));
    this.secondary.add(this.button("bars", "Bars [v]", () => void model.bars()));
    this.playerPanel.add(this.secondary); this.root.add(this.playerPanel);
    this.status = new TextRenderable(ctx, { id: "status", content: model.status, fg: colour.muted, height: 1, width: "100%", truncate: true });
    this.root.add(this.status);
    this.root.add(new TextRenderable(ctx, { content: "Tab focus  Enter play  ←/→ seek  +/- volume  ? help  q quit", fg: colour.muted, height: 1, truncate: true }));
    model.on("change", this.change); renderer.on("resize", this.resize); renderer.on("focused_renderable", this.focusChange); renderer.keyInput.on("keypress", this.key);
    this.resizeLayout(); this.update(); this.tracks.focus();
  }

  private button(id: string, label: string, action: () => void): TextRenderable {
    return new TextRenderable(this.renderer, {
      id, content: label, fg: colour.accent, height: 1, selectable: false,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); action(); } },
      onMouseOver: function () { this.fg = colour.text; }, onMouseOut: function () { this.fg = colour.accent; },
    });
  }

  private resizeLayout() {
    const narrow = this.renderer.terminalWidth < 76;
    this.body.flexDirection = narrow ? "column" : "row";
    this.sidebarPanel.width = narrow ? "100%" : 27;
    this.sidebarPanel.height = narrow ? this.renderer.terminalHeight < 28 ? 3 : 5 : "100%";
    this.playerPanel.height = 8;
    this.secondary.height = 2;
    this.drawPlayback();
  }

  private update() {
    if (this.disposed) return;
    const model = this.model;
    this.status.content = model.status;
    this.trackPanel.title = model.layout ? "Layout  /  choose a row, then move or hide it" : model.title;
    this.layoutControls.visible = model.layout;
    this.empty.visible = !model.layout && !model.items.length;
    this.empty.content = model.loading ? "Loading..." : model.connected ? "No items in this view. Search above or choose your music." : model.status;
    const nav = model.navigation();
    const sidebarKey = JSON.stringify(nav.map(item => [item.id, item.name]));
    if (sidebarKey !== this.lastSidebar) {
      this.lastSidebar = sidebarKey;
      this.sidebar.setRows(nav.map(item => ({ ...item, activate: () => { void model.open(item.id); this.tracks.focus(); } })));
    }
    const rowsKey = JSON.stringify([model.layout, model.layout ? model.navigation(true).map(item => [item.id, item.name, item.hidden]) : model.items]);
    if (rowsKey !== this.lastRows) {
      this.lastRows = rowsKey;
      if (model.layout) this.tracks.setRows(model.navigation(true).map(item => ({
        id: item.id, name: `${item.hidden ? "[hidden]" : "[shown]"} ${item.name}`,
        description: "Up / Down to reorder. Hide/show to change visibility.", activate: () => {},
      })));
      else this.tracks.setRows(model.items.map((item, index) => ({
        id: String(index), name: `${String(index + 1).padStart(2, " ")}  ${item.name}${item.type.includes("albums") ? "  [album]" : ""}`,
        description: [item.artist, item.album, item.duration ? duration(item.duration) : ""].filter(Boolean).join("  /  "),
        activate: () => void model.activate(item),
      })));
    }
    this.counter.content = model.layout ? "Layout changes save automatically. Escape closes." : `${model.items.length} items${model.more ? "   Load more [m]" : ""}`;
    this.drawPlayback();
  }

  drawPlayback() {
    const state = this.model.playback;
    const connected = this.model.connected;
    this.title.content = state.nowPlaying ? `${state.nowPlaying.name ?? "Untitled"}  /  ${state.nowPlaying.artistName ?? ""}` : "Nothing playing";
    const frames = ["▁▅▃▇▂▆", "▃▇▁▅▆▂", "▆▃▅▂▇▁", "▂▆▇▁▃▅"];
    const playing = connected && state.state === "playing";
    this.indicator.content = !connected ? "Disconnected" : `${playing ? "Playing" : state.state === "paused" ? "Paused" : "Stopped"}${this.model.preferences.playbackBars ? " " + (playing ? frames[this.tick % frames.length] : "▁▁▁▁▁▁") : ""}`;
    this.playButton.content = playing ? "Pause [Space]" : "Play [Space]";
    this.shuffleButton.content = `Shuffle ${state.shuffleMode ? "on" : "off"} [s]`;
    this.repeatButton.content = `Repeat ${state.repeatMode} [r]`;
    this.volumeText.content = `${Math.round(state.volume * 100)}%`;
    const cells = Math.max(1, this.renderer.terminalWidth - 20);
    const ratio = state.time.duration > 0 ? Math.min(1, Math.max(0, state.time.currentTime / state.time.duration)) : 0;
    const filled = Math.floor(ratio * cells);
    this.progress.content = `${duration(state.time.currentTime)} ${"━".repeat(filled)}${"─".repeat(cells - filled)} ${duration(state.time.duration)}`;
  }

  animate() {
    if (this.model.connected && this.model.playback.state === "playing" && this.model.preferences.playbackBars) this.tick++;
    this.drawPlayback();
  }
  startAnimation() { this.interval = setInterval(() => this.animate(), 250); }

  private seekClick(event: MouseEvent) {
    const maximum = this.model.playback.time.duration;
    if (event.button !== 0 || !(maximum > 0)) return;
    const start = duration(this.model.playback.time.currentTime).length + 1;
    const cells = Math.max(1, this.renderer.terminalWidth - 20);
    const ratio = Math.max(0, Math.min(1, (event.x - this.progress.x - start) / Math.max(1, cells - 1)));
    void this.model.act("/playback/seek", { position: maximum * ratio });
  }
  private toggleLayout() { this.model.layout = !this.model.layout; this.update(); this.tracks.focus(); }
  private reorder(direction: number) { const id = this.tracks.selectedId(); if (id && this.model.layout) void this.model.reorder(id, direction); }
  private hideSelected() { const id = this.tracks.selectedId(); if (id && this.model.layout) void this.model.hide(id); }

  private handleKey(key: KeyEvent) {
    if (key.eventType === "release") return;
    const model = this.model;
    let action: (() => void) | undefined;
    if (key.ctrl && key.name === "c") action = this.quit;
    else if (key.ctrl && key.name === "f") action = () => this.search.focus();
    else if (key.ctrl && key.name === "p") action = () => void model.act("/playback/toggle");
    else if (key.name === "tab") action = () => {
      const targets = [this.search, this.sidebar, this.tracks];
      const index = targets.findIndex(target => target.focused);
      targets[(index + (key.shift ? targets.length - 1 : 1)) % targets.length].focus();
    };
    else if (key.name === "escape") action = () => { model.layout = false; this.update(); this.tracks.focus(); };
    else if (this.search.focused) return;
    else if (key.name === "/") action = () => this.search.focus();
    else if (key.name === "q") action = this.quit;
    else if (key.name === "l") action = () => this.toggleLayout();
    else if (key.name === "?" || key.sequence === "?") action = () => { model.status = "Space play/pause; p/n skip; arrows seek 10s; +/- volume; s shuffle; r repeat; / search; l layout; m more; v bars; Tab focus; q quit"; model.changed(); };
    else if (model.layout && (key.name === "j" || key.name === "k") && key.shift) action = () => this.reorder(key.name === "j" ? 1 : -1);
    else if (model.layout && key.name === "h") action = () => this.hideSelected();
    else if (["up", "down", "j", "k"].includes(key.name)) action = () => (this.sidebar.focused ? this.sidebar : this.tracks).move(["up", "k"].includes(key.name) ? -1 : 1);
    else if (key.name === "return") action = () => (this.sidebar.focused ? this.sidebar : this.tracks).activate();
    else if (key.name === "space") action = () => void model.act("/playback/toggle");
    else if (key.name === "n") action = () => void model.skip(1);
    else if (key.name === "p") action = () => void model.skip(-1);
    else if (key.name === "left" || key.name === "right") action = () => void model.seek(key.name === "left" ? -10 : 10);
    else if (key.sequence === "+" || key.sequence === "=" || key.sequence === "-") action = () => void model.volume(key.sequence === "-" ? -0.05 : 0.05);
    else if (key.name === "s") action = () => void model.act("/playback/shuffle/toggle");
    else if (key.name === "r") action = () => void model.act("/playback/repeat/toggle");
    else if (key.name === "v") action = () => void model.bars();
    else if (key.name === "m" && model.more) action = () => void model.load(true);
    if (action) { key.preventDefault(); key.stopPropagation(); action(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.interval);
    this.model.off("change", this.change); this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.focusChange); this.renderer.keyInput.off("keypress", this.key);
    this.root.destroyRecursively();
  }
}
