import { BoxRenderable, TextRenderable, InputRenderable, ImageRenderable, RGBA, StyledText, t, fg, bold, type CliRenderer, type KeyEvent, type MouseEvent, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { shortVersion } from "./update";
import { Model, sorts, type Sort } from "./model";
import { duration, type Media } from "./types";
import { cover, largeCover, largeCoverSize } from "./artwork";
import { colour, icon } from "./theme";
import { LyricsSource } from "./lyrics";
import { LyricsView } from "./lyrics-view";

interface Row { id: string; key?: string; lead?: string; leadColour?: string; name: string; loved?: boolean; faint?: boolean; description?: string; artist?: string; album?: string; right?: string; active?: boolean; activate: () => void }
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

// A box over other content that blanks what is under it without painting a background, so the
// terminal's own background and translucency show through, as everywhere else in Peel.
const unpainted = RGBA.fromValues(0, 0, 0, 0);
class ClearBox extends BoxRenderable {
  protected renderSelf(buffer: OptimizedBuffer) {
    const ink = RGBA.fromHex(colour.text);
    for (let y = Math.max(0, this.y); y < Math.min(buffer.height, this.y + this.height); y++)
      for (let x = Math.max(0, this.x); x < Math.min(buffer.width, this.x + this.width); x++) buffer.setCell(x, y, " ", ink, unpainted);
    super.renderSelf(buffer);
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
  onNearEnd?: () => void;

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
    // The next page loads while the last screen of rows is still ahead.
    if (this.rows.length && this.index >= this.rows.length - 1 - this.page) this.onNearEnd?.();
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
      line.add(new TextRenderable(this.ctx, { content: titled(row.name, row.loved, row.active ? colour.accent : row.faint ? colour.faint : colour.text), flexGrow: 1, minWidth: 0, height: 1, truncate: true, selectable: false }));
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
    const line = (top: number, cells: { lead: string; leadColour?: string; name: string; loved?: boolean; nameColour: string; artist?: string; album?: string; right: string; tint: string }, options: Record<string, unknown> = {}) => {
      const box = new BoxRenderable(this.ctx, { position: "absolute", top, width: "100%", height: 1, paddingX: 1, flexDirection: "row", gap, ...options });
      box.add(new TextRenderable(this.ctx, { content: cells.lead.padStart(lead), fg: cells.leadColour ?? colour.faint, width: lead, height: 1, flexShrink: 0, selectable: false }));
      box.add(new TextRenderable(this.ctx, { content: titled(fit(cells.name, widths.name - (cells.loved ? 2 : 0)), cells.loved, cells.nameColour), width: widths.name, height: 1, flexShrink: 0, selectable: false }));
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
        lead: row.lead ?? "", leadColour: row.leadColour, name: row.name, loved: row.loved, nameColour: row.active ? colour.accent : colour.text,
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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// A song title, after a heart when the song is a favourite.
function titled(name: string, loved: boolean | undefined, tint: string) {
  return loved ? t`${fg(colour.heart)(icon.heart)} ${fg(tint)(name)}` : t`${fg(tint)(name)}`;
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
  private filterBar: BoxRenderable;
  readonly filterInput: InputRenderable;
  private sortButton: Button;
  private directionButton: Button;
  private lovedButton: Button;
  private controls: BoxRenderable;
  private playerPanel: BoxRenderable;
  private playerCover: Cover;
  private sidebarHints: TextRenderable;
  private sidebarFooter: BoxRenderable;
  private editButton: Button;
  private editingSidebar = false;
  private title: TextRenderable;
  private subtitle: TextRenderable;
  private indicator: TextRenderable;
  private progress: TextRenderable;
  private status: TextRenderable;
  private empty: TextRenderable;
  private buttons: Button[] = [];
  private playButton: Button;
  private favouriteButton: Button;
  private albumFavouriteButton: Button;
  private shuffleButton: Button;
  private repeatButton: Button;
  private volumeText: TextRenderable;
  private hints: TextRenderable;
  private lastRows = "";
  private lastView = "";
  private lastItems?: Media[];
  private lastSidebar = "";
  private lastShelves = "";
  private disposed = false;
  private coverView?: BoxRenderable;
  private lyrics: LyricsView;
  private lyricsButton: Button;
  private devicesButton: Button;
  // The devices popup above the player, and the pairing prompt.
  private devicesView?: BoxRenderable;
  private devicesBackdrop?: BoxRenderable;
  private devicesList?: ClickList;
  private devicesKey = "";
  private focusBefore?: { focus(): void; isDestroyed?: boolean } | null;
  private pairingView?: BoxRenderable;
  private pairingKey = "";
  private forgetAsked = 0;
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
    const searchPanel = this.renderer.root.findDescendantById("search-panel") as BoxRenderable;
    if (searchPanel) searchPanel.borderColor = this.search.focused ? colour.accent : colour.faint;
  };
  private change = () => this.update();
  private resize = () => this.resizeLayout();
  private key = (event: KeyEvent) => this.handleKey(event);

  constructor(readonly renderer: CliRenderer, readonly model: Model, private quit = () => renderer.destroy(), lyrics?: LyricsSource) {
    const ctx = renderer;
    const panel = { border: true, borderStyle: "rounded" as const, borderColor: colour.faint };
    this.root = new BoxRenderable(ctx, { id: "peel", width: "100%", height: "100%", flexDirection: "column", paddingX: 1 });
    renderer.root.add(this.root);
    // The search field spans the window, from the sidebar's left edge to the content's right edge.
    const bar = new BoxRenderable(ctx, { height: 3, flexDirection: "row", flexShrink: 0 });
    const searchBox = new BoxRenderable(ctx, { id: "search-panel", ...panel, title: `${icon.search} Search Apple Music  / or Ctrl+F`, titleColor: colour.muted, height: 3, paddingX: 1, flexGrow: 1, flexBasis: 0, minWidth: 0 } as any);
    this.search = new InputRenderable(ctx, { id: "search", width: "100%", placeholder: "Type a song, album, or artist and press Enter", textColor: colour.text, placeholderColor: colour.faint, backgroundColor: "transparent", focusedBackgroundColor: "transparent" } as any);
    this.search.on("enter", () => { void this.model.search(this.search.value); this.tracks.focus(); });
    searchBox.add(this.search); bar.add(searchBox);
    this.root.add(bar);

    this.body = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1, minHeight: 0, gap: 1 });
    this.sidebarPanel = new BoxRenderable(ctx, { id: "sidebar-panel", ...panel, width: 28, flexShrink: 0, paddingY: 0 });
    this.sidebar = new ClickList(renderer, "sidebar", 1);
    this.sidebarPanel.add(this.sidebar);
    // Editing shows the hidden entries, so they can be shown again. Click Edit, or press e with the sidebar focused.
    this.sidebarFooter = new BoxRenderable(ctx, { id: "sidebar-footer", flexDirection: "column", paddingX: 1, flexShrink: 0 });
    this.sidebarHints = new TextRenderable(ctx, { id: "sidebar-hints", content: t`${fg(colour.muted)("⏎")} ${fg(colour.faint)("show or hide")}  ${fg(colour.muted)("⇧↑↓")} ${fg(colour.faint)("move")}`, height: 1, visible: false, selectable: false });
    this.editButton = this.button("sidebar-edit", icon.edit, "Edit  e", () => this.editSidebar(!this.editingSidebar), colour.faint);
    this.sidebarFooter.add(this.sidebarHints); this.sidebarFooter.add(this.editButton);
    this.sidebarPanel.add(this.sidebarFooter); this.body.add(this.sidebarPanel);
    this.trackPanel = new BoxRenderable(ctx, { id: "tracks-panel", ...panel, title: "Home", flexGrow: 1, minWidth: 0, minHeight: 0 });

    this.header = new BoxRenderable(ctx, { id: "collection-header", flexDirection: "row", gap: 2, paddingX: 1, paddingY: 1, height: 10, flexShrink: 0 });
    this.headerCover = new Cover(ctx, { id: "collection-cover", width: 16, height: 8 });
    const info = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0, justifyContent: "flex-end" });
    this.headerName = new TextRenderable(ctx, { fg: colour.text, attributes: 1, height: 1, truncate: true, selectable: false });
    this.headerArtist = new TextRenderable(ctx, { id: "collection-artist", fg: colour.accent, height: 1, truncate: true, selectable: false,
      onMouseDown: event => { const detail = model.detail; if (event.button === 0 && detail?.type.includes("albums")) { event.stopPropagation(); void model.openArtist(detail); } } });
    this.headerMeta = new TextRenderable(ctx, { fg: colour.muted, height: 2, truncate: true, selectable: false });
    const actions = new BoxRenderable(ctx, { flexDirection: "row", gap: 3, height: 1 });
    actions.add(this.button("play-collection", icon.play, "Play", () => { const first = this.model.items[0]; if (first) void this.model.activate(first); }));
    this.albumFavouriteButton = this.button("favourite-album", icon.heartOutline, "Favourite  l", () => void model.toggleAlbumFavourite(), colour.faint);
    actions.add(this.albumFavouriteButton);
    actions.add(this.button("back", icon.back, "Back  esc", () => this.back()));
    for (const item of [this.headerName, this.headerArtist, this.headerMeta, actions]) info.add(item);
    this.headerCover.onMouseDown = event => { const detail = model.detail; if (event.button === 0 && detail) { event.stopPropagation(); this.showCover(detail.artwork, detail.name, detail.artist || detail.genre || ""); } };
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

    this.playerPanel = new BoxRenderable(ctx, { id: "player-panel", ...panel, paddingX: 1, height: 6, flexShrink: 0, flexDirection: "row", gap: 2 });
    this.playerCover = new Cover(ctx, { id: "player-cover", width: 8, height: 4, glyph: "\u{F075A}" });
    this.playerCover.onMouseDown = event => { const song = model.playback.nowPlaying; if (event.button === 0 && song) { event.stopPropagation(); this.showCover(song.artwork?.url, song.albumName ?? song.name ?? "", song.artistName ?? ""); } };
    this.playerPanel.add(this.playerCover);
    const deck = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, minWidth: 0 });
    const nowPlaying = new BoxRenderable(ctx, { flexDirection: "row", height: 1, gap: 2 });
    this.title = new TextRenderable(ctx, { id: "now-playing", fg: colour.text, attributes: 1, flexShrink: 1, minWidth: 0, height: 1, truncate: true, selectable: false });
    this.favouriteButton = this.button("favourite", icon.heartOutline, "f", () => void model.toggleFavourite(), colour.faint);
    this.indicator = new TextRenderable(ctx, { id: "playback-indicator", fg: colour.faint, height: 1, flexGrow: 1, minWidth: 0, selectable: false, truncate: true });
    // The devices button sits at the top right of the player, under the popup it opens.
    this.devicesButton = this.button("devices", icon.devices, "d", () => this.toggleDevices(), colour.faint);
    this.devicesButton.flexShrink = 0;
    nowPlaying.add(this.title); nowPlaying.add(this.favouriteButton); nowPlaying.add(this.indicator); nowPlaying.add(this.devicesButton); deck.add(nowPlaying);
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
    this.controls.add(new TextRenderable(ctx, { content: " ", width: 1, height: 1 }));
    this.lyricsButton = this.button("lyrics-toggle", icon.lyrics, "y", () => this.toggleLyrics(), colour.faint);
    this.controls.add(this.lyricsButton);

    deck.add(this.controls);
    this.playerPanel.add(deck); this.root.add(this.playerPanel);

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
    this.sidebarPanel.width = narrow ? "100%" : 28;
    this.sidebarPanel.height = narrow ? height < 28 ? 3 : 5 : "100%";
    this.playerCover.visible = width >= 60;
    this.sidebarFooter.visible = !narrow;
    for (const button of this.buttons) { button.showHint = width >= 100 || ["play-collection", "favourite-album", "back", "sidebar-edit"].includes(button.id); button.paint(); }
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
    const shown = this.lyricsWanted && !this.coverView;
    const beside = width >= 110;
    const panel = this.lyrics.panel;
    panel.width = beside ? Math.max(34, Math.min(56, Math.floor(width * 0.3))) : "auto";
    panel.flexGrow = beside ? 0 : 1; panel.flexShrink = 0;
    this.trackPanel.visible = beside || !shown;
    this.lyricsButton.set(icon.lyrics, "y", shown ? colour.accent : colour.faint);
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
    const inner = width - (width < 76 ? 4 : 33) - lyrics;
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
    const columns: Column[] | undefined = !songs ? undefined
      : model.view.startsWith("artist:") ? ["album"]
      : detail?.type.includes("albums") ? (model.items.some(item => item.artist && item.artist !== detail.artist) ? ["artist"] : [])
      : ["artist", "album"];
    const table = !!columns && (beside ? inner - headerWidth : inner) >= 90;
    this.tracks.columns = table ? columns : undefined;
    this.tracks.rowHeight = table || detail ? 1 : 2;

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
    this.drawDevices();
    this.drawPairing();
    const display = model.display;
    this.status.content = model.status;
    const artist = display === "sections";
    this.sizeHeader();
    this.trackPanel.title = model.view.startsWith("artist:") ? "Artist" : model.detail ? (model.detail.type.includes("playlist") ? "Playlist" : "Album") : model.title;
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
      this.albumFavouriteButton.set(loved ? icon.heart : icon.heartOutline, "Favourite  l", loved ? colour.heart : colour.faint);
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
      const glyph = (id: string) => id === "home" ? icon.home : id === "favourites" ? icon.heart : id === "songs" ? icon.songs : id === "albums" ? icon.album : id === "artists" ? icon.artist : id === "queue" ? icon.queue : id === "settings" ? icon.settings : icon.playlist;
      // Home cannot be hidden, so it keeps its own glyph while editing.
      const editable = (id: string) => editing && id !== "home";
      this.sidebar.setRows(nav.map(item => ({
        id: item.id, key: item.id, name: item.name, faint: item.hidden,
        lead: editable(item.id) ? item.hidden ? icon.hidden : icon.shown : glyph(item.id), active: !editing && item.id === model.view,
        leadColour: item.hidden ? colour.faint : editable(item.id) ? colour.muted : item.id === "favourites" ? colour.heart : item.id === model.view ? colour.accent : colour.faint,
        activate: () => {
          if (editable(item.id)) void model.hide(item.id);
          else if (!editing) { void model.open(item.id); this.focusContent(); }
        },
      })));
      // Moving an entry keeps it selected. Opening a view selects that view.
      if (model.view !== this.lastView) { this.lastView = model.view; this.sidebar.selectKey(model.view); }
    }

    if (display !== "list") {
      const shelves = this.shelves();
      const key = JSON.stringify([display, shelves.map(shelf => [shelf.id, shelf.empty, shelf.tiles.map(tile => [tile.media.id, tile.detail, tile.note])])]);
      if (key !== this.lastShelves) { this.lastShelves = key; this.grid.setShelves(shelves, display === "grid"); }
      if (artist && !this.grid.focused && !this.tracks.focused && !this.search.focused && !this.sidebar.focused) this.content().focus();
    }
    const playing = model.playback.nowPlaying;
    // Loading a page replaces the items array, so comparing the array is enough to notice new songs.
    const rowsKey = JSON.stringify([model.view, playing?.name, playing?.artistName, this.tracks.columns, this.tracks.rowHeight, model.lovedRevision, model.preferences.heartsInFavourites]);
    const shown = model.shown;
    if (model.view === "settings") {
      const rows = this.settingsRows(), key = JSON.stringify(["settings", rows.map(row => [row.id, row.right, row.description])]);
      if (key !== this.lastRows) { this.lastRows = key; this.lastItems = undefined; this.tracks.setRows(rows); }
    } else if (rowsKey !== this.lastRows || shown !== this.lastItems) {
      this.lastRows = rowsKey; this.lastItems = shown;
      const digits = String(model.items.length).length;
      this.tracks.setRows(shown.map((item, index) => {
        const active = !!playing && item.name === playing.name && item.artist === playing.artistName;
        const collection = item.type.includes("albums") || item.type.includes("playlists") || item.type.includes("artists");
        return {
          id: String(index), key: item.id, active,
          lead: active ? icon.play : collection ? glyph(item) : String((shown === model.items ? index : model.position(item)) + 1).padStart(digits, " "),
          leadColour: active ? colour.accent : colour.faint,
          name: item.name, loved: item.loved && (model.view !== "favourites" || model.preferences.heartsInFavourites), artist: item.artist, album: item.album, right: item.duration ? duration(item.duration) : undefined,
          description: item.type.includes("artists") ? ["Artist", item.genre].filter(Boolean).join("  /  ")
            : [item.artist, collection ? (item.type.includes("playlist") ? "Playlist" : "Album") : item.album].filter(Boolean).join("  /  "),
          activate: () => void model.activate(item),
        };
      }));
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
    if (this.pairingView) { pairs.length = 0; pairs.push(...this.model.pairing?.state === "confirm" ? [["⏎", "pair"], ["Esc", "cancel"]] as [string, string][] : [["Esc", "close"]] as [string, string][]); }
    else if (this.devicesView) {
      const row = this.devicesList?.rows[this.devicesList.index];
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
    // Narrow windows show the player's buttons without their keys.
    if (this.renderer.terminalWidth < 100) pairs.push(["space", "play"], ["p n", "skip"], ["- +", "volume"], ["f", "favourite"], ["s", "shuffle"], ["r", "repeat"]);
    if (model.detail?.artwork || model.playback.nowPlaying) pairs.push(["c", "cover"]);
    if (this.renderer.terminalWidth < 100) pairs.push(["y", "lyrics"], ["d", "devices"]);
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


  private progressCells(state = this.model.playback) {
    const width = this.progress.width || this.renderer.terminalWidth - 16;
    return Math.max(1, width - duration(state.time.currentTime).length - duration(state.time.duration).length - 2);
  }

  drawPlayback() {
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
    this.playerCover.setArt(song?.artwork?.url);
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
  // The cover fills the window above its name. The cached small cover shows at once and is
  // replaced by one downloaded at the window's pixel size, so it is sharp on large screens.
  private showCover(art: string | undefined, name: string, detail: string) {
    if (!art) return;
    this.closeCover();
    const ctx = this.renderer;
    const view = new BoxRenderable(ctx, { id: "cover-view", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 100,
      flexDirection: "column", alignItems: "center", paddingX: 2, paddingY: 1,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); this.closeCover(); } } });
    const image = new ImageRenderable(ctx, { id: "cover-view-image", width: "100%", flexGrow: 1, minHeight: 0, fit: "fit" });
    view.add(image);
    view.add(new TextRenderable(ctx, { content: name, fg: colour.text, attributes: 1, width: "100%", textAlign: "center", truncate: true, height: 1, marginTop: 1, flexShrink: 0, selectable: false }));
    view.add(new TextRenderable(ctx, { content: detail, fg: colour.muted, width: "100%", textAlign: "center", truncate: true, height: 1, flexShrink: 0, selectable: false }));
    view.add(new TextRenderable(ctx, { content: "Esc or click to close", fg: colour.faint, height: 1, flexShrink: 0, selectable: false }));
    this.root.visible = false;
    ctx.root.add(view); this.coverView = view;
    this.layoutLyrics();
    let requested = 0, loaded = 0;
    void cover(art)?.then(small => { if (small && !loaded && this.coverView === view) image.source = small; });
    const sharpen = () => {
      // The image fits the height left after the four text rows and the padding.
      const resolution = ctx.resolution;
      const pixels = resolution ? Math.min((ctx.terminalHeight - 6) * resolution.height / ctx.terminalHeight, (ctx.terminalWidth - 4) * resolution.width / ctx.terminalWidth) : 1500;
      const size = largeCoverSize(pixels);
      if (size <= requested) return;
      requested = size;
      void largeCover(art, size).then(large => {
        if (large && this.coverView === view && size > loaded) { loaded = size; image.source = large; }
        large?.dispose();
      });
    };
    ctx.on("resize", sharpen);
    view.once("destroyed", () => ctx.off("resize", sharpen));
    sharpen();
  }

  // The devices popup opens above the player's devices button, like a menu. It lists this
  // computer, paired devices, and nearby ones to pair, and moves the music to the one chosen.
  private toggleDevices(open = !this.devicesView) {
    if (!open) return this.closeDevices();
    if (this.devicesView) return;
    if (!this.model.onPlayOn) {
      this.model.status = this.model.player.setQuality ? "Devices are off. Unset PEEL_DEVICES=off to use them." : "Devices need Peel's own player. Unset PEEL_PLAYER=cider to use them.";
      this.model.changed(); return;
    }
    const ctx = this.renderer;
    this.model.onDevicesOpened?.();
    this.focusBefore = ctx.currentFocusedRenderable;
    this.devicesBackdrop = new BoxRenderable(ctx, { id: "devices-backdrop", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 90,
      onMouseDown: event => { event.stopPropagation(); this.closeDevices(); } });
    this.devicesView = new ClearBox(ctx, { id: "devices-view", position: "absolute", right: 2, bottom: 7, zIndex: 95, border: true, borderStyle: "rounded", borderColor: colour.accent, title: ` ${icon.devices} Play on `, titleColor: colour.text, bottomTitle: " ↑↓ choose  ⏎ play here  Esc close ", flexDirection: "column",
      onMouseDown: (event: MouseEvent) => event.stopPropagation() } as any);
    this.devicesList = new ClickList(ctx, "devices-list", 2);
    this.devicesList.onSelection = () => this.drawHints();
    this.devicesView.add(this.devicesList);
    ctx.root.add(this.devicesBackdrop); ctx.root.add(this.devicesView);
    this.devicesKey = "";
    this.drawDevices();
    // The playing device is highlighted first.
    const rows = this.devicesList.rows, index = rows.findIndex(row => row.active);
    if (index > 0) { this.devicesList.index = index; this.devicesList.drawRows(); }
    this.drawHints();
  }

  private closeDevices() {
    if (!this.devicesView) return;
    this.devicesView.destroyRecursively(); this.devicesBackdrop?.destroyRecursively();
    this.devicesView = this.devicesBackdrop = this.devicesList = undefined;
    const before = this.focusBefore;
    this.focusBefore = undefined;
    if (before && !before.isDestroyed) before.focus(); else this.focusContent();
    this.drawHints();
  }

  private deviceRows(): Row[] {
    const model = this.model, rows: Row[] = [];
    const ssh = model.preferences.remote;
    for (const device of model.devices) {
      const summary = device.summary;
      const controlled = !ssh && (device.self ? !model.target : device.online && model.targetId === device.id);
      const right = !device.paired ? "Pair" : !device.online ? "Offline" : summary?.state === "playing" ? "Playing" : summary?.state === "paused" ? "Paused" : device.output ? "Selected" : "";
      const description = !device.paired ? "Nearby. Enter pairs it with this computer."
        : !device.online ? `Open Peel on ${device.name} to play there.`
        : summary?.song ? [summary.song, summary.artist].filter(Boolean).join("  /  ")
        : device.self ? device.note ?? "This computer. Nothing playing." : "Nothing playing";
      rows.push({
        id: `device:${device.id}`, lead: !device.paired ? icon.link : controlled ? icon.speaker : icon.laptop,
        leadColour: controlled ? colour.accent : colour.faint, name: device.self ? `${device.name}  (this computer)` : device.name,
        faint: device.paired && !device.online, active: controlled, right, description,
        activate: () => {
          if (!device.paired) { this.closeDevices(); model.onPair?.(device.id); return; }
          if (!device.online) { model.status = `Can't reach ${device.name}. Open Peel on ${device.name} and check that it's on the same Wi-Fi.`; model.changed(); return; }
          this.closeDevices();
          if (!controlled) void model.playOn(device.id);
        },
      });
    }
    // SSH hosts stay in Settings. Each device appears once, and Peel chooses how to reach it.
    return rows;
  }

  private drawDevices() {
    const list = this.devicesList, view = this.devicesView;
    if (!list || !view) return;
    const rows = this.deviceRows(), key = JSON.stringify(rows.map(row => [row.id, row.name, row.right, row.description, row.active, row.faint]));
    const width = Math.min(56, this.renderer.terminalWidth - 4);
    const height = Math.max(4, Math.min(rows.length * 2 + 2, this.renderer.terminalHeight - 10));
    view.width = width; view.height = height;
    if (key === this.devicesKey) return;
    this.devicesKey = key;
    list.setRows(rows);
  }

  // Both devices show the same code while pairing. The person checks it matches, then accepts.
  private drawPairing() {
    const pairing = this.model.pairing;
    if (!pairing) { this.closePairing(); return; }
    const key = JSON.stringify([pairing.id, pairing.state, pairing.code, pairing.message]);
    if (key === this.pairingKey && this.pairingView) return;
    this.pairingKey = key;
    this.closePairing(false);
    const ctx = this.renderer, width = Math.min(52, ctx.terminalWidth - 4);
    const view = this.pairingView = new ClearBox(ctx, { id: "pairing-view", position: "absolute", left: Math.max(0, Math.floor((ctx.terminalWidth - width) / 2)), top: Math.max(0, Math.floor(ctx.terminalHeight / 2) - 5),
      width, height: 9, zIndex: 110, border: true, borderStyle: "rounded", borderColor: colour.accent,
      title: ` ${icon.link} Pair with ${pairing.name} `, titleColor: colour.text, flexDirection: "column", alignItems: "center", paddingX: 2, paddingY: 1,
      bottomTitle: pairing.state === "confirm" ? " ⏎ pair  Esc cancel " : pairing.state === "done" || pairing.state === "failed" ? " Esc close " : " Esc cancel " } as any);
    const line = (content: string | StyledText, colourName = colour.muted, height = 1) => view.add(new TextRenderable(ctx, { content, fg: colourName, width: "100%", textAlign: "center", height, wrapMode: "word", flexShrink: 0, selectable: false } as any));
    const code = pairing.code ? `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}` : "";
    if (pairing.state === "connecting") line(`Connecting to ${pairing.name}...`);
    else if (pairing.state === "confirm") {
      line(t`${bold(fg(colour.accent)(code))}`, colour.accent); line("");
      line(pairing.incoming ? `${pairing.name} wants to pair. You do not type this code. If ${pairing.name} shows the same one, press Enter.`
        : `You do not type this code. If ${pairing.name} shows the same one, press Enter here and there.`, colour.muted, 3);
    } else if (pairing.state === "waiting") {
      line(t`${bold(fg(colour.accent)(code))}`, colour.accent); line("");
      line(`Waiting for ${pairing.name} to accept...`, colour.muted, 2);
    } else line(pairing.message ?? "", pairing.state === "done" ? colour.text : colour.muted, 3);
    ctx.root.add(view);
    this.drawHints();
  }

  private closePairing(redraw = true) {
    if (!this.pairingView) return;
    this.pairingView.destroyRecursively(); this.pairingView = undefined;
    if (redraw) { this.pairingKey = ""; this.drawHints(); }
  }

  private closeCover() {
    if (!this.coverView) return false;
    this.coverView.destroyRecursively(); this.coverView = undefined;
    this.root.visible = true;
    this.layoutLyrics();
    return true;
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

  // The settings page: one row per setting, its value on the right. Enter switches it.
  private settingsRows() {
    const model = this.model, preferences = model.preferences, update = model.update;
    const engine = !!model.player.setQuality, lossless = !!model.player.lossless;
    const high = preferences.quality === "high", stable = preferences.channel === "stable";
    const hearts = preferences.heartsInFavourites;
    const rows: Parameters<ClickList["setRows"]>[0] = [
      {
        id: "quality", lead: icon.quality, name: "Audio quality",
        right: !engine ? "Set in Cider" : lossless ? "Hi-Res Lossless" : high ? "High  256 kbps" : "Standard  64 kbps",
        description: !engine ? "Cider plays the music, so its own settings choose the quality."
          : lossless ? "Apple Music's Android app plays ALAC up to 24-bit/192 kHz. Its own Audio Quality setting chooses the quality, not Peel."
          : "AAC from Apple. Standard uses a quarter of the data. Hi-Res Lossless needs Peel's hi-res player, which runs on Linux (hires/).",
        activate: () => {
          if (!engine) { model.status = "Cider plays the music. Choose its quality in Cider's settings."; model.changed(); return; }
          if (lossless) { model.status = "Hi-res plays lossless. Apple Music's Android app chooses the quality."; model.changed(); return; }
          void model.setPreference({ quality: high ? "standard" : "high" }, `Audio quality: ${high ? "Standard, 64 kbps" : "High, 256 kbps"}`);
        },
      },
      {
        id: "channel", lead: icon.update, name: "Updates", right: stable ? "Stable" : "Nightly",
        description: stable ? "Tested releases." : "Each night's build with the newest features. It can break.",
        activate: () => void model.setPreference({ channel: stable ? "nightly" : "stable" },
          stable ? "Updates: Nightly. Peel checks for the newest nightly build now." : "Updates: Stable. Peel checks for the newest stable release now."),
      },
      update.ready ? {
        id: "update", lead: icon.update, name: update.older ? "Restart to switch" : "Restart to update", right: shortVersion(update.ready),
        description: update.newEngine && model.playsLocally() ? "The music stops and the queue clears, because the playback engine restarts too."
          : "Restarts Peel in this window. The music keeps playing and the queue stays.",
        activate: () => model.onRestart(),
      } : {
        id: "update", lead: icon.update, name: "Check for updates", right: update.checking ? "Checking..." : update.version ? shortVersion(update.version) : "",
        description: update.message || "Peel checks every six hours and installs updates in the background.",
        activate: () => { if (!update.checking) model.onCheckUpdate(); },
      },
      {
        id: "hearts", lead: icon.heart, leadColour: colour.heart, name: "Hearts in Favourite Songs", right: hearts ? "Shown" : "Hidden",
        description: "Every song in Favourite Songs is a favourite, so its rows show no heart unless this is on.",
        activate: () => void model.setPreference({ heartsInFavourites: !hearts }, `Hearts in Favourite Songs: ${hearts ? "hidden" : "shown"}`),
      },
    ];
    if (model.onPlayOn) {
      const paired = model.devices.filter(device => device.paired && !device.self);
      rows.push({
        id: "devices", lead: icon.devices, name: "Devices", right: paired.length ? `${paired.filter(device => device.online).length} of ${paired.length} online` : "None paired",
        description: "Peels on this network. Press d anywhere to choose which one plays, or to pair one.",
        activate: () => this.toggleDevices(true),
      });
      if (paired.length) rows.push({
        id: "forget-devices", lead: icon.link, name: "Forget paired devices", right: Date.now() - this.forgetAsked < 5000 ? "Press Enter again" : "",
        description: "This computer leaves its device group. Pair again to control the others.",
        activate: () => {
          if (Date.now() - this.forgetAsked > 5000) { this.forgetAsked = Date.now(); model.status = "Press Enter again to forget every paired device on this computer."; model.changed(); return; }
          this.forgetAsked = 0;
          void model.onForgetDevices?.().then(() => { model.status = "Forgot the paired devices. Pair again from the devices popup."; model.changed(); }, error => model.fail(error));
        },
      });
    }
    if (model.onOutput && model.outputTargets.length) rows.push({
      id: "output", lead: icon.console, name: "Control over SSH", right: preferences.remote ?? "Off",
      description: "Controls an SSH host's player without moving the music. Add a host with peel --remote <ssh-host>.",
      activate: () => {
        const targets = [undefined, ...model.outputTargets];
        void model.selectOutput(targets[(targets.indexOf(preferences.remote) + 1) % targets.length]);
      },
    });
    return rows;
  }

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
    else if (this.pairingView) action = key.name === "space" ? () => void model.act("/playback/toggle")
      : key.name === "return" ? () => { const pairing = model.pairing; if (pairing?.state === "confirm") pairing.accept(); else if (pairing?.state === "done" || pairing?.state === "failed") pairing.decline(); }
      : key.name === "escape" ? () => model.pairing?.decline() : () => {};
    // The devices popup takes the keys that move in it. Playback keys still work under it.
    else if (this.devicesView && ["up", "down", "j", "k", "return", "escape", "d", "tab", "home", "end"].includes(key.name)) action = () => {
      const list = this.devicesList!;
      if (["up", "k"].includes(key.name)) list.move(-1);
      else if (["down", "j"].includes(key.name)) list.move(1);
      else if (key.name === "home" || key.name === "end") list.move(key.name === "home" ? -list.rows.length : list.rows.length);
      else if (key.name === "return") list.activate();
      else this.closeDevices();
    };
    // The enlarged cover takes the keys, except play/pause and quit.
    else if (this.coverView) action = key.name === "space" ? () => void model.act("/playback/toggle") : key.name === "q" ? this.quit
      : ["escape", "return", "backspace", "c"].includes(key.name) ? () => this.closeCover() : () => {};
    else if (key.name === "c" && !this.search.focused && !this.filterInput.focused) action = () => {
      const detail = model.detail, song = model.playback.nowPlaying;
      if (detail?.artwork) this.showCover(detail.artwork, detail.name, detail.artist || detail.genre || "");
      else if (song) this.showCover(song.artwork?.url, song.albumName ?? song.name ?? "", song.artistName ?? "");
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
    else if (key.name === "d" && !key.ctrl) action = () => this.toggleDevices();
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
    this.closeCover();
    this.closeDevices();
    this.closePairing();
    this.lyrics.dispose();
    this.model.off("change", this.change); this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.focusChange); this.renderer.keyInput.off("keypress", this.key);
    this.root.destroyRecursively();
  }
}
