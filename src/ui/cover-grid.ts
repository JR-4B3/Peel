import { BoxRenderable, TextRenderable, t, fg, bold, type CliRenderer } from "@opentui/core";
import { colour, icon } from "../theme";
import type { Media } from "../types";
import { Button, Cover, fit, glyph, type Shelf, type Tile } from "./widgets";

// Covers laid out as shelves that scroll sideways (Home), or as a wrapping grid (Albums).
export class CoverGrid extends BoxRenderable {
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
    // The chosen cover's frame takes the accent colour only while the grid has focus.
    // OpenTUI reports focus changes as events, not through methods on the renderable.
    this.on("focused", () => this.draw());
    this.on("blurred", () => this.draw());
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
      onMouseDown: event => {
        if (event.button !== 0) return;
        event.stopPropagation(); this.focus(); this.shelf = shelfIndex; this.tile = index; this.draw(); this.onActivate?.(tile.media);
      },
    });
    // The chosen cover has a rounded frame around the cover alone, and its captions stay below it.
    // Other covers keep a blank cell on each side in place of the frame, so nothing moves when the
    // choice changes. OpenTUI enables a border whenever a border style is set.
    const frame = new BoxRenderable(this.ctx, {
      id: `${this.id}:frame:${shelf.id}:${index}`, width: this.tileWidth, height: this.coverWidth / 2 + 2, flexShrink: 0,
      ...(selected ? { border: true, borderStyle: "rounded" as const, borderColor: this.focused ? colour.accent : colour.faint } : { padding: 1 }),
    });
    frame.add(new Cover(this.ctx, { width: this.coverWidth, height: this.coverWidth / 2, art: tile.media.artwork, glyph: glyph(tile.media) }));
    box.add(frame);
    const line = { height: 1, width: this.coverWidth, marginLeft: 1, truncate: true, selectable: false };
    box.add(new TextRenderable(this.ctx, { ...line, content: fit(tile.caption, this.coverWidth), fg: selected ? colour.accent : colour.text, attributes: selected ? 1 : 0 }));
    box.add(new TextRenderable(this.ctx, { ...line, content: fit(tile.detail, this.coverWidth), fg: colour.muted }));
    if (tile.note) box.add(new TextRenderable(this.ctx, { ...line, content: tile.note, fg: tile.noteColour ?? colour.faint }));
    this.add(box);
  }

}
