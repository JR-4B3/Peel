import { BoxRenderable, TextRenderable, InputRenderable, t, fg, bold, type CliRenderer } from "@opentui/core";
import type { Model } from "../model";
import { colour, icon } from "../theme";
import { Button } from "./widgets";

// The top row: Peel's name, the search field, and at the right where the music plays. The search
// field is filled, so it reads as a field without a box of three rows around it.
export class TopBar {
  readonly bar: BoxRenderable;
  readonly search: InputRenderable;
  readonly devicesButton: Button;
  private logo: TextRenderable;
  private glass: TextRenderable;
  private field: BoxRenderable;

  constructor(ctx: CliRenderer, private model: Model, onSearch: (term: string) => void, toggleDevices: () => void) {
    this.bar = new BoxRenderable(ctx, { id: "top-bar", height: 1, flexDirection: "row", flexShrink: 0, gap: 2, paddingX: 1 });
    this.logo = new TextRenderable(ctx, { content: t`${bold(fg(colour.accent)("peel"))}`, height: 1, flexShrink: 0, selectable: false });
    this.bar.add(this.logo);
    // The field fills the row up to where the music plays, so it grows with the window.
    const field = this.field = new BoxRenderable(ctx, { id: "search-panel", height: 1, flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 12, gap: 1, paddingX: 1, backgroundColor: colour.field,
      onMouseDown: event => { if (event.button === 0) { event.stopPropagation(); this.search.focus(); } } });
    this.glass = new TextRenderable(ctx, { content: icon.search, fg: colour.muted, height: 1, width: 1, flexShrink: 0, selectable: false });
    this.search = new InputRenderable(ctx, { id: "search", flexGrow: 1, flexShrink: 1, minWidth: 0, placeholder: "Search Apple Music   / or Ctrl+F", textColor: colour.text, placeholderColor: colour.muted, backgroundColor: colour.field, focusedBackgroundColor: colour.selected } as any);
    this.search.on("enter", () => onSearch(this.search.value));
    field.add(this.glass); field.add(this.search);
    this.bar.add(field);
    // Where the music plays, like Spotify Connect. A click or d opens the devices popup below it.
    this.devicesButton = new Button(ctx, "devices", "●", "", toggleDevices, colour.faint);
    this.devicesButton.flexShrink = 0;
    this.bar.add(this.devicesButton);
  }

  // The field turns blue while it has focus, as the panels' borders do.
  focusChanged() {
    this.field.backgroundColor = this.search.focused ? colour.selected : colour.field;
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
  }
}
