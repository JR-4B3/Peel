import { BoxRenderable, TextRenderable, StyledText, t, fg, bold, type CliRenderer, type MouseEvent } from "@opentui/core";
import type { Model } from "../model";
import { colour, icon } from "../theme";
import { ClickList } from "./click-list";
import { ClearBox, type Row } from "./widgets";

type Focusable = { focus(): void; isDestroyed?: boolean } | null;

// The devices popup opens above the player's devices button, like a menu. It lists this
// computer, paired devices, and nearby ones to pair, and moves the music to the one chosen.
export class DevicesPopup {
  view?: BoxRenderable;
  list?: ClickList;
  private backdrop?: BoxRenderable;
  private key = "";
  private focusBefore?: Focusable;

  // changed redraws the key hints. restoreFocus runs when the popup closes and nothing had focus.
  constructor(private renderer: CliRenderer, private model: Model, private changed: () => void, private restoreFocus: () => void) {}

  get open() { return !!this.view; }

  toggle(open = !this.view) {
    if (!open) return this.close();
    if (this.view) return;
    if (!this.model.onPlayOn) {
      this.model.status = "Devices are off. Unset PEEL_DEVICES=off to use them.";
      this.model.changed(); return;
    }
    const ctx = this.renderer;
    this.model.onDevicesOpened?.();
    this.focusBefore = ctx.currentFocusedRenderable;
    this.backdrop = new BoxRenderable(ctx, { id: "devices-backdrop", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 90,
      onMouseDown: event => { event.stopPropagation(); this.close(); } });
    this.view = new ClearBox(ctx, { id: "devices-view", position: "absolute", right: 2, bottom: 7, zIndex: 95, border: true, borderStyle: "rounded", borderColor: colour.accent, title: ` ${icon.devices} Play on `, titleColor: colour.text, bottomTitle: " ↑↓ choose  ⏎ play here  Esc close ", flexDirection: "column",
      onMouseDown: (event: MouseEvent) => event.stopPropagation() } as any);
    this.list = new ClickList(ctx, "devices-list", 2);
    this.list.onSelection = () => this.changed();
    this.view.add(this.list);
    ctx.root.add(this.backdrop); ctx.root.add(this.view);
    this.key = "";
    this.draw();
    // The playing device is highlighted first.
    const rows = this.list.rows, index = rows.findIndex(row => row.active);
    if (index > 0) { this.list.index = index; this.list.drawRows(); }
    this.changed();
  }

  close() {
    if (!this.view) return;
    this.view.destroyRecursively(); this.backdrop?.destroyRecursively();
    this.view = this.backdrop = this.list = undefined;
    const before = this.focusBefore;
    this.focusBefore = undefined;
    if (before && !before.isDestroyed) before.focus(); else this.restoreFocus();
    this.changed();
  }

  // The keys that move in the popup. Playback keys still work under it.
  handles(name: string) { return !!this.view && ["up", "down", "j", "k", "return", "escape", "d", "tab", "home", "end"].includes(name); }
  press(name: string) {
    const list = this.list!;
    if (["up", "k"].includes(name)) list.move(-1);
    else if (["down", "j"].includes(name)) list.move(1);
    else if (name === "home" || name === "end") list.move(name === "home" ? -list.rows.length : list.rows.length);
    else if (name === "return") list.activate();
    else this.close();
  }

  private rows(): Row[] {
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
          if (!device.paired) { this.close(); model.onPair?.(device.id); return; }
          if (!device.online) { model.status = `Can't reach ${device.name}. Open Peel on ${device.name} and check that it's on the same Wi-Fi.`; model.changed(); return; }
          this.close();
          if (!controlled) void model.playOn(device.id);
        },
      });
    }
    // SSH hosts stay in Settings. Each device appears once, and Peel chooses how to reach it.
    return rows;
  }

  draw() {
    const list = this.list, view = this.view;
    if (!list || !view) return;
    const rows = this.rows(), key = JSON.stringify(rows.map(row => [row.id, row.name, row.right, row.description, row.active, row.faint]));
    const width = Math.min(56, this.renderer.terminalWidth - 4);
    const height = Math.max(4, Math.min(rows.length * 2 + 2, this.renderer.terminalHeight - 10));
    view.width = width; view.height = height;
    if (key === this.key) return;
    this.key = key;
    list.setRows(rows);
  }
}

// Both devices show the same code while pairing. The person checks it matches, then accepts.
export class PairingPrompt {
  view?: BoxRenderable;
  private key = "";

  constructor(private renderer: CliRenderer, private model: Model, private changed: () => void) {}

  draw() {
    const pairing = this.model.pairing;
    if (!pairing) { this.close(); return; }
    const key = JSON.stringify([pairing.id, pairing.state, pairing.code, pairing.message]);
    if (key === this.key && this.view) return;
    this.key = key;
    this.close(false);
    const ctx = this.renderer, width = Math.min(52, ctx.terminalWidth - 4);
    const view = this.view = new ClearBox(ctx, { id: "pairing-view", position: "absolute", left: Math.max(0, Math.floor((ctx.terminalWidth - width) / 2)), top: Math.max(0, Math.floor(ctx.terminalHeight / 2) - 5),
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
    this.changed();
  }

  close(redraw = true) {
    if (!this.view) return;
    this.view.destroyRecursively(); this.view = undefined;
    if (redraw) { this.key = ""; this.changed(); }
  }

  // The prompt takes the keys, except play/pause.
  press(name: string) {
    const pairing = this.model.pairing;
    if (name === "space") void this.model.act("/playback/toggle");
    else if (name === "return") { if (pairing?.state === "confirm") pairing.accept(); else if (pairing?.state === "done" || pairing?.state === "failed") pairing.decline(); }
    else if (name === "escape") pairing?.decline();
  }
}
