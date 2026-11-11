import { BoxRenderable, TextRenderable, InputRenderable, t, fg, bold, type CliRenderer } from "@opentui/core";
import type { Model } from "../model";
import { colour, icon } from "../theme";
import { Button } from "./widgets";

// The top row: Peel's name, the search field, and at the right where the music plays. The search
// field is filled and rounded, so it reads as a field without a box of three rows around it.
export class TopBar {
  readonly bar: BoxRenderable;
  readonly search: InputRenderable;
  readonly devicesButton: Button;
  private logo: TextRenderable;
  private caps: TextRenderable[];
  private glass: TextRenderable;
  private pill: BoxRenderable;

  constructor(ctx: CliRenderer, private model: Model, onSearch: (term: string) => void, toggleDevices: () => void) {
    this.bar = new BoxRenderable(ctx, { id: "top-bar", height: 1, flexDirection: "row", flexShrink: 0, gap: 2, paddingX: 1 });
    this.logo = new TextRenderable(ctx, { content: t`${bold(fg(colour.accent)("peel"))}`, height: 1, flexShrink: 0, selectable: false });
    this.bar.add(this.logo);
    const pill = this.pill = new BoxRenderable(ctx, { id: "search-panel", height: 1, flexDirection: "row", flexShrink: 0, width: 40,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); this.search.focus(); } } });
    const cap = (content: string) => new TextRenderable(ctx, { content, fg: colour.field, height: 1, width: 1, flexShrink: 0, selectable: false });
    this.caps = [cap(icon.capLeft), cap(icon.capRight)];
    // The glass and the field each paint the fill, so nothing paints over the rounded ends.
    this.glass = new TextRenderable(ctx, { content: `${icon.search} `, fg: colour.muted, bg: colour.field, height: 1, width: 2, flexShrink: 0, selectable: false });
    // The input sits in a box that clips it, since it can paint one cell past its share.
    const box = new BoxRenderable(ctx, { height: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, overflow: "hidden" });
    this.search = new InputRenderable(ctx, { id: "search", width: "100%", placeholder: "Search Apple Music   / or Ctrl+F", textColor: colour.text, placeholderColor: colour.muted, backgroundColor: colour.field, focusedBackgroundColor: colour.selected } as any);
    this.search.on("enter", () => onSearch(this.search.value));
    box.add(this.search);
    pill.add(this.caps[0]!); pill.add(this.glass); pill.add(box); pill.add(this.caps[1]!);
    this.bar.add(pill);
    this.bar.add(new BoxRenderable(ctx, { height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0 }));
    // Where the music plays, like Spotify Connect. A click or d opens the devices popup below it.
    this.devicesButton = new Button(ctx, "devices", "●", "", toggleDevices, colour.faint);
    this.devicesButton.flexShrink = 0;
    this.bar.add(this.devicesButton);
  }

  // The field turns blue while it has focus, as the panels' borders do.
  focusChanged() {
    const fill = this.search.focused ? colour.selected : colour.field;
    for (const cap of this.caps) cap.fg = fill;
    this.glass.bg = fill;
    this.glass.fg = this.search.focused ? colour.accent : colour.muted;
  }

  // Narrow windows drop Peel's name and shorten where the music plays to the device's name.
  draw(width: number) {
    const model = this.model, song = model.playback.nowPlaying;
    const target = model.target ?? model.preferences.remote;
    const playing = model.connected && model.playback.state === "playing";
    const label = width < 76 ? target ?? "" : song ? (target ? `Playing on ${target}` : "Playing here") : target ? `${target}, nothing playing` : "Nothing playing here";
    this.logo.visible = width >= 60;
    this.devicesButton.showHint = !!label;
    this.devicesButton.set("●", width < 76 ? label : `${label}  d`, playing ? colour.playing : colour.faint);
    // A whole number of cells, at most 72: with fractions, the field's rounded end could land on its fill.
    const device = this.devicesButton.widthWith(label ? (width < 76 ? label : `${label}  d`) : "");
    this.pill.width = Math.max(12, Math.min(72, width - 2 - (this.logo.visible ? 6 : 0) - device - 4));
  }
}
