import { BoxRenderable, TextRenderable, InputRenderable, StyledText, t, fg, bold, type CliRenderer, type KeyEvent } from "@opentui/core";
import { Model, playlistEntry, sorts, type Sort } from "../model";
import type { Media } from "../types";
import { colour, icon } from "../theme";
import { LyricsSource } from "../lyrics";
import { LyricsView } from "../lyrics-view";
import { ClickList } from "./click-list";
import { CoverGrid } from "./cover-grid";
import { CoverView } from "./cover-view";
import { DevicesPopup, PairingPrompt } from "./devices";
import { PlayerPanel } from "./player";
import { TopBar } from "./top-bar";
import { settingsRows, type SettingsContext } from "./settings";
import { shelves as shelvesFor, songRows } from "./shelves";
import { Button, Cover, Panel, glyph, plural, type Column } from "./widgets";

export class PeelUI {
  readonly root: BoxRenderable;
  readonly search: InputRenderable;
  readonly sidebar: ClickList;
  readonly tracks: ClickList;
  readonly grid: CoverGrid;
  private body: BoxRenderable;
  private sidebarPanel: BoxRenderable;
  private tabs: BoxRenderable;
  private trackPanel: Panel;
  private header: BoxRenderable;
  private top: BoxRenderable;
  private songs: BoxRenderable;
  // Layout getters report the last computed size, so the sizes just set are kept here.
  private headerHeight = 10;
  private coverWidth = 16;
  private headerCover: Cover;
  private headerName: TextRenderable;
  private headerArtist: TextRenderable;
  private headerMeta: TextRenderable;
  private section: TextRenderable;
  private filterBar: BoxRenderable;
  readonly filterInput: InputRenderable;
  private sortButton: Button;
  private directionButton: Button;
  private lovedButton: Button;
  private sidebarHints: TextRenderable;
  private sidebarFooter: BoxRenderable;
  private editButton: Button;
  private editingSidebar = false;
  private status: TextRenderable;
  private empty: TextRenderable;
  private buttons: Button[] = [];
  private albumFavouriteButton: Button;
  private actions: BoxRenderable;
  private hints: TextRenderable;
  private lastRows = "";
  private lastView = "";
  private lastItems?: Media[];
  private lastSidebar = "";
  private lastShelves = "";
  private disposed = false;
  private lyrics: LyricsView;
  private player: PlayerPanel;
  private homeDevices: TextRenderable;
  private topBar: TopBar;
  // The devices popup above the player, the pairing prompt, and the large cover.
  private devices: DevicesPopup;
  private pairing: PairingPrompt;
  private coverView: CoverView;
  private settings: SettingsContext;
  // Whether the user wants lyrics. The enlarged cover hides them without changing this.
  private lyricsWanted = false;
  private focusChange = () => {
    // Editing ends when focus leaves the sidebar.
    if (this.editingSidebar && !this.sidebar.focused) this.editSidebar(false);
    this.update();
    this.sidebarPanel.borderColor = this.sidebar.focused ? colour.accent : colour.faint;
    this.trackPanel.borderColor = this.tracks.focused || this.grid.focused ? colour.accent : colour.faint;
    this.lyrics.panel.borderColor = this.lyrics.panel.focused ? colour.accent : colour.faint;
    // Leaving the lyrics drops the highlighted line, so they follow the song again.
    if (!this.lyrics.panel.focused) this.lyrics.release();
    this.topBar.focusChanged();
  };
  private change = () => this.update();
  private resize = () => this.resizeLayout();
  private key = (event: KeyEvent) => this.handleKey(event);

  constructor(readonly renderer: CliRenderer, readonly model: Model, private quit = () => renderer.destroy(), lyrics?: LyricsSource) {
    const ctx = renderer;
    this.settings = { model, openDevices: () => this.devices.toggle(true), forgetAsked: 0 };
    this.devices = new DevicesPopup(renderer, model, () => this.drawHints(), () => this.focusContent());
    this.pairing = new PairingPrompt(renderer, model, () => this.drawHints());
    this.coverView = new CoverView(renderer, open => { this.root.visible = !open; this.layoutLyrics(); });
    const panel = { border: true, borderStyle: "rounded" as const, borderColor: colour.faint };
    this.root = new BoxRenderable(ctx, { id: "peel", width: "100%", height: "100%", flexDirection: "column", paddingX: 1 });
    renderer.root.add(this.root);
    this.topBar = new TopBar(renderer, model, term => { void this.model.search(term); this.tracks.focus(); }, () => this.devices.toggle());
    this.search = this.topBar.search;
    this.root.add(this.topBar.bar);

    this.body = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1, minHeight: 0, gap: 1 });
    this.sidebarPanel = new BoxRenderable(ctx, { id: "sidebar-panel", ...panel, title: "Library", titleColor: colour.muted, width: 24, flexShrink: 0, paddingY: 0 } as any);
    this.sidebar = new ClickList(renderer, "sidebar", 1);
    this.sidebarPanel.add(this.sidebar);
    // Editing shows the hidden entries, so they can be shown again. Click Edit, or press e with the sidebar focused.
    this.sidebarFooter = new BoxRenderable(ctx, { id: "sidebar-footer", flexDirection: "column", paddingX: 1, flexShrink: 0 });
    this.sidebarHints = new TextRenderable(ctx, { id: "sidebar-hints", content: t`${fg(colour.muted)("⏎")} ${fg(colour.faint)("show or hide")}  ${fg(colour.muted)("⇧↑↓")} ${fg(colour.faint)("move")}`, height: 1, visible: false, selectable: false });
    this.editButton = this.button("sidebar-edit", icon.edit, "Edit  e", () => this.editSidebar(!this.editingSidebar), colour.faint);
    this.sidebarFooter.add(this.sidebarHints); this.sidebarFooter.add(this.editButton);
    this.sidebarPanel.add(this.sidebarFooter); this.body.add(this.sidebarPanel);
    // Narrow windows move the sidebar's list into one row of tabs above the content, without a box.
    this.tabs = new BoxRenderable(ctx, { id: "tabs", height: 1, width: "100%", flexShrink: 0, visible: false });
    this.body.add(this.tabs, 0);
    this.trackPanel = new Panel(ctx, { id: "tracks-panel", ...panel, title: "Home", flexGrow: 1, minWidth: 0, minHeight: 0 });

    this.header = new BoxRenderable(ctx, { id: "collection-header", flexDirection: "row", gap: 2, paddingX: 1, paddingY: 1, height: 10, flexShrink: 0 });
    this.headerCover = new Cover(ctx, { id: "collection-cover", width: 16, height: 8 });
    const info = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0, justifyContent: "flex-end" });
    this.headerName = new TextRenderable(ctx, { fg: colour.text, attributes: 1, height: 1, truncate: true, selectable: false });
    this.headerArtist = new TextRenderable(ctx, { id: "collection-artist", fg: colour.accent, height: 1, truncate: true, selectable: false,
      onMouseDown: event => { const detail = model.detail; if (event.button === 0 && detail?.type.includes("albums")) { event.stopPropagation(); void model.openArtist(detail); } } });
    this.headerMeta = new TextRenderable(ctx, { fg: colour.muted, height: 2, truncate: true, selectable: false });
    // In a narrow header the buttons drop their keys, then their words, so none is cut off.
    const actions = this.actions = new BoxRenderable(ctx, { id: "collection-actions", flexDirection: "row", gap: 3, height: 1, onSizeChange: () => this.fitActions() });
    const play = this.button("play-collection", icon.play, "Play", () => { const first = this.model.items[0]; if (first) void this.model.activate(first); });
    this.albumFavouriteButton = this.button("favourite-album", icon.heartOutline, "Favourite  l", () => void model.toggleAlbumFavourite(), colour.faint);
    const back = this.button("back", icon.back, "Back  esc", () => this.back());
    play.hints = ["Play", "Play", ""]; this.albumFavouriteButton.hints = ["Favourite  l", "Favourite", ""]; back.hints = ["Back  esc", "Back", ""];
    for (const button of [play, this.albumFavouriteButton, back]) { button.flexShrink = 0; actions.add(button); }
    for (const item of [this.headerName, this.headerArtist, this.headerMeta, actions]) info.add(item);
    this.headerCover.onMouseDown = event => { const detail = model.detail; if (event.button === 0 && detail) { event.stopPropagation(); this.coverView.show(detail.artwork, detail.name, detail.artist || detail.genre || ""); } };
    this.header.add(this.headerCover); this.header.add(info);
    // The header and the song list. Album pages stack them; wide artist pages put the top songs beside the artist.
    this.top = new BoxRenderable(ctx, { id: "top", flexDirection: "column", flexGrow: 1, minHeight: 0, minWidth: 0, flexShrink: 0 });
    this.top.add(this.header);
    this.songs = new BoxRenderable(ctx, { id: "songs", flexDirection: "column", flexGrow: 1, minHeight: 0, minWidth: 0 });
    this.empty = new TextRenderable(ctx, { id: "empty", content: "Connecting...", fg: colour.muted, height: 2, paddingX: 1 });
    this.songs.add(this.empty);
    this.section = new TextRenderable(ctx, { id: "top-songs", content: "", height: 1, marginLeft: 1, flexShrink: 0, selectable: false });
    this.songs.add(this.section);
    // Song lists can be filtered and sorted. The filter covers the whole list, not only the loaded part.
    this.filterBar = new BoxRenderable(ctx, { id: "filter-bar", height: 1, flexDirection: "row", gap: 2, paddingX: 1, flexShrink: 0, marginBottom: 1 });
    this.filterBar.add(new TextRenderable(ctx, { content: icon.filter, fg: colour.muted, width: 1, height: 1, flexShrink: 0, selectable: false }));
    this.filterInput = new InputRenderable(ctx, { id: "filter", flexGrow: 1, minWidth: 8, placeholder: "Filter by title, artist, or album, and years: 2015-2020, >2018, 90s   ⇧F", textColor: colour.text, placeholderColor: colour.faint, backgroundColor: "transparent", focusedBackgroundColor: "transparent" } as any);
    this.filterInput.on("input", (value: string) => void model.setFilter({ text: value }));
    this.filterInput.on("enter", () => this.tracks.focus());
    this.filterBar.add(this.filterInput);
    this.sortButton = this.button("sort", icon.sort, "", () => this.cycleSort());
    this.directionButton = this.button("sort-direction", "↑", "⇧O", () => void model.setFilter({ descending: !model.filter.descending }), colour.faint);
    this.lovedButton = this.button("loved-only", icon.heartOutline, "", () => void model.setFilter({ loved: !model.filter.loved }), colour.faint);
    for (const item of [this.sortButton, this.directionButton, this.lovedButton]) { item.flexShrink = 0; this.filterBar.add(item); }
    this.songs.add(this.filterBar);
    this.tracks = new ClickList(renderer, "tracks");
    this.tracks.onNearEnd = () => { if (this.model.more && !this.model.loading) void this.model.load(true); };
    this.songs.add(this.tracks);
    this.top.add(this.songs);
    this.trackPanel.add(this.top);
    // Home starts with what the other devices play. A click opens the devices popup to move it here.
    this.homeDevices = new TextRenderable(ctx, { id: "home-devices", height: 1, flexShrink: 0, paddingX: 2, marginBottom: 1, truncate: true, selectable: false, visible: false,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); this.devices.toggle(true); } } });
    this.trackPanel.add(this.homeDevices);
    this.grid = new CoverGrid(renderer, "grid");
    this.grid.onActivate = media => void this.model.activate(media);
    this.grid.onNearEnd = () => { if (this.model.more && !this.model.loading) void this.model.load(true); };
    this.trackPanel.add(this.grid);
    this.body.add(this.trackPanel);
    const library = model.library;
    this.lyrics = new LyricsView(renderer, lyrics ?? new LyricsSource({ apple: library.lyrics ? id => library.lyrics!(id) : undefined }));
    this.lyrics.onSeek = position => void model.act("/playback/seek", { position });
    this.body.add(this.lyrics.panel);
    this.root.add(this.body);

    this.player = new PlayerPanel(ctx, model, (...args) => this.button(...args), {
      showCover: (art, name, detail) => this.coverView.show(art, name, detail), toggleDevices: () => this.devices.toggle(),
      toggleLyrics: () => this.toggleLyrics(), focusContent: () => this.focusContent(),
    });
    this.root.add(this.player.panel);

    const footer = new BoxRenderable(ctx, { height: 1, flexDirection: "row", paddingX: 1, gap: 2 });
    // One line. A long message is cut off, so the key hints beside it stay visible.
    this.status = new TextRenderable(ctx, { id: "status", content: model.status, fg: colour.muted, height: 1, flexGrow: 1, minWidth: 0, truncate: true, wrapMode: "none" });
    footer.add(this.status);
    this.hints = new TextRenderable(ctx, { id: "hints", content: "", height: 1, flexShrink: 0, selectable: false });
    footer.add(this.hints);
    this.root.add(footer);
    model.on("change", this.change); renderer.on("resize", this.resize); renderer.on("focused_renderable", this.focusChange); renderer.keyInput.on("keypress", this.key);
    this.resizeLayout(); this.update(); this.content().focus();
  }

  // The longest hints with which the collection's buttons fit their row.
  private fitActions() {
    const buttons = this.actions.getChildren().filter(child => child instanceof Button && child.visible) as Button[];
    const levels = Math.max(...buttons.map(button => button.hints?.length ?? 1));
    for (let level = 0; level < levels; level++) {
      const hint = (button: Button) => button.hints ? button.hints[Math.min(level, button.hints.length - 1)]! : "";
      const needed = buttons.reduce((total, button) => total + button.widthWith(hint(button)), 0) + 3 * Math.max(0, buttons.length - 1);
      if (needed <= this.actions.width || level === levels - 1) { for (const button of buttons) button.setHint(hint(button)); return; }
    }
  }

  private button(id: string, glyph: string, hint: string, action: () => void, tint = colour.accent) {
    const button = new Button(this.renderer, id, glyph, hint, action, tint);
    this.buttons.push(button);
    return button;
  }

  private content() {
    const display = this.model.display;
    // An artist page has top songs above its album shelves. Keep focus in the part that has it.
    if (display === "sections") return this.grid.focused || !this.model.items.length && this.model.shelves.length ? this.grid : this.tracks;
    return display === "list" ? this.tracks : this.grid;
  }
  private focusContent() { this.content().focus(); }

  private resizeLayout() {
    const width = this.renderer.terminalWidth, height = this.renderer.terminalHeight;
    const narrow = width < 76;
    this.body.flexDirection = narrow ? "column" : "row";
    this.body.gap = narrow ? 0 : 1;
    // Narrow windows show the sidebar as one row of tabs above the content.
    if (narrow !== this.sidebar.horizontal) {
      (narrow ? this.sidebarPanel : this.tabs).remove(this.sidebar);
      if (narrow) this.tabs.add(this.sidebar); else this.sidebarPanel.add(this.sidebar, 0);
      this.sidebar.horizontal = narrow;
      this.sidebar.drawRows();
    }
    this.tabs.visible = narrow;
    this.sidebarPanel.visible = !narrow;
    this.player.layout(width, height);
    this.sidebarFooter.visible = !narrow;
    for (const button of this.buttons) { button.showHint = width >= 100 || ["play-collection", "favourite-album", "back", "sidebar-edit"].includes(button.id); button.paint(); }
    for (const button of this.player.buttons) { button.showHint = false; button.paint(); }
    this.sizeHeader();
    this.layoutLyrics();
    this.drawPlayback();
  }

  private toggleLyrics() {
    this.lyricsWanted = !this.lyricsWanted;
    this.layoutLyrics();
    // Lyrics shown in place of the content take its focus, so no key acts on hidden songs.
    if (!this.trackPanel.visible && (this.tracks.focused || this.grid.focused || this.filterInput.focused)) this.lyrics.panel.focus();
    else if (!this.lyricsWanted && (this.sidebar.focused || this.lyrics.panel.focused)) this.focusContent();
    this.update();
  }

  // Wide windows show the lyrics beside the content; narrower ones show them in its place.
  private layoutLyrics() {
    const width = this.renderer.terminalWidth;
    const shown = this.lyricsWanted && !this.coverView.open;
    const beside = width >= 110;
    const panel = this.lyrics.panel;
    panel.width = beside ? Math.max(34, Math.min(56, Math.floor(width * 0.3))) : "auto";
    panel.flexGrow = beside ? 0 : 1; panel.flexShrink = 0;
    this.trackPanel.visible = beside || !shown;
    this.player.lyricsButton.set(icon.lyrics, "y", shown ? colour.accent : colour.faint);
    this.lyrics.show(shown);
    if (shown) this.lyrics.sync(this.model.playback);
  }

  // Places the header, the song list, and the shelves for the current view.
  private arrange(display: string) {
    const model = this.model, width = this.renderer.terminalWidth;
    const sections = display === "sections", songs = model.items.length > 0;
    const header = !!model.detail;
    // The panel's inner width, beside the sidebar on wide terminals.
    // The side lyrics pane takes its width and one column of gap.
    const lyrics = this.lyrics.isShown && this.trackPanel.visible && typeof this.lyrics.panel.width === "number" ? this.lyrics.panel.width + 1 : 0;
    const inner = width - (width < 76 ? 4 : 29) - lyrics;
    // Wide artist pages list the top songs beside the artist, which leaves the height to the shelves.
    const beside = sections && header && songs && inner >= 110;
    this.header.visible = header;
    this.grid.visible = display !== "list";
    this.top.visible = display === "list" || sections && (header || songs);
    this.top.flexDirection = beside ? "row" : "column";
    const headerWidth = this.coverWidth + 36;
    this.header.width = beside ? headerWidth : "auto";
    this.header.flexShrink = 0;
    this.tracks.visible = display === "list" || sections && songs;
    this.section.visible = sections && songs;
    this.section.content = t`${bold(fg(colour.text)(model.view === "search" ? "Songs" : "Top songs"))}`;
    this.songs.paddingTop = beside ? 1 : 0;
    this.songs.paddingBottom = sections && !beside ? 1 : 0;

    // Song tables need room for their columns. Narrow lists keep two lines per song.
    const detail = model.detail;
    // Wide lists also show the year. A list beside the lyrics keeps the artist and the year, and
    // leaves the album out.
    const room = beside ? inner - headerWidth : inner;
    const columns: Column[] | undefined = !songs ? undefined
      : model.view.startsWith("artist:") ? (room >= 100 ? ["album", "year"] : ["album"])
      : detail?.type.includes("albums") ? (model.items.some(item => item.artist && item.artist !== detail.artist) ? ["artist"] : [])
      : room >= 100 ? ["artist", "album", "year"] : room >= 90 || !this.lyrics.isShown ? ["artist", "album"] : ["artist", "year"];
    const table = !!columns && room >= (columns.includes("album") ? 90 : 60);
    this.tracks.columns = table ? columns : undefined;
    this.tracks.rowHeight = table || detail ? 1 : 2;

    if (!sections) {
      this.top.flexGrow = 1; this.top.height = "auto"; this.tracks.flexGrow = 1; this.tracks.height = "auto";
      return;
    }
    // Top songs and search songs take a few rows and scroll. The shelves below take the rest.
    // The window's height less the top row, the player, the key hints and the panel's borders.
    const panel = this.renderer.terminalHeight - 9;
    const shown = Math.min(model.items.length, beside ? this.headerHeight - 2 - (table ? 1 : 0)
      : model.view === "search" ? Math.max(3, Math.floor(panel * 0.35)) : panel >= 22 ? 5 : panel >= 16 ? 3 : 2);
    const listHeight = songs ? shown * this.tracks.rowHeight + (table ? 1 : 0) : 0;
    this.tracks.flexGrow = 0; this.tracks.height = listHeight;
    this.top.flexGrow = 0;
    this.top.height = beside ? this.headerHeight : (header ? this.headerHeight : 0) + (songs ? 1 + listHeight + 1 : 0);
  }

  // An artist page also needs room for top songs and a shelf of covers.
  private sizeHeader() {
    const width = this.renderer.terminalWidth, height = this.renderer.terminalHeight;
    const compact = height < (this.model.display === "sections" ? 44 : 30) || width < 76;
    this.headerHeight = compact ? 5 : 10;
    this.coverWidth = compact ? 6 : 16;
    this.header.height = this.headerHeight;
    this.headerCover.setSize(this.coverWidth, compact ? 3 : 8);
    this.headerMeta.visible = !compact || this.model.display === "sections" && height >= 30;
    this.header.paddingY = compact && this.headerMeta.visible ? 0 : 1;
  }


  private update() {
    if (this.disposed) return;
    const model = this.model;
    this.devices.draw();
    this.pairing.draw();
    const display = model.display;
    this.status.content = model.status;
    const artist = display === "sections";
    this.sizeHeader();
    this.trackPanel.title = model.view.startsWith("artist:") ? "Artist" : model.detail ? (model.detail.type.includes("playlist") ? "Playlist" : "Album") : model.title;
    // A song list says how many songs it has, or how many of them match the filter.
    const total = model.detail?.trackCount && model.more ? model.detail.trackCount : model.items.length;
    const filtered = model.shown.length !== model.items.length;
    this.trackPanel.note = display !== "list" || !model.items.length || model.view === "settings" ? ""
      : filtered ? `${model.shown.length.toLocaleString("en")} of ${total.toLocaleString("en")}${model.more ? "+" : ""}` : `${total.toLocaleString("en")}${model.more ? "+" : ""} ${total === 1 ? "song" : "songs"}`;
    this.trackPanel.noteColour = filtered ? colour.accent : colour.muted;
    const others = model.view === "home" ? model.devices.filter(device => device.paired && !device.self && device.online) : [];
    this.homeDevices.visible = others.length > 0;
    if (others.length) this.homeDevices.content = new StyledText([fg(colour.faint)("ON YOUR DEVICES  "), ...others.flatMap((device, index) => {
      const summary = device.summary, playing = summary?.state === "playing";
      return [fg(colour.faint)(index ? "   " : ""), fg(playing ? colour.playing : colour.faint)("● "), fg(colour.text)(device.name),
        fg(colour.muted)(summary?.song ? `  ${[summary.song, summary.artist].filter(Boolean).join(" / ")}` : "  idle")];
    }), fg(colour.accent)("   d"), fg(colour.faint)(" play here")]);
    this.arrange(display);
    this.empty.visible = display === "list" && !model.items.length && model.view !== "settings";
    this.empty.content = model.loading ? "Loading..." : model.view === "queue" && !model.connected ? "The player is not running yet. The queue starts with your first song."
      : model.view === "queue" ? "No songs queued. Press e on a song, album, or playlist to add it, or Shift+E to play it next."
      : "Nothing here yet. Search above or choose something on the left.";
    if (model.detail) {
      const detail = model.detail;
      this.headerCover.setArt(detail.artwork);
      this.headerCover.setGlyph(glyph(detail));
      this.headerName.content = detail.name;
      if (artist) {
        this.headerArtist.content = detail.genre ?? "";
        const count = (id: string, one: string, many: string) => { const total = model.shelves.find(shelf => shelf.id === id)?.items.length; return total ? `${total} ${total === 1 ? one : many}` : ""; };
        this.headerMeta.content = model.loading ? "Loading..." : [count("full-albums", "album", "albums"), count("singles", "single or EP", "singles and EPs")].filter(Boolean).join("   ");
      } else {
        this.headerArtist.content = detail.artist || (detail.type.includes("playlist") ? "Playlist" : "");
        const seconds = model.items.reduce((total, item) => total + item.duration, 0);
        const count = model.more ? detail.trackCount : model.items.length || detail.trackCount;
        this.headerMeta.content = [detail.releaseDate?.slice(0, 4), count ? plural(count, "song") : "", seconds && !model.more ? `${Math.round(seconds / 60)} min` : ""].filter(Boolean).join("   ");
      }
      const loved = model.albumFavourite;
      this.albumFavouriteButton.visible = detail.type.includes("albums");
      this.albumFavouriteButton.set(loved ? icon.heart : icon.heartOutline, undefined, loved ? colour.heart : colour.faint);
      this.fitActions();
    }
    if (this.content() === this.grid && this.tracks.focused) this.grid.focus();
    if (this.content() === this.tracks && this.grid.focused) this.tracks.focus();

    // While editing, hidden entries show dimmed, and selecting an entry shows or hides it.
    const editing = this.editingSidebar;
    const nav = model.navigation(editing);
    this.sidebarHints.visible = editing;
    this.editButton.set(editing ? icon.done : icon.edit, editing ? "Done  e" : "Edit  e", editing ? colour.accent : colour.faint);
    const sidebarKey = JSON.stringify([nav.map(item => [item.id, item.name, item.hidden]), model.view, editing]);
    if (sidebarKey !== this.lastSidebar) {
      this.lastSidebar = sidebarKey;
      // Home cannot be hidden, so it shows no eye while editing.
      const editable = (id: string) => editing && id !== "home";
      const row = (item: (typeof nav)[number]) => ({
        id: item.id, key: item.id, name: item.name, faint: item.hidden,
        // Only Favourite Songs has a glyph, its heart. While editing, an eye shows whether an entry is shown.
        lead: editable(item.id) ? item.hidden ? icon.hidden : icon.shown : item.id === "favourites" ? icon.heart : undefined,
        active: !editing && item.id === model.view,
        leadColour: item.hidden ? colour.faint : editable(item.id) ? colour.muted : colour.heart,
        activate: () => {
          if (editable(item.id)) void model.hide(item.id);
          else if (!editing) { void model.open(item.id); this.focusContent(); }
        },
      });
      // The library first, then Favourite Songs and the playlists under their own heading.
      const playlists = nav.filter(item => playlistEntry(item.id));
      this.sidebar.setRows([
        ...nav.filter(item => !playlistEntry(item.id)).map(row),
        ...playlists.length ? [{ id: "gap", name: "", heading: true, activate: () => {} }, { id: "playlists", name: "PLAYLISTS", heading: true, activate: () => {} }, ...playlists.map(row)] : [],
      ]);
      // Moving an entry keeps it selected. Opening a view selects that view.
      if (model.view !== this.lastView) { this.lastView = model.view; this.sidebar.selectKey(model.view); }
    }

    if (display !== "list") {
      const shelves = shelvesFor(model);
      const key = JSON.stringify([display, shelves.map(shelf => [shelf.id, shelf.empty, shelf.tiles.map(tile => [tile.media.id, tile.detail, tile.note])])]);
      if (key !== this.lastShelves) { this.lastShelves = key; this.grid.setShelves(shelves, display === "grid"); }
      if (artist && !this.grid.focused && !this.tracks.focused && !this.search.focused && !this.sidebar.focused) this.content().focus();
    }
    const playing = model.playback.nowPlaying;
    // Loading a page replaces the items array, so comparing the array is enough to notice new songs.
    const rowsKey = JSON.stringify([model.view, playing?.name, playing?.artistName, this.tracks.columns, this.tracks.rowHeight, model.lovedRevision, model.preferences.heartsInFavourites]);
    const shown = model.shown;
    if (model.view === "settings") {
      const rows = settingsRows(this.settings), key = JSON.stringify(["settings", rows.map(row => [row.id, row.right, row.description])]);
      if (key !== this.lastRows) { this.lastRows = key; this.lastItems = undefined; this.tracks.setRows(rows); }
    } else if (rowsKey !== this.lastRows || shown !== this.lastItems) {
      this.lastRows = rowsKey; this.lastItems = shown;
      this.tracks.setRows(songRows(model));
    }
    // The filter bar belongs to song lists. The queue follows playback, so it is not filtered.
    const filtering = model.filter.text.trim() !== "" || model.filter.sort !== "playlist" || model.filter.descending || model.filter.loved;
    // A short album or playlist is easier to read without it.
    // Shift+F opens it on short lists too.
    this.filterBar.visible = this.filterable() && (model.items.length > 10 || model.more || filtering || this.filterInput.focused);
    if (this.filterInput.value !== model.filter.text && !this.filterInput.focused) this.filterInput.value = model.filter.text;
    this.sortButton.set(icon.sort, `${sorts[model.filter.sort]}  o`, model.filter.sort === "playlist" ? colour.faint : colour.accent);
    // A shuffled order has no direction.
    this.directionButton.visible = model.filter.sort !== "shuffled";
    this.directionButton.set(model.filter.descending ? "↓" : "↑", "⇧O", model.filter.descending ? colour.accent : colour.faint);
    this.lovedButton.visible = model.view !== "favourites";
    this.lovedButton.set(model.filter.loved ? icon.heart : icon.heartOutline, "Favourites  *", model.filter.loved ? colour.heart : colour.faint);
    if (filtering && !shown.length && !model.loading) { this.empty.visible = true; this.empty.content = model.more ? "Loading the rest of the list to filter..." : "No songs match the filter. Escape clears it."; }
    this.lyrics.sync(model.playback);
    this.drawPlayback();
    this.drawHints();
  }

  // The keys for what has focus, listed at the bottom right. With more, the other keys that apply
  // here instead, for ?. Keys the screen already shows beside a button are left out.
  private keys(more: boolean) {
    const model = this.model, pairs: [string, string][] = [];
    const item = this.grid.focused ? this.grid.selected()?.media : this.tracks.focused ? model.shown[Number(this.tracks.selectedId())] : undefined;
    const content = this.grid.focused || this.tracks.focused;
    if (this.search.focused) pairs.push(["⏎", "search"], ["Esc", "leave"]);
    else if (this.filterInput.focused) pairs.push(["Esc", "clear"]);
    else if (this.sidebar.focused && !this.editingSidebar) pairs.push(["⏎", "open"], ["e", "edit"]);
    else if (model.view === "settings" && this.tracks.focused) pairs.push(["⏎", "change"]);
    else if (model.view === "queue" && item) pairs.push(["⏎", "play"], ["⇧E", "play next"], ["⇧↑↓", "move"], ["x", "remove"]);
    else if (item?.type.includes("artists")) pairs.push(["⏎", "open"]);
    else if (item) pairs.push(["⏎", /albums|playlists/.test(item.type) ? "open" : "play"], ["e", "add to queue"], ["⇧E", "play next"]);
    else if (this.lyrics.panel.focused) pairs.push(["↑↓", "choose line"], ["⏎", "play from it"], ["h l", "previous/next line"]);
    if (this.pairing.view) { pairs.length = 0; pairs.push(...this.model.pairing?.state === "confirm" ? [["⏎", "pair"], ["Esc", "cancel"]] as [string, string][] : [["Esc", "close"]] as [string, string][]); }
    else if (this.devices.list) {
      const row = this.devices.list.rows[this.devices.list.index];
      pairs.length = 0; pairs.push(["↑↓", "choose"], ["⏎", row?.right === "Pair" ? "pair" : "play here"], ["Esc", "close"]);
    }
    if (!more) return pairs;
    pairs.length = 0;
    if (content) {
      if (this.filterable()) {
        if (!this.filterBar.visible) pairs.push(["⇧F", "filter"], ["o", "sort"]);
        pairs.push(["⇧O", "reverse"]);
      }
      if (model.more) pairs.push(["m", "load more"]);
      if (model.detail?.type.includes("albums")) pairs.push(["l", "favourite album"]);
      if (model.history.length) pairs.push(["Esc", "back"]);
      pairs.push([this.grid.focused ? "⇧←→" : "←→", "seek"]);
    }
    // The player's buttons show no keys beside them, so they are listed here.
    pairs.push(["space", "play"], ["p n", "skip"], ["- +", "volume"], ["f", "favourite"], ["s", "shuffle"], ["r", "repeat"]);
    if (model.detail?.artwork || model.playback.nowPlaying) pairs.push(["c", "cover"]);
    pairs.push(["y", "lyrics"], ["d", "devices"]);
    if (model.view !== "queue") pairs.push(["u", "queue"]);
    pairs.push(["/", "search"], ["Tab", "next panel"]);
    return pairs;
  }

  private drawHints() {
    const pairs: [string, string][] = [...this.keys(false), ["?", "more keys"], ["q", "quit"]];
    // Narrow windows drop the first hints, so status messages keep room.
    const length = () => pairs.reduce((sum, [key, label]) => sum + key.length + label.length + 3, 0) - 2;
    while (pairs.length > 2 && length() > this.renderer.terminalWidth / 2) pairs.shift();
    this.hints.content = new StyledText(pairs.flatMap(([key, label], index) => [fg(colour.muted)(`${index ? "  " : ""}${key} `), fg(colour.faint)(label)]));
    this.hints.width = length();
  }


  drawPlayback() { this.player.draw(); this.topBar.draw(this.renderer.terminalWidth); }



  private back() {
    const closed = this.model.back();
    if (!closed) return false;
    this.update();
    // On an artist page the closed album is in a shelf, and anything else was opened from its top songs.
    const shelf = this.model.display === "sections" && this.model.shelves.some(shelf => shelf.items.some(item => item.id === closed.id));
    if (this.model.display === "sections") (shelf ? this.grid : this.tracks).focus();
    if (this.content() === this.grid) this.grid.select(closed.id); else this.tracks.selectKey(closed.id);
    this.focusContent();
    return true;
  }
  // The highlighted song, album, or playlist goes after the playing song (next) or to the end of the queue.
  private enqueue(next: boolean) {
    let item: Media | undefined;
    if (this.grid.focused) item = this.grid.selected()?.media;
    else if (this.tracks.focused && this.model.view === "queue") { this.model.status = "This song is queued. Shift+E plays it next."; this.model.changed(); return; }
    else if (this.tracks.focused) item = this.model.shown[Number(this.tracks.selectedId())];
    if (item) void this.model.enqueue(item, next);
    else { this.model.status = "Highlight a song, album, or playlist to queue it."; this.model.changed(); }
  }
  // Queue edits move the highlight with the song.
  private moveQueued(to: number) {
    const from = this.tracks.index;
    to = Math.min(Math.max(0, to), this.model.items.length - 1);
    if (to === from) return;
    this.tracks.index = to;
    void this.model.moveQueued(from, to);
  }
  private editingQueue() { return this.model.view === "queue" && this.tracks.focused && this.model.items.length > 0; }
  private filterable() { return this.model.display === "list" && this.model.view !== "queue" && this.model.view !== "settings"; }


  private cycleSort() {
    const order = Object.keys(sorts) as Sort[];
    void this.model.setFilter({ sort: order[(order.indexOf(this.model.filter.sort) + 1) % order.length] });
  }

  // Home stays first and visible. The other sidebar entries can be moved and hidden.
  private reorder(direction: number) { const id = this.sidebar.selectedId(); if (id && id !== "home") void this.model.reorder(id, direction); }
  private editSidebar(editing: boolean) {
    if (editing === this.editingSidebar) return;
    this.editingSidebar = editing;
    if (editing) this.sidebar.focus();
    this.update();
    // A hidden entry leaves the list, so the selection returns to the open view.
    if (!editing) this.sidebar.selectKey(this.model.view);
  }

  private handleKey(key: KeyEvent) {
    if (key.eventType === "release") return;
    const model = this.model;
    const grid = this.grid.focused;
    let action: (() => void) | undefined;
    if (key.ctrl && key.name === "c") action = this.quit;
    // The pairing prompt takes the keys, except play/pause.
    else if (this.pairing.view) action = () => this.pairing.press(key.name);
    // The devices popup takes the keys that move in it. Playback keys still work under it.
    else if (this.devices.handles(key.name)) action = () => this.devices.press(key.name);
    // The enlarged cover takes the keys, except play/pause and quit.
    else if (this.coverView.open) action = key.name === "space" ? () => void model.act("/playback/toggle") : key.name === "q" ? this.quit
      : ["escape", "return", "backspace", "c"].includes(key.name) ? () => this.coverView.close() : () => {};
    else if (key.name === "c" && !this.search.focused && !this.filterInput.focused) action = () => {
      const detail = model.detail, song = model.playback.nowPlaying;
      if (detail?.artwork) this.coverView.show(detail.artwork, detail.name, detail.artist || detail.genre || "");
      else if (song) this.coverView.show(song.artwork?.url, song.albumName ?? song.name ?? "", song.artistName ?? "");
    };
    else if (key.ctrl && key.name === "f") action = () => this.search.focus();
    else if (key.ctrl && key.name === "p") action = () => void model.act("/playback/toggle");
    else if (key.name === "tab") action = () => {
      const artist = model.display === "sections";
      // Lyrics shown in place of the content hide the filter and the songs, so Tab skips them.
      const content = !this.trackPanel.visible ? [] : [...this.filterBar.visible ? [this.filterInput] : [], ...artist ? [this.tracks, this.grid].filter(target => target.visible) : [this.content()]];
      const targets = [this.search, this.sidebar, ...content, ...this.lyrics.isShown ? [this.lyrics.panel] : []];
      const index = targets.findIndex(target => target.focused);
      targets[(index + (key.shift ? targets.length - 1 : 1)) % targets.length].focus();
    };
    else if (key.name === "escape" && this.lyrics.panel.focused && this.lyrics.browsing) action = () => this.lyrics.release();
    else if (key.name === "escape" && this.lyrics.isShown && !this.trackPanel.visible && !this.search.focused) action = () => this.toggleLyrics();
    else if (key.name === "escape" && this.filterInput.focused) action = () => {
      if (this.filterInput.value) { this.filterInput.value = ""; void model.setFilter({ text: "" }); }
      else this.tracks.focus();
    };
    else if (key.name === "escape" && this.tracks.focused && model.filter.text) action = () => { void model.setFilter({ text: "" }); };
    else if (key.name === "escape" && this.editingSidebar) action = () => this.editSidebar(false);
    else if (key.name === "escape") action = () => {
      if (!this.search.focused && this.back()) return;
      this.focusContent();
    };
    else if (this.search.focused || this.filterInput.focused) return;
    else if (key.name === "f" && key.shift && this.filterable()) action = () => { this.filterBar.visible = true; this.filterInput.focus(); };
    else if (key.name === "o" && key.shift && this.filterable()) action = () => void model.setFilter({ descending: !model.filter.descending });
    else if (key.name === "o" && this.filterable()) action = () => this.cycleSort();
    else if (key.sequence === "*" && this.filterable() && model.view !== "favourites") action = () => void model.setFilter({ loved: !model.filter.loved });
    else if (key.name === "backspace") action = () => void this.back();
    else if (key.name === "/") action = () => this.search.focus();
    else if (key.name === "q") action = this.quit;
    else if (key.name === "?" || key.sequence === "?") action = () => { model.status = this.keys(true).map(([key, label]) => `${key} ${label}`).join("  "); model.changed(); };
    else if (this.editingSidebar && key.shift && ["up", "down", "j", "k"].includes(key.name)) action = () => this.reorder(["down", "j"].includes(key.name) ? 1 : -1);
    else if (this.sidebar.focused && key.name === "e") action = () => this.editSidebar(!this.editingSidebar);
    else if (this.editingQueue() && key.shift && ["up", "down", "j", "k"].includes(key.name)) action = () => this.moveQueued(this.tracks.index + (["down", "j"].includes(key.name) ? 1 : -1));
    else if (this.editingQueue() && key.shift && key.name === "e") action = () => this.moveQueued(0);
    else if (this.editingQueue() && ["x", "delete"].includes(key.name)) action = () => void this.model.removeQueued(this.tracks.index);
    else if (key.name === "e") action = () => this.enqueue(key.shift);
    else if (key.name === "y") action = () => this.toggleLyrics();
    else if (key.name === "d" && !key.ctrl) action = () => this.devices.toggle();
    else if (key.name === "u") action = () => { void this.model.open("queue"); this.focusContent(); };
    else if (this.lyrics.panel.focused && ["up", "down", "j", "k"].includes(key.name)) action = () => this.lyrics.move(["up", "k"].includes(key.name) ? -1 : 1);
    else if (this.lyrics.panel.focused && ["pageup", "pagedown", "home", "end"].includes(key.name)) action = () => this.lyrics.move({ pageup: -8, pagedown: 8, home: -1e6, end: 1e6 }[key.name as "home"]);
    else if (this.lyrics.panel.focused && key.name === "return") action = () => void this.lyrics.jump();
    // Untimed lyrics have no line to play from, so the arrows seek as elsewhere.
    else if (this.lyrics.panel.focused && ["h", "l", "left", "right"].includes(key.name) && !key.shift) action = () => {
      const direction = ["l", "right"].includes(key.name) ? 1 : -1;
      if (!this.lyrics.step(direction) && ["left", "right"].includes(key.name)) void model.seek(direction * 10);
    };
    else if (model.display === "sections" && grid && ["up", "k"].includes(key.name) && this.grid.atTop() && this.tracks.visible) action = () => this.tracks.focus();
    else if (model.display === "sections" && this.tracks.focused && ["down", "j"].includes(key.name) && this.tracks.atEnd()) action = () => this.grid.focus();
    else if (grid && ["up", "down", "j", "k"].includes(key.name)) action = () => this.grid.move(0, ["up", "k"].includes(key.name) ? -1 : 1);
    else if (this.sidebar.horizontal && this.sidebar.focused && ["left", "right", "h", "l"].includes(key.name)) action = () => this.sidebar.move(["left", "h"].includes(key.name) ? -1 : 1);
    else if (grid && ["left", "right"].includes(key.name) && !key.shift) action = () => this.grid.move(key.name === "right" ? 1 : -1, 0);
    else if (["up", "down", "j", "k"].includes(key.name)) action = () => (this.sidebar.focused ? this.sidebar : this.tracks).move(["up", "k"].includes(key.name) ? -1 : 1);
    else if (!grid && ["pageup", "pagedown", "home", "end"].includes(key.name)) action = () => {
      const list = this.sidebar.focused ? this.sidebar : this.tracks;
      list.move(key.name === "home" ? -list.rows.length : key.name === "end" ? list.rows.length : (key.name === "pageup" ? -1 : 1) * list.page);
    };
    else if (key.name === "return") action = () => this.sidebar.focused ? this.sidebar.activate() : grid ? this.grid.activate() : this.tracks.activate();
    else if (key.name === "space") action = () => void model.act("/playback/toggle");
    else if (key.name === "n") action = () => void model.skip(1);
    else if (key.name === "p") action = () => void model.skip(-1);
    else if (key.name === "f") action = () => void model.toggleFavourite();
    else if (key.name === "l" && model.detail?.type.includes("albums")) action = () => void model.toggleAlbumFavourite();
    else if (key.name === "left" || key.name === "right") action = () => void model.seek(key.name === "left" ? -10 : 10);
    else if (key.sequence === "+" || key.sequence === "=" || key.sequence === "-") action = () => void model.volume(key.sequence === "-" ? -0.05 : 0.05);
    else if (key.name === "s") action = () => void model.act("/playback/shuffle/toggle");
    else if (key.name === "r") action = () => void model.act("/playback/repeat/toggle");
    else if (key.name === "m" && model.more) action = () => void model.load(true);
    if (action) { key.preventDefault(); key.stopPropagation(); action(); }
    // Moving the highlight between a song and an album changes the keys that apply. Quitting
    // and restarting have already destroyed the hints by now.
    if (!this.disposed) this.drawHints();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.coverView.close();
    this.devices.close();
    this.pairing.close();
    this.lyrics.dispose();
    this.model.off("change", this.change); this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.focusChange); this.renderer.keyInput.off("keypress", this.key);
    this.root.destroyRecursively();
  }
}
