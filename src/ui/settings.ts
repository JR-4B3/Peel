import { textSizes } from "../config";
import { formatBytes } from "../memory";
import type { Model } from "../model";
import { colour, icon } from "../theme";
import { shortVersion } from "../update";
import type { Row } from "./widgets";

// What the settings rows need from the interface. forgetAsked is when Enter was first pressed on
// "Forget paired devices", which asks for a second press.
export interface SettingsContext { model: Model; openDevices: () => void; forgetAsked: number }

// The settings page: one row per setting, its value on the right. Enter switches it.
export function settingsRows(settings: SettingsContext): Row[] {
  const model = settings.model, preferences = model.preferences, update = model.update;
  const lossless = !!model.player.lossless;
  const high = preferences.quality === "high", stable = preferences.channel === "stable";
  const hearts = preferences.heartsInFavourites;
  const rows: Row[] = [
    {
      id: "quality", lead: icon.quality, name: "Audio quality",
      right: lossless ? "Hi-Res Lossless" : high ? "High  256 kbps" : "Standard  64 kbps",
      description: lossless ? "Apple Music's Android app plays ALAC up to 24-bit/192 kHz. Its own Audio Quality setting chooses the quality, not Peel."
        : "AAC from Apple. Standard uses a quarter of the data. Hi-Res Lossless needs Peel's hi-res player, which runs on Linux (hires/).",
      activate: () => {
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
  // Peel's menu entry opens Ghostty on Linux and macOS. Windows opens Windows Terminal.
  if (process.platform !== "win32") rows.push({
    id: "text-size", lead: icon.textSize, name: "Text size", right: preferences.textSize ? `${preferences.textSize} pt` : "Ghostty's",
    description: "Ghostty's font size the next time Peel opens from its menu. A menu entry from before 0.1.1 needs peel --install-launcher.",
    activate: () => {
      const next = textSizes[(textSizes.indexOf(preferences.textSize) + 1) % textSizes.length]!;
      void model.setPreference({ textSize: next }, next ? `Text size: ${next} pt, the next time Peel opens from its menu entry` : "Text size: Ghostty's own");
    },
  });
  if (model.memory) {
    const parts = model.memory.parts.map(part => `${part.name} ${formatBytes(part.bytes)}`).join(", ");
    rows.push({
      id: "memory", lead: icon.memory, name: "Memory", right: formatBytes(model.memory.total),
      description: `${parts[0]!.toUpperCase()}${parts.slice(1)}, on this computer. File cache that Linux can free is left out.`,
      activate: () => {},
    });
  }
  if (model.onPlayOn) {
    const paired = model.devices.filter(device => device.paired && !device.self);
    rows.push({
      id: "devices", lead: icon.devices, name: "Devices", right: paired.length ? `${paired.filter(device => device.online).length} of ${paired.length} online` : "None paired",
      description: "Peels on this network. Press d anywhere to choose which one plays, or to pair one.",
      activate: () => settings.openDevices(),
    });
    if (paired.length) rows.push({
      id: "forget-devices", lead: icon.link, name: "Forget paired devices", right: Date.now() - settings.forgetAsked < 5000 ? "Press Enter again" : "",
      description: "This computer leaves its device group. Pair again to control the others.",
      activate: () => {
        if (Date.now() - settings.forgetAsked > 5000) { settings.forgetAsked = Date.now(); model.status = "Press Enter again to forget every paired device on this computer."; model.changed(); return; }
        settings.forgetAsked = 0;
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
