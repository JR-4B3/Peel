import { BoxRenderable, TextRenderable, ImageRenderable, RGBA, t, fg, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { cover } from "../artwork";
import { colour, icon } from "../theme";
import type { Media } from "../types";

// Small parts the screens share: rows, covers, buttons, and text helpers.
export interface Row { id: string; key?: string; lead?: string; leadColour?: string; name: string; loved?: boolean; faint?: boolean; description?: string; artist?: string; album?: string; right?: string; active?: boolean; activate: () => void }
export type Column = "artist" | "album";
export interface Tile { media: Media; caption: string; detail: string; note?: string; noteColour?: string }
export interface Shelf { id: string; title: string; tiles: Tile[]; empty: string }

export const glyph = (item: Media) => item.type.includes("artist") ? icon.artist : item.type.includes("playlist") ? icon.playlist : icon.album;
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Album art, with an album glyph until the image arrives or when there is none.
export class Cover extends BoxRenderable {
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
export class ClearBox extends BoxRenderable {
  protected renderSelf(buffer: OptimizedBuffer) {
    const ink = RGBA.fromHex(colour.text);
    for (let y = Math.max(0, this.y); y < Math.min(buffer.height, this.y + this.height); y++)
      for (let x = Math.max(0, this.x); x < Math.min(buffer.width, this.x + this.width); x++) buffer.setCell(x, y, " ", ink, unpainted);
    super.renderSelf(buffer);
  }
}

// A clickable icon. The key hint is shown when the terminal has room for it.
export class Button extends TextRenderable {
  private hovered = false;
  showHint = true;
  // The hints a narrow row can switch to, longest first. The last is the glyph alone.
  hints?: string[];

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

  setHint(hint: string) { this.set(this.glyph, hint); }

  // The cells this button takes with the given hint.
  widthWith(hint: string) { return Bun.stringWidth(this.glyph) + (hint ? 1 + Bun.stringWidth(hint) : 0); }

  paint() {
    const label = this.hovered ? colour.text : this.tint;
    this.content = this.showHint && this.hint ? t`${fg(label)(this.glyph)} ${fg(this.hovered ? colour.text : colour.faint)(this.hint)}` : t`${fg(label)(this.glyph)}`;
  }
}

// A song title, after a heart when the song is a favourite.
export function titled(name: string, loved: boolean | undefined, tint: string) {
  return loved ? t`${fg(colour.heart)(icon.heart)} ${fg(tint)(name)}` : t`${fg(tint)(name)}`;
}

// Shortened names end in an ellipsis, so a cut-off name does not read as a complete one.
export function fit(text: string, width: number) {
  if (Bun.stringWidth(text) <= width) return text;
  let result = "";
  for (const char of text) {
    if (Bun.stringWidth(result + char) > width - 1) break;
    result += char;
  }
  return result.trimEnd() + "…";
}
