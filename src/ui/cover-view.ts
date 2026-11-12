import { BoxRenderable, TextRenderable, ImageRenderable, type CliRenderer } from "@opentui/core";
import { cover, largeCover, largeCoverSize } from "../artwork";
import { colour } from "../theme";

// The cover fills the window above its name. The cached small cover shows at once and is
// replaced by one downloaded at the window's pixel size, so it is sharp on large screens.
// toggled runs after it opens or closes, so the interface hides or shows what is under it.
export class CoverView {
  view?: BoxRenderable;

  constructor(private renderer: CliRenderer, private toggled: (open: boolean) => void) {}

  get open() { return !!this.view; }

  show(art: string | undefined, name: string, detail: string) {
    if (!art) return;
    this.close();
    const ctx = this.renderer;
    const view = new BoxRenderable(ctx, { id: "cover-view", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 100,
      flexDirection: "column", alignItems: "center", paddingX: 2, paddingY: 1,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); this.close(); } } });
    const image = new ImageRenderable(ctx, { id: "cover-view-image", width: "100%", flexGrow: 1, minHeight: 0, fit: "fit" });
    view.add(image);
    view.add(new TextRenderable(ctx, { content: name, fg: colour.text, attributes: 1, width: "100%", textAlign: "center", truncate: true, height: 1, marginTop: 1, flexShrink: 0, selectable: false }));
    view.add(new TextRenderable(ctx, { content: detail, fg: colour.muted, width: "100%", textAlign: "center", truncate: true, height: 1, flexShrink: 0, selectable: false }));
    view.add(new TextRenderable(ctx, { content: "Esc or click to close", fg: colour.faint, height: 1, flexShrink: 0, selectable: false }));
    ctx.root.add(view); this.view = view;
    this.toggled(true);
    let requested = 0, loaded = 0;
    void cover(art)?.then(small => { if (small && !loaded && this.view === view) image.source = small; });
    const sharpen = () => {
      // The image fits the height left after the four text rows and the padding.
      const resolution = ctx.resolution;
      const pixels = resolution ? Math.min((ctx.terminalHeight - 6) * resolution.height / ctx.terminalHeight, (ctx.terminalWidth - 4) * resolution.width / ctx.terminalWidth) : 1500;
      const size = largeCoverSize(pixels);
      if (size <= requested) return;
      requested = size;
      void largeCover(art, size).then(large => {
        if (large && this.view === view && size > loaded) { loaded = size; image.source = large; }
        large?.dispose();
      });
    };
    ctx.on("resize", sharpen);
    view.once("destroyed", () => ctx.off("resize", sharpen));
    sharpen();
  }

  close() {
    if (!this.view) return false;
    this.view.destroyRecursively(); this.view = undefined;
    this.toggled(false);
    return true;
  }
}
