import { BoxRenderable, TextRenderable, InputRenderable, ImageRenderable, t, fg, bold, type CliRenderer, type KeyEvent, type MouseEvent, type RenderContext } from "@opentui/core";
import { Model } from "./model";
import { duration, type Media } from "./types";
import { cover } from "./artwork";
import { colour, icon } from "./theme";

interface Row { id: string; key?: string; lead?: string; leadColour?: string; name: string; description?: string; artist?: string; album?: string; right?: string; active?: boolean; activate: () => void }
type Column = "artist" | "album";
interface Tile { media: Media; caption: string; detail: string; note?: string; noteColour?: string }
interface Shelf { id: string; title: string; tiles: Tile[]; empty: string }

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function releaseDay(date?: string) {
  const [, month, day] = (date ?? "").split("-").map(Number);
  return month ? `${day} ${months[month - 1]}` : "";
}
const today = () => new Date().toISOString().slice(0, 10);
const glyph = (item: Media) => item.type.includes("artist") ? icon.artist : item.type.includes("playlist") ? icon.playlist : icon.album;
// Apple appends the release type to single and EP names. The shelf title already says it.
const release = (name: string) => name.replace(/ - (Single|EP)$/, "");

// Album art, with an album glyph until the image arrives or when there is none.
class Cover extends BoxRenderable {
  private art?: string;
  private image?: ImageRenderable;
  private glyph: TextRenderable;

  constructor(ctx: RenderContext, options: { id?: string; width: number; height: number; art?: string; glyph?: string }) {
    super(ctx, { id: options.id, width: options.width, height: options.height, flexShrink: 0, backgroundColor: colour.surface, alignItems: "center", justifyContent: "center" });
    this.glyph = new TextRenderable(ctx, { content: options.glyph ?? icon.album, fg: colour.faint, height: 1, width: 2, selectable: false });
    this.add(this.glyph);
    this.setArt(options.art);
  }

  setArt(art?: string) {
    if (art === this.art) return;
    this.art = art;
    if (this.image) { this.remove(this.image); this.image.destroyRecursively(); this.image = undefined; }
    this.glyph.visible = true;
    void cover(art)?.then(image => {
      if (!image || this.art !== art || this.isDestroyed) return;
      this.image = new ImageRenderable(this.ctx, { position: "absolute", left: 0, top: 0, width: this.width, height: this.height, source: image, fit: "cover" });
      this.add(this.image); this.glyph.visible = false;
    });
  }

  setGlyph(glyph: string) { this.glyph.content = glyph; }

  setSize(width: number, height: number) {
    this.width = width; this.height = height;
    if (this.image) { this.image.width = width; this.image.height = height; }
  }
}

// A clickable icon. The key hint is shown when the terminal has room for it.
class Button extends TextRenderable {
  private hovered = false;
  showHint = true;

  constructor(ctx: RenderContext, id: string, private glyph: string, private hint: string, action: () => void, private tint = colour.accent) {
    super(ctx, {
      id, height: 1, selectable: false,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); action(); } },
      onMouseOver: () => { this.hovered = true; this.paint(); }, onMouseOut: () => { this.hovered = false; this.paint(); },
    });
    this.paint();
  }

  set(glyph: string, hint = this.hint, tint = this.tint) {
    if (glyph === this.glyph && hint === this.hint && tint === this.tint) return;
    this.glyph = glyph; this.hint = hint; this.tint = tint; this.paint();
  }

  paint() {
    const label = this.hovered ? colour.text : this.tint;
    this.content = this.showHint && this.hint ? t`${fg(label)(this.glyph)} ${fg(this.hovered ? colour.text : colour.faint)(this.hint)}` : t`${fg(label)(this.glyph)}`;
  }
}

class ClickList extends BoxRenderable {
  rows: Row[] = [];
  index = 0;
  offset = 0;
  // Wide song lists are tables: one line per song, with these columns between title and time.
  columns?: Column[];
  onSelection?: (row: Row) => void;

  constructor(renderer: CliRenderer, id: string, public rowHeight = 2) {
    super(renderer, { id, flexGrow: 1, minHeight: 0, width: "100%", overflow: "hidden", focusable: true,
      onMouseScroll: event => { event.stopPropagation(); this.move(event.scroll?.direction === "up" ? -3 : 3); },
    });
  }

  // The rows that fit on screen, for Page Up and Page Down.
  get page() { return Math.max(1, this.columns ? this.height - 2 : Math.floor(this.height / this.rowHeight) - 1); }

  setRows(rows: Row[]) {
    const id = this.rows[this.index]?.id;
    this.rows = rows;
    this.index = Math.max(0, id ? rows.findIndex(row => row.id === id) : 0);
    this.drawRows();
  }
  selectKey(key: string) {
    const index = this.rows.findIndex(row => row.key === key);
    if (index >= 0) { this.index = index; this.drawRows(); }
  }
  move(delta: number) { this.index = Math.min(Math.max(0, this.rows.length - 1), Math.max(0, this.index + delta)); this.drawRows(); this.onSelection?.(this.rows[this.index]); }
  activate() { this.rows[this.index]?.activate(); }
  selectedId() { return this.rows[this.index]?.id; }
  atEnd() { return this.index >= this.rows.length - 1; }
  protected onResize() { if (this.rows) this.drawRows(); }
  drawRows() {
    if (!this.rows || !this.rowHeight) return;
    for (const child of this.getChildren()) { this.remove(child); child.destroyRecursively(); }
    if (this.columns) return this.drawTable(this.columns);
    const visible = Math.max(1, Math.floor(this.height / this.rowHeight));
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + visible) this.offset = this.index - visible + 1;
    this.offset = Math.min(this.offset, Math.max(0, this.rows.length - visible));
    this.rows.slice(this.offset, this.offset + visible).forEach((row, position) => {
      const index = this.offset + position;
      const box = new BoxRenderable(this.ctx, {
        id: `${this.id}:row:${row.id}`, position: "absolute", top: position * this.rowHeight, width: "100%", height: this.rowHeight,
        paddingX: 1, flexDirection: "column", backgroundColor: index === this.index ? colour.selected : "transparent",
        onMouseDown: event => {
          if (event.button !== 0) return;
          event.stopPropagation(); this.focus(); this.index = index; this.drawRows(); row.activate();
        },
      });
      const line = new BoxRenderable(this.ctx, { flexDirection: "row", height: 1, width: "100%", gap: 1 });
      if (row.lead !== undefined) line.add(new TextRenderable(this.ctx, { content: row.lead, fg: row.leadColour ?? colour.faint, height: 1, flexShrink: 0, selectable: false }));
      line.add(new TextRenderable(this.ctx, { content: row.name, fg: row.active ? colour.accent : colour.text, flexGrow: 1, minWidth: 0, height: 1, truncate: true, selectable: false }));
      if (row.right) line.add(new TextRenderable(this.ctx, { content: row.right, fg: colour.muted, height: 1, flexShrink: 0, selectable: false }));
      box.add(line);
      if (this.rowHeight > 1) box.add(new TextRenderable(this.ctx, { content: row.description ?? "", fg: colour.muted, width: "100%", height: 1, truncate: true, selectable: false, marginLeft: row.lead === undefined ? 0 : row.lead.length + 1 }));
      this.add(box);
    });
  }

  // A header line names the columns. Title, artist, and album share the width 4:3:3.
  private drawTable(columns: Column[]) {
    const lead = Math.max(0, ...this.rows.map(row => Bun.stringWidth(row.lead ?? "")));
    const gap = 2, free = Math.max(columns.length + 1, this.width - 2 - lead - 5 - gap * (columns.length + 2));
    const share = Math.floor(free * 3 / (4 + 3 * columns.length));
    const widths = { name: free - share * columns.length, artist: share, album: share };
    const line = (top: number, cells: { lead: string; leadColour?: string; name: string; nameColour: string; artist?: string; album?: string; right: string; tint: string }, options: Record<string, unknown> = {}) => {
      const box = new BoxRenderable(this.ctx, { position: "absolute", top, width: "100%", height: 1, paddingX: 1, flexDirection: "row", gap, ...options });
      box.add(new TextRenderable(this.ctx, { content: cells.lead.padStart(lead), fg: cells.leadColour ?? colour.faint, width: lead, height: 1, flexShrink: 0, selectable: false }));
      box.add(new TextRenderable(this.ctx, { content: fit(cells.name, widths.name), fg: cells.nameColour, width: widths.name, height: 1, flexShrink: 0, selectable: false }));
      for (const column of columns) box.add(new TextRenderable(this.ctx, { content: fit(cells[column] ?? "", widths[column]), fg: cells.tint, width: widths[column], height: 1, flexShrink: 0, selectable: false }));
      box.add(new TextRenderable(this.ctx, { content: cells.right.padStart(5), fg: cells.tint, width: 5, height: 1, flexShrink: 0, selectable: false }));
      this.add(box);
      return box;
    };
    line(0, { lead: "", name: "Title", nameColour: colour.faint, artist: "Artist", album: "Album", right: "Time", tint: colour.faint });
    const visible = Math.max(1, this.height - 1);
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + visible) this.offset = this.index - visible + 1;
    this.offset = Math.min(this.offset, Math.max(0, this.rows.length - visible));
    this.rows.slice(this.offset, this.offset + visible).forEach((row, position) => {
      const index = this.offset + position;
      line(position + 1, {
        lead: row.lead ?? "", leadColour: row.leadColour, name: row.name, nameColour: row.active ? colour.accent : colour.text,
        artist: row.artist, album: row.album, right: row.right ?? "", tint: colour.muted,
      }, {
        id: `${this.id}:row:${row.id}`, backgroundColor: index === this.index ? colour.selected : "transparent",
        onMouseDown: (event: MouseEvent) => {
          if (event.button !== 0) return;
          event.stopPropagation(); this.focus(); this.index = index; this.drawRows(); row.activate();
        },
      });
    });
  }
}

// Shortened names end in an ellipsis, so a cut-off name does not read as a complete one.
function fit(text: string, width: number) {
  if (Bun.stringWidth(text) <= width) return text;
  let result = "";
  for (const char of text) {
    if (Bun.stringWidth(result + char) > width - 1) break;
    result += char;
  }
  return result.trimEnd() + "…";
}

// Covers laid out as shelves that scroll sideways (Home), or as a wrapping grid (Albums).
class CoverGrid extends BoxRenderable {
  shelves: Shelf[] = [];
  wrap = false;
  shelf = 0;
  tile = 0;
  private starts = new Map<string, number>();
  private scrollTop = 0;
  onActivate?: (media: Media) => void;
  onNearEnd?: () => void;

  constructor(renderer: CliRenderer, id: string) {
    super(renderer, { id, flexGrow: 1, minHeight: 0, width: "100%", overflow: "hidden", focusable: true,
      onMouseScroll: event => { event.stopPropagation(); this.move(0, event.scroll?.direction === "up" ? -1 : 1); },
    });
  }

  private get headings() { return this.shelves.some(shelf => shelf.title) && this.height >= 9; }
  // Only whole rows are shown. Pick the cover size whose rows and columns fill most of
  // the panel, preferring larger covers when the fit is close. Cells are about twice as
  // tall as wide. Keep three columns where they fit, so narrow windows still show a choice.
  // Shelves (Home, artist pages) show at least two shelves at once and scroll to the rest.
  private get coverWidth() {
    const tile = (width: number) => width / 2 + 4 + (this.notes ? 1 : 0);
    // A wrapped row follows the previous one directly. A shelf adds its heading and a blank line.
    const block = (width: number) => this.wrap ? tile(width) : tile(width) + (this.headings ? 1 : 0) + 1;
    const count = this.wrap ? Infinity : this.shelves.length;
    const minimum = Math.max(1, Math.min(3, Math.floor((this.width - 1) / 13)));
    let best = 0, score = 0;
    for (let width = 10; width <= 24; width += 2) {
      const columns = Math.floor((this.width - 1) / (width + 3));
      const rows = Math.min(count, Math.floor((this.height + (this.wrap ? 0 : 1)) / block(width)));
      const used = columns * (width + 2) * rows * tile(width) / (this.width * this.height);
      if (columns >= minimum && rows >= Math.min(count, 2) && used > score - 0.03) { best = width; score = Math.max(score, used); }
    }
    if (best) return best;
    let width = 10;
    while (width > 4 && block(width) > this.height + 1) width -= 2;
    return width;
  }
  private get tileWidth() { return this.coverWidth + 2; }
  // The space left after the last column is shared between the columns.
  private get tileGap() {
    const columns = this.columns;
    return columns > 1 ? Math.min(6, Math.max(1, Math.floor((this.width - 2 - columns * this.tileWidth) / (columns - 1)))) : 1;
  }
  private get notes() { return this.shelves.some(shelf => shelf.tiles.some(tile => tile.note)); }
  private get tileHeight() { return this.coverWidth / 2 + 4 + (this.notes ? 1 : 0); }
  get columns() { return Math.max(1, Math.floor(this.width / (this.tileWidth + 1))); }

  setShelves(shelves: Shelf[], wrap: boolean) {
    const id = this.selected()?.media.id;
    this.shelves = shelves; this.wrap = wrap;
    if (id) this.select(id, false);
    this.clamp(); this.draw();
  }
  selected(): Tile | undefined { return this.shelves[this.shelf]?.tiles[this.tile]; }
  select(id: string, draw = true) {
    this.shelves.forEach((shelf, shelfIndex) => {
      const index = shelf.tiles.findIndex(tile => tile.media.id === id);
      if (index >= 0) { this.shelf = shelfIndex; this.tile = index; }
    });
    if (draw) this.draw();
  }
  activate() { const tile = this.selected(); if (tile) this.onActivate?.(tile.media); }
  atTop() { return this.shelf <= this.shelves.findIndex(shelf => shelf.tiles.length) && (!this.wrap || this.tile < this.columns); }

  private clamp() {
    if (this.shelf >= this.shelves.length) this.shelf = Math.max(0, this.shelves.length - 1);
    if (!this.shelves[this.shelf]?.tiles.length) {
      const next = this.shelves.findIndex(shelf => shelf.tiles.length);
      if (next >= 0) this.shelf = next;
    }
    this.tile = Math.min(this.tile, Math.max(0, (this.shelves[this.shelf]?.tiles.length ?? 1) - 1));
  }

  move(dx: number, dy: number) {
    const shelf = this.shelves[this.shelf];
    if (!shelf) return;
    const columns = this.columns;
    if (dx) this.tile = Math.min(shelf.tiles.length - 1, Math.max(0, this.tile + dx));
    if (dy && this.wrap && this.tile + dy * columns >= 0 && this.tile + dy * columns < shelf.tiles.length) this.tile += dy * columns;
    else if (dy && this.wrap && dy > 0 && Math.floor(this.tile / columns) < Math.floor((shelf.tiles.length - 1) / columns)) this.tile = shelf.tiles.length - 1;
    else if (dy) {
      let target = this.shelf + dy;
      while (target >= 0 && target < this.shelves.length && !this.shelves[target].tiles.length) target += dy;
      if (target >= 0 && target < this.shelves.length) {
        const column = this.wrap ? this.tile % columns : this.tile - (this.starts.get(shelf.id) ?? 0);
        const next = this.shelves[target];
        const base = this.wrap ? (dy > 0 ? 0 : Math.floor((next.tiles.length - 1) / columns) * columns) : this.starts.get(next.id) ?? 0;
        this.shelf = target; this.tile = Math.min(next.tiles.length - 1, base + column);
      }
    }
    this.draw();
    if (this.wrap && Math.floor(this.tile / columns) >= Math.floor((shelf.tiles.length - 1) / columns) - 1) this.onNearEnd?.();
  }

  page(shelfId: string, direction: number) {
    const index = this.shelves.findIndex(shelf => shelf.id === shelfId);
    const shelf = this.shelves[index];
    if (!shelf) return;
    const start = Math.min(Math.max(0, shelf.tiles.length - this.columns), Math.max(0, (this.starts.get(shelf.id) ?? 0) + direction * this.columns));
    this.starts.set(shelf.id, start);
    if (index === this.shelf) this.tile = Math.min(Math.max(this.tile, start), start + this.columns - 1);
    this.draw();
  }

  protected onResize() { if (this.shelves) this.draw(); }

  draw() {
    if (!this.shelves || this.width <= 0) return;
    for (const child of this.getChildren()) { this.remove(child); child.destroyRecursively(); }
    const columns = this.columns, tileWidth = this.tileWidth, tileHeight = this.tileHeight, gap = this.tileGap;
    // Lay out every block first, then scroll so the selected tile row is whole.
    type Block = { y: number; height: number; draw: (top: number) => void; shelf: number; tiles?: number[] };
    const blocks: Block[] = [];
    let y = 0;
    this.shelves.forEach((shelf, shelfIndex) => {
      if (!this.wrap) {
        let start = this.starts.get(shelf.id) ?? 0;
        if (shelfIndex === this.shelf) {
          if (this.tile < start) start = this.tile;
          if (this.tile >= start + columns) start = this.tile - columns + 1;
        }
        start = Math.min(start, Math.max(0, shelf.tiles.length - columns));
        this.starts.set(shelf.id, start);
      }
      // A heading is drawn with the shelf's first row, so it never appears without covers.
      const heading = shelf.title && this.headings ? 1 : 0;
      const title = (top: number) => { if (heading) this.drawHeading(shelf, top); };
      if (!shelf.tiles.length) {
        blocks.push({ y, height: heading + 1, shelf: shelfIndex, draw: top => { title(top); this.add(new TextRenderable(this.ctx, { content: shelf.empty, fg: colour.muted, position: "absolute", top: top + heading, left: 2, height: 1, width: this.width - 2, truncate: true })); } });
        y += heading + 3;
        return;
      }
      const rows = this.wrap
        ? Array.from({ length: Math.ceil(shelf.tiles.length / columns) }, (_, row) => shelf.tiles.slice(row * columns, row * columns + columns).map((_, column) => row * columns + column))
        : [Array.from({ length: Math.min(columns, shelf.tiles.length) }, (_, column) => (this.starts.get(shelf.id) ?? 0) + column)];
      rows.forEach((indexes, row) => {
        const lead = row ? 0 : heading;
        blocks.push({ y, height: lead + tileHeight, shelf: shelfIndex, tiles: indexes, draw: top => {
          if (lead) title(top);
          indexes.forEach((index, column) => this.drawTile(shelf, shelfIndex, index, 1 + column * (tileWidth + gap), top + lead));
        } });
        y += lead + tileHeight;
      });
      y += 1;
    });
    const current = blocks.find(block => block.shelf === this.shelf && block.tiles?.includes(this.tile));
    if (current) {
      const top = current.y;
      if (top < this.scrollTop) this.scrollTop = top;
      if (current.y + current.height > this.scrollTop + this.height) this.scrollTop = current.y + current.height - this.height;
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, y - 1 - this.height)));
    // Start at a whole row. A partly hidden row would leave a blank band at the top.
    this.scrollTop = blocks.find(block => block.y >= this.scrollTop)?.y ?? this.scrollTop;
    for (const block of blocks) {
      if (block.y >= this.scrollTop && block.y + block.height <= this.scrollTop + this.height) block.draw(block.y - this.scrollTop);
    }
  }

  private drawHeading(shelf: Shelf, top: number) {
    const row = new BoxRenderable(this.ctx, { position: "absolute", top, left: 0, width: this.width, height: 1, flexDirection: "row", paddingX: 2 });
    row.add(new TextRenderable(this.ctx, { content: t`${bold(fg(colour.text)(shelf.title))}`, flexGrow: 1, minWidth: 0, height: 1, truncate: true, selectable: false }));
    const start = this.starts.get(shelf.id) ?? 0, columns = this.columns;
    if (!this.wrap && shelf.tiles.length > columns) {
      row.add(new Button(this.ctx, `${this.id}:${shelf.id}:previous`, icon.left, "", () => this.page(shelf.id, -1), start > 0 ? colour.accent : colour.faint));
      row.add(new TextRenderable(this.ctx, { content: ` ${start + 1}–${Math.min(shelf.tiles.length, start + columns)} of ${shelf.tiles.length} `, fg: colour.muted, height: 1, selectable: false }));
      row.add(new Button(this.ctx, `${this.id}:${shelf.id}:next`, icon.right, "", () => this.page(shelf.id, 1), start + columns < shelf.tiles.length ? colour.accent : colour.faint));
    }
    this.add(row);
  }

  private drawTile(shelf: Shelf, shelfIndex: number, index: number, left: number, top: number) {
    const tile = shelf.tiles[index];
    if (!tile) return;
    const selected = shelfIndex === this.shelf && index === this.tile;
    const box = new BoxRenderable(this.ctx, {
      id: `${this.id}:tile:${shelf.id}:${index}`, position: "absolute", left, top, width: this.tileWidth, height: this.tileHeight,
      flexDirection: "column",
      // OpenTUI enables a border whenever a border style is set.
      ...(selected ? { border: true, borderStyle: "rounded" as const, borderColor: this.focused ? colour.accent : colour.faint } : { padding: 1 }),
      onMouseDown: event => {
        if (event.button !== 0) return;
        event.stopPropagation(); this.focus(); this.shelf = shelfIndex; this.tile = index; this.draw(); this.onActivate?.(tile.media);
      },
    });
    box.add(new Cover(this.ctx, { width: this.coverWidth, height: this.coverWidth / 2, art: tile.media.artwork, glyph: glyph(tile.media) }));
    box.add(new TextRenderable(this.ctx, { content: fit(tile.caption, this.coverWidth), fg: colour.text, attributes: selected ? 1 : 0, height: 1, width: this.coverWidth, truncate: true, selectable: false }));
    box.add(new TextRenderable(this.ctx, { content: fit(tile.detail, this.coverWidth), fg: colour.muted, height: 1, width: this.coverWidth, truncate: true, selectable: false }));
    if (tile.note) box.add(new TextRenderable(this.ctx, { content: tile.note, fg: tile.noteColour ?? colour.faint, height: 1, width: this.coverWidth, truncate: true, selectable: false }));
    this.add(box);
  }

  protected onFocus() { this.draw(); }
  protected onBlur() { this.draw(); }
}

export class PeelUI {
  readonly root: BoxRenderable;
  readonly search: InputRenderable;
  readonly sidebar: ClickList;
  readonly tracks: ClickList;
  readonly grid: CoverGrid;
  private body: BoxRenderable;
  private sidebarPanel: BoxRenderable;
  private trackPanel: BoxRenderable;
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
  private brand: TextRenderable;
  private controls: BoxRenderable;
  private playerPanel: BoxRenderable;
  private playerCover: Cover;
  private layoutControls: BoxRenderable;
  private title: TextRenderable;
  private subtitle: TextRenderable;
  private indicator: TextRenderable;
  private progress: TextRenderable;
  private status: TextRenderable;
  private empty: TextRenderable;
  private buttons: Button[] = [];
  private playButton: Button;
  private favouriteButton: Button;
  private shuffleButton: Button;
  private repeatButton: Button;
  private volumeText: TextRenderable;
  private counter: TextRenderable;
  private tick = 0;
  private interval?: ReturnType<typeof setInterval>;
  private lastRows = "";
  private lastItems?: Media[];
  private lastSidebar = "";
  private lastShelves = "";
  private disposed = false;
  private focusChange = () => {
    this.sidebarPanel.borderColor = this.sidebar.focused ? colour.accent : colour.faint;
    this.trackPanel.borderColor = this.tracks.focused || this.grid.focused ? colour.accent : colour.faint;
    const searchPanel = this.renderer.root.findDescendantById("search-panel") as BoxRenderable;
    if (searchPanel) searchPanel.borderColor = this.search.focused ? colour.accent : colour.faint;
  };
  private change = () => this.update();
  private resize = () => this.resizeLayout();
  private key = (event: KeyEvent) => this.handleKey(event);

  constructor(readonly renderer: CliRenderer, readonly model: Model, private quit = () => renderer.destroy()) {
    const ctx = renderer;
    const panel = { border: true, borderStyle: "rounded" as const, borderColor: colour.faint };
    this.root = new BoxRenderable(ctx, { id: "peel", width: "100%", height: "100%", flexDirection: "column", paddingX: 1 });
    renderer.root.add(this.root);
    // The name, the search field, and the layout editor share one bar.
    const bar = new BoxRenderable(ctx, { height: 3, flexDirection: "row", gap: 2, flexShrink: 0 });
    this.brand = new TextRenderable(ctx, { content: t`${bold(fg(colour.accent)("peel"))}`, height: 1, marginTop: 1, marginLeft: 1, flexShrink: 0, selectable: false });
    bar.add(this.brand);
    const searchBox = new BoxRenderable(ctx, { id: "search-panel", ...panel, title: `${icon.search} Search Apple Music  / or Ctrl+F`, titleColor: colour.muted, height: 3, paddingX: 1, flexGrow: 1, minWidth: 0 } as any);
    this.search = new InputRenderable(ctx, { id: "search", width: "100%", placeholder: "Type a song, album, or artist and press Enter", textColor: colour.text, placeholderColor: colour.faint, backgroundColor: "transparent", focusedBackgroundColor: "transparent" } as any);
    this.search.on("enter", () => { void this.model.search(this.search.value); this.tracks.focus(); });
    searchBox.add(this.search); bar.add(searchBox);
    const layout = this.button("layout", icon.layout, "Layout  l", () => this.toggleLayout());
    layout.marginTop = 1; layout.marginRight = 1; layout.flexShrink = 0;
    bar.add(layout);
    this.root.add(bar);

    this.body = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1, minHeight: 0, gap: 1 });
    this.sidebarPanel = new BoxRenderable(ctx, { id: "sidebar-panel", ...panel, width: 28, flexShrink: 0, paddingY: 0 });
    this.sidebar = new ClickList(renderer, "sidebar", 1);
    this.sidebarPanel.add(this.sidebar); this.body.add(this.sidebarPanel);
    this.trackPanel = new BoxRenderable(ctx, { id: "tracks-panel", ...panel, title: "Home", flexGrow: 1, minWidth: 0, minHeight: 0 });

    this.header = new BoxRenderable(ctx, { id: "collection-header", flexDirection: "row", gap: 2, paddingX: 1, paddingY: 1, height: 10, flexShrink: 0 });
    this.headerCover = new Cover(ctx, { width: 16, height: 8 });
    const info = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0, justifyContent: "flex-end" });
    this.headerName = new TextRenderable(ctx, { fg: colour.text, attributes: 1, height: 1, truncate: true, selectable: false });
    this.headerArtist = new TextRenderable(ctx, { id: "collection-artist", fg: colour.accent, height: 1, truncate: true, selectable: false,
      onMouseDown: event => { const detail = model.detail; if (event.button === 0 && detail?.type.includes("albums")) { event.stopPropagation(); void model.openArtist(detail); } } });
    this.headerMeta = new TextRenderable(ctx, { fg: colour.muted, height: 2, truncate: true, selectable: false });
    const actions = new BoxRenderable(ctx, { flexDirection: "row", gap: 3, height: 1 });
    actions.add(this.button("play-collection", icon.play, "Play", () => { const first = this.model.items[0]; if (first) void this.model.activate(first); }));
    actions.add(this.button("back", icon.back, "Back  esc", () => this.back()));
    for (const item of [this.headerName, this.headerArtist, this.headerMeta, actions]) info.add(item);
    this.header.add(this.headerCover); this.header.add(info);
    // The header and the song list. Album pages stack them; wide artist pages put the top songs beside the artist.
    this.top = new BoxRenderable(ctx, { id: "top", flexDirection: "column", flexGrow: 1, minHeight: 0, minWidth: 0, flexShrink: 0 });
    this.top.add(this.header);
    this.songs = new BoxRenderable(ctx, { id: "songs", flexDirection: "column", flexGrow: 1, minHeight: 0, minWidth: 0 });
    this.empty = new TextRenderable(ctx, { id: "empty", content: "Connecting...", fg: colour.muted, height: 2, paddingX: 1 });
    this.songs.add(this.empty);
    this.section = new TextRenderable(ctx, { id: "top-songs", content: "", height: 1, marginLeft: 1, flexShrink: 0, selectable: false });
    this.songs.add(this.section);
    this.tracks = new ClickList(renderer, "tracks");
    this.songs.add(this.tracks);
    this.top.add(this.songs);
    this.trackPanel.add(this.top);
    this.grid = new CoverGrid(renderer, "grid");
    this.grid.onActivate = media => void this.model.activate(media);
    this.grid.onNearEnd = () => { if (this.model.more && !this.model.loading) void this.model.load(true); };
    this.trackPanel.add(this.grid);
    this.layoutControls = new BoxRenderable(ctx, { height: 2, flexDirection: "row", gap: 3, paddingX: 1 });
    this.layoutControls.add(this.button("move-up", "\u{F005D}", "Up  K", () => this.reorder(-1)));
    this.layoutControls.add(this.button("move-down", "\u{F0045}", "Down  J", () => this.reorder(1)));
    this.layoutControls.add(this.button("hide", "\u{F0208}", "Hide/show  h", () => this.hideSelected()));
    this.trackPanel.add(this.layoutControls);
    this.counter = new TextRenderable(ctx, { id: "more", content: "", fg: colour.faint, height: 1, marginLeft: 1, selectable: false,
      onMouseDown: event => { if (event.button === 0 && model.more) { event.stopPropagation(); void model.load(true); } } });
    this.trackPanel.add(this.counter); this.body.add(this.trackPanel); this.root.add(this.body);

    this.playerPanel = new BoxRenderable(ctx, { id: "player-panel", ...panel, paddingX: 1, height: 6, flexShrink: 0, flexDirection: "row", gap: 2 });
    this.playerCover = new Cover(ctx, { id: "player-cover", width: 8, height: 4, glyph: "\u{F075A}" });
    this.playerPanel.add(this.playerCover);
    const deck = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0 });
    const nowPlaying = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2 });
    this.title = new TextRenderable(ctx, { id: "now-playing", fg: colour.text, attributes: 1, flexShrink: 1, minWidth: 0, height: 1, truncate: true, selectable: false });
    this.favouriteButton = this.button("favourite", icon.heartOutline, "f", () => void model.toggleFavourite(), colour.faint);
    this.indicator = new TextRenderable(ctx, { id: "playback-indicator", fg: colour.accent, height: 1, flexGrow: 1, minWidth: 0, selectable: false, truncate: true,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); void model.bars(); } } });
    nowPlaying.add(this.title); nowPlaying.add(this.favouriteButton); nowPlaying.add(this.indicator); deck.add(nowPlaying);
    this.subtitle = new TextRenderable(ctx, { id: "now-playing-artist", fg: colour.muted, height: 1, width: "100%", truncate: true, selectable: false,
      onMouseDown: event => { const song = model.playing; if (event.button === 0 && song) { event.stopPropagation(); void model.openArtist(song); this.focusContent(); } } });
    deck.add(this.subtitle);
    this.progress = new TextRenderable(ctx, { id: "seek", content: "", fg: colour.accent, height: 1, width: "100%", selectable: false, onMouseDown: event => this.seekClick(event) });
    deck.add(this.progress);
    this.controls = new BoxRenderable(ctx, { id: "controls", height: 1, flexDirection: "row", gap: 2 });
    this.controls.add(this.button("previous", icon.previous, "p", () => void model.skip(-1)));
    this.playButton = this.button("play-pause", icon.play, "space", () => void model.act("/playback/toggle"));
    this.controls.add(this.playButton);
    this.controls.add(this.button("next", icon.next, "n", () => void model.skip(1)));
    this.controls.add(new TextRenderable(ctx, { content: " ", width: 1, height: 1 }));
    this.shuffleButton = this.button("shuffle", icon.shuffleOff, "s", () => void model.act("/playback/shuffle/toggle"), colour.faint);
    this.repeatButton = this.button("repeat", icon.repeatOff, "r", () => void model.act("/playback/repeat/toggle"), colour.faint);
    this.controls.add(this.shuffleButton); this.controls.add(this.repeatButton);
    this.controls.add(new TextRenderable(ctx, { content: " ", width: 1, height: 1 }));
    this.controls.add(this.button("volume-down", icon.volumeDown, "-", () => void model.volume(-0.05)));
    this.volumeText = new TextRenderable(ctx, { id: "volume", content: "50%", fg: colour.muted, height: 1, selectable: false });
    this.controls.add(this.volumeText);
    this.controls.add(this.button("volume-up", icon.volumeUp, "+", () => void model.volume(0.05)));
    deck.add(this.controls);
    this.playerPanel.add(deck); this.root.add(this.playerPanel);

    const footer = new BoxRenderable(ctx, { height: 1, flexDirection: "row", paddingX: 1, gap: 2 });
    this.status = new TextRenderable(ctx, { id: "status", content: model.status, fg: colour.muted, height: 1, flexGrow: 1, minWidth: 0, truncate: true });
    footer.add(this.status);
    footer.add(new TextRenderable(ctx, { content: "? keys  q quit", fg: colour.faint, height: 1, flexShrink: 0, selectable: false }));
    this.root.add(footer);
    model.on("change", this.change); renderer.on("resize", this.resize); renderer.on("focused_renderable", this.focusChange); renderer.keyInput.on("keypress", this.key);
    this.resizeLayout(); this.update(); this.content().focus();
  }

  private button(id: string, glyph: string, hint: string, action: () => void, tint = colour.accent) {
    const button = new Button(this.renderer, id, glyph, hint, action, tint);
    this.buttons.push(button);
    return button;
  }

  private content() {
    const display = this.model.layout ? "list" : this.model.display;
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
    this.sidebarPanel.width = narrow ? "100%" : 28;
    this.sidebarPanel.height = narrow ? height < 28 ? 3 : 5 : "100%";
    this.playerCover.visible = width >= 60;
    this.brand.visible = width >= 60;
    for (const button of this.buttons) { button.showHint = width >= 100 || ["play-collection", "back", "move-up", "move-down", "hide"].includes(button.id) || button.id === "layout" && width >= 76; button.paint(); }
    this.sizeHeader();
    this.drawPlayback();
  }

  // Places the header, the song list, and the shelves for the current view.
  private arrange(display: string) {
    const model = this.model, width = this.renderer.terminalWidth;
    const sections = display === "sections", songs = model.items.length > 0;
    const header = !model.layout && !!model.detail;
    // The panel's inner width, beside the sidebar on wide terminals.
    const inner = width - (width < 76 ? 4 : 33);
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
    const columns: Column[] | undefined = model.layout || !songs ? undefined
      : model.view.startsWith("artist:") ? ["album"]
      : detail?.type.includes("albums") ? (model.items.some(item => item.artist && item.artist !== detail.artist) ? ["artist"] : [])
      : ["artist", "album"];
    const table = !!columns && (beside ? inner - headerWidth : inner) >= 90;
    this.tracks.columns = table ? columns : undefined;
    this.tracks.rowHeight = table || detail && !model.layout ? 1 : 2;

    if (!sections) {
      this.top.flexGrow = 1; this.top.height = "auto"; this.tracks.flexGrow = 1; this.tracks.height = "auto";
      return;
    }
    // Top songs and search songs take a few rows and scroll. The shelves below take the rest.
    const panel = this.renderer.terminalHeight - 12;
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

  private shelves(): Shelf[] {
    const model = this.model;
    if (model.display === "grid") {
      const kind = model.view === "artists" ? "artists" : "albums";
      return [{ id: kind, title: "", empty: model.loading ? `Loading your ${kind}...` : `No ${kind} in your library yet.`,
        tiles: model.items.map(item => ({ media: item, caption: item.name, detail: kind === "artists" ? item.genre ?? "" : item.artist })) }];
    }
    if (model.display === "sections") {
      const shelves = model.shelves.filter(shelf => shelf.items.length).map(shelf => ({ id: shelf.id, title: shelf.title, empty: "",
        tiles: shelf.items.map(item => ({ media: item, caption: release(item.name),
          detail: shelf.id === "artists" ? item.genre ?? "" : shelf.id === "albums" || shelf.id === "appears-on-albums" ? item.artist : item.releaseDate?.slice(0, 4) ?? "" })) }));
      return shelves.length ? shelves : [{ id: "none", title: "", tiles: [], empty: model.loading ? "Loading albums..." : "No albums on Apple Music." }];
    }
    const now = today();
    return [
      { id: "recent", title: "Recently played", empty: model.homeLoading.recent ? "Loading..." : "Albums and playlists you play appear here.",
        tiles: model.home.recent.map(item => ({ media: item, caption: item.name, detail: item.artist || (item.type.includes("playlist") ? "Playlist" : "") })) },
      { id: "releases", title: "New from your favourite artists", empty: model.homeLoading.releases ? "Checking your favourite artists for new releases..." : "No releases from your favourite artists in the last four months.",
        tiles: model.home.releases.map(item => {
          const upcoming = (item.releaseDate ?? "") > now;
          return { media: item, caption: item.name, detail: item.artist, note: `${upcoming ? "Out " : ""}${releaseDay(item.releaseDate)}`, noteColour: upcoming ? colour.soon : undefined };
        }) },
    ];
  }

  private update() {
    if (this.disposed) return;
    const model = this.model;
    const display = model.layout ? "list" : model.display;
    this.status.content = model.status;
    const artist = display === "sections";
    this.sizeHeader();
    this.trackPanel.title = model.layout ? "Layout  choose a row, then move or hide it" : model.view.startsWith("artist:") ? "Artist" : model.detail ? (model.detail.type.includes("playlist") ? "Playlist" : "Album") : model.title;
    this.layoutControls.visible = model.layout;
    this.arrange(display);
    this.empty.visible = display === "list" && !model.layout && !model.items.length;
    this.empty.content = model.loading ? "Loading..." : model.view === "queue" && !model.connected ? "Cider is not running yet. The queue starts with your first song."
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
        this.headerMeta.content = [detail.releaseDate?.slice(0, 4), count ? `${count} songs` : "", seconds && !model.more ? `${Math.round(seconds / 60)} min` : ""].filter(Boolean).join("   ");
      }
    }
    if (this.content() === this.grid && this.tracks.focused) this.grid.focus();
    if (this.content() === this.tracks && this.grid.focused) this.tracks.focus();

    const nav = model.navigation();
    const sidebarKey = JSON.stringify([nav.map(item => [item.id, item.name]), model.view]);
    if (sidebarKey !== this.lastSidebar) {
      this.lastSidebar = sidebarKey;
      const glyph = (id: string) => id === "home" ? icon.home : id === "favourites" ? icon.heart : id === "songs" ? icon.songs : id === "albums" ? icon.album : id === "artists" ? icon.artist : id === "queue" ? icon.queue : icon.playlist;
      this.sidebar.setRows(nav.map(item => ({
        id: item.id, key: item.id, name: item.name, lead: glyph(item.id), active: item.id === model.view,
        leadColour: item.id === "favourites" ? colour.heart : item.id === model.view ? colour.accent : colour.faint,
        activate: () => { void model.open(item.id); this.focusContent(); },
      })));
      this.sidebar.selectKey(model.view);
    }

    if (display !== "list") {
      const shelves = this.shelves();
      const key = JSON.stringify([display, shelves.map(shelf => [shelf.id, shelf.empty, shelf.tiles.map(tile => [tile.media.id, tile.detail, tile.note])])]);
      if (key !== this.lastShelves) { this.lastShelves = key; this.grid.setShelves(shelves, display === "grid"); }
      if (artist && !this.grid.focused && !this.tracks.focused && !this.search.focused && !this.sidebar.focused) this.content().focus();
    }
    const playing = model.playback.nowPlaying;
    // Loading a page replaces the items array, so comparing the array is enough to notice new songs.
    const rowsKey = JSON.stringify([model.layout, model.layout ? model.entries(true).map(item => [item.id, item.name, item.hidden]) : model.view, playing?.name, playing?.artistName, this.tracks.columns, this.tracks.rowHeight]);
    if (rowsKey !== this.lastRows || model.items !== this.lastItems) {
      this.lastRows = rowsKey; this.lastItems = model.items;
      if (model.layout) this.tracks.setRows(model.entries(true).map(item => ({
        id: item.id, lead: item.hidden ? "\u{F0209}" : "\u{F0208}", leadColour: item.hidden ? colour.faint : colour.accent,
        name: item.name, description: item.hidden ? "Hidden" : "Shown", activate: () => {},
      })));
      else this.tracks.setRows(model.items.map((item, index) => {
        const active = !!playing && item.name === playing.name && item.artist === playing.artistName;
        const collection = item.type.includes("albums") || item.type.includes("playlists") || item.type.includes("artists");
        return {
          id: String(index), key: item.id, active,
          lead: active ? icon.play : collection ? glyph(item) : String(index + 1).padStart(String(model.items.length).length, " "),
          leadColour: active ? colour.accent : colour.faint,
          name: item.name, artist: item.artist, album: item.album, right: item.duration ? duration(item.duration) : undefined,
          description: item.type.includes("artists") ? ["Artist", item.genre].filter(Boolean).join("  /  ")
            : [item.artist, collection ? (item.type.includes("playlist") ? "Playlist" : "Album") : item.album].filter(Boolean).join("  /  "),
          activate: () => void model.activate(item),
        };
      }));
    }
    this.counter.visible = model.layout || display !== "home" && !artist;
    this.counter.content = model.layout ? "Layout changes save automatically. Escape closes." : model.more ? `${model.items.length} loaded  ${display === "grid" ? "scroll down" : "m"} for more` : model.items.length ? `${model.items.length} ${display === "grid" ? model.view : "items"}` : "";
    this.drawPlayback();
  }

  private progressCells(state = this.model.playback) {
    const width = this.progress.width || this.renderer.terminalWidth - 16;
    return Math.max(1, width - duration(state.time.currentTime).length - duration(state.time.duration).length - 2);
  }

  drawPlayback() {
    const state = this.model.playback;
    const connected = this.model.connected;
    const song = state.nowPlaying;
    this.title.content = song ? song.name ?? "Untitled" : "Nothing playing";
    this.subtitle.content = song ? [song.artistName, song.albumName].filter(Boolean).join("  /  ") : this.model.starting ? "Starting Cider..." : "Choose a song to start";
    this.playerCover.setArt(song?.artwork?.url);
    const favourite = this.model.favourite;
    this.favouriteButton.visible = !!song;
    this.favouriteButton.set(favourite ? icon.heart : icon.heartOutline, "f", favourite ? colour.heart : colour.faint);
    const frames = ["▁▅▃▇▂▆", "▃▇▁▅▆▂", "▆▃▅▂▇▁", "▂▆▇▁▃▅"];
    const playing = connected && state.state === "playing";
    const label = !connected ? (this.model.starting ? "Starting" : "Stopped") : playing ? "Playing" : state.state === "paused" ? "Paused" : "Stopped";
    this.indicator.content = t`${fg(colour.faint)(label)}${this.model.preferences.playbackBars ? fg(playing ? colour.accent : colour.faint)(" " + (playing ? frames[this.tick % frames.length] : "▁▁▁▁▁▁")) : ""}`;
    this.playButton.set(playing ? icon.pause : icon.play);
    this.shuffleButton.set(state.shuffleMode ? icon.shuffle : icon.shuffleOff, "s", state.shuffleMode ? colour.accent : colour.faint);
    this.repeatButton.set(state.repeatMode === "one" ? icon.repeatOne : state.repeatMode === "all" ? icon.repeat : icon.repeatOff, "r", state.repeatMode === "none" ? colour.faint : colour.accent);
    this.volumeText.content = `${Math.round(state.volume * 100)}%`;
    const cells = this.progressCells(state);
    const ratio = state.time.duration > 0 ? Math.min(1, Math.max(0, state.time.currentTime / state.time.duration)) : 0;
    const filled = Math.floor(ratio * cells);
    this.progress.content = t`${fg(colour.muted)(duration(state.time.currentTime))} ${fg(colour.accent)("━".repeat(filled))}${fg(colour.faint)("─".repeat(cells - filled))} ${fg(colour.muted)(duration(state.time.duration))}`;
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
    const cells = this.progressCells();
    const ratio = Math.max(0, Math.min(1, (event.x - this.progress.x - start) / Math.max(1, cells - 1)));
    void this.model.act("/playback/seek", { position: maximum * ratio });
  }
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
  // The highlighted song, album, or artist, otherwise the playing song.
  private openArtist() {
    let item: Media | undefined;
    if (this.grid.focused) item = this.grid.selected()?.media;
    else if (this.tracks.focused && !this.model.layout) item = this.model.items[Number(this.tracks.selectedId())];
    item ??= this.model.playing;
    if (item) { void this.model.openArtist(item); this.focusContent(); }
  }
  private toggleLayout() { this.model.layout = !this.model.layout; this.update(); this.focusContent(); }
  private reorder(direction: number) { const id = this.tracks.selectedId(); if (id && this.model.layout) void this.model.reorder(id, direction); }
  private hideSelected() { const id = this.tracks.selectedId(); if (id && this.model.layout) void this.model.hide(id); }

  private handleKey(key: KeyEvent) {
    if (key.eventType === "release") return;
    const model = this.model;
    const grid = this.grid.focused;
    let action: (() => void) | undefined;
    if (key.ctrl && key.name === "c") action = this.quit;
    else if (key.ctrl && key.name === "f") action = () => this.search.focus();
    else if (key.ctrl && key.name === "p") action = () => void model.act("/playback/toggle");
    else if (key.name === "tab") action = () => {
      const artist = !model.layout && model.display === "sections";
      const targets = [this.search, this.sidebar, ...artist ? [this.tracks, this.grid].filter(target => target.visible) : [this.content()]];
      const index = targets.findIndex(target => target.focused);
      targets[(index + (key.shift ? targets.length - 1 : 1)) % targets.length].focus();
    };
    else if (key.name === "escape") action = () => {
      if (model.layout) { model.layout = false; this.update(); }
      else if (!this.search.focused && this.back()) return;
      this.focusContent();
    };
    else if (this.search.focused) return;
    else if (key.name === "backspace") action = () => void this.back();
    else if (key.name === "/") action = () => this.search.focus();
    else if (key.name === "q") action = this.quit;
    else if (key.name === "l") action = () => this.toggleLayout();
    else if (key.name === "?" || key.sequence === "?") action = () => { model.status = "Space play/pause  p/n skip  ←/→ seek (Shift in grids)  +/- volume  f favourite  a artist  s shuffle  r repeat  / search  Esc back  l layout  m more  v bars  q quit"; model.changed(); };
    else if (model.layout && (key.name === "j" || key.name === "k") && key.shift) action = () => this.reorder(key.name === "j" ? 1 : -1);
    else if (model.layout && key.name === "h") action = () => this.hideSelected();
    else if (key.name === "a") action = () => this.openArtist();
    else if (model.display === "sections" && grid && ["up", "k"].includes(key.name) && this.grid.atTop() && this.tracks.visible) action = () => this.tracks.focus();
    else if (model.display === "sections" && this.tracks.focused && ["down", "j"].includes(key.name) && this.tracks.atEnd()) action = () => this.grid.focus();
    else if (grid && ["up", "down", "j", "k"].includes(key.name)) action = () => this.grid.move(0, ["up", "k"].includes(key.name) ? -1 : 1);
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
