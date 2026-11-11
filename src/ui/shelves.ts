import type { Model } from "../model";
import { colour, icon } from "../theme";
import { duration } from "../types";
import { glyph, type Row, type Shelf } from "./widgets";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function releaseDay(date?: string) {
  const [, month, day] = (date ?? "").split("-").map(Number);
  return month ? `${day} ${months[month - 1]}` : "";
}
const today = () => new Date().toISOString().slice(0, 10);
// Apple appends the release type to single and EP names. The shelf title already says it.
const release = (name: string) => name.replace(/ - (Single|EP)$/, "");

// The covers for the open view: one wrapping grid for Albums and Artists, an artist's shelves,
// or Home's shelves.
export function shelves(model: Model): Shelf[] {
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

// One row per song, album, playlist, or artist in the open list, in the order shown.
export function songRows(model: Model): Row[] {
  const playing = model.playback.nowPlaying, shown = model.shown;
  const digits = String(model.items.length).length;
  return shown.map((item, index) => {
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
  });
}
