import { BoxRenderable, TextRenderable, type CliRenderer, type MouseEvent } from "@opentui/core";
import { colour } from "../theme";
import { fit, titled, type Column, type Row } from "./widgets";

// A list of rows to click or move through with the keys: the sidebar, songs, settings and devices.
export class ClickList extends BoxRenderable {
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
