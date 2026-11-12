import type { Media } from "./types";

// Apple keeps one recording under several IDs: the library song, the catalog song it links to, a
// newer catalog song after a re-release, and sometimes an old catalog song Apple no longer serves.
// A favourite mark sits on one of them. Peel treats a song as a favourite when any of its versions
// is one, so a song does not lose its heart because Apple shows it under another ID.
//
// Versions match by ID, then by ISRC, then by title, artist and length. The last rule is for a
// library song whose catalog song Apple no longer serves, so no ISRC can be read for it.

// Two songs with the same title and a shared artist are the same recording when their lengths
// differ by at most this many seconds. A live take, an extended mix or a radio edit has another
// length.
export const lengthTolerance = 2;

const clean = (text: string) => text.normalize("NFKC").toLowerCase()
  .replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, "\"").replace(/\s+/g, " ").trim();
// Apple spells the guests in a title differently between releases, as "(feat. CeeLo Green)" and
// "(feat. Cee Lo Green)", so the title is compared without them.
const title = (name: string) => clean(name).replace(/\s*[([](feat\.?|ft\.?|featuring|with) [^)\]]*[)\]]/g, "").trim();
// Apple orders and groups the artists differently between releases, as "GERDA & OG Keemo" and
// "OG Keemo & GERDA", or credits a group alone.
const artists = (artist: string) => new Set(clean(artist).split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bwith\b)\s*/).filter(Boolean));

type Version = Media & { isrc?: string };

export class Versions {
  private ids = new Set<string>();
  private isrcs = new Set<string>();
  private titles = new Map<string, Version[]>();

  // songs are the favourites, each with the ISRC of the catalog song it links to when Apple serves it.
  constructor(readonly songs: Version[]) {
    for (const song of songs) {
      for (const id of [song.id, song.catalogId, song.reportingId]) if (id) this.ids.add(id);
      if (song.isrc) this.isrcs.add(song.isrc);
      if (song.duration > 0 && song.name) this.titles.set(title(song.name), [...this.titles.get(title(song.name)) ?? [], song]);
    }
  }

  // Whether song is a version of one of the favourites. isrc is the song's ISRC when known.
  has(song: Media, isrc = (song as Version).isrc): boolean {
    if ([song.id, song.catalogId, song.reportingId].some(id => id && this.ids.has(id))) return true;
    if (isrc && this.isrcs.has(isrc)) return true;
    return !!this.titles.get(title(song.name))?.some(favourite => sameTitle(favourite, song));
  }

  // The favourites that are versions of song, for removing every mark it has.
  of(song: Media, isrc = (song as Version).isrc): Version[] {
    return this.songs.filter(favourite => sameRecording(favourite, song, isrc));
  }
}

function sameTitle(a: Media, b: Media) {
  if (!(a.duration > 0 && b.duration > 0) || Math.abs(a.duration - b.duration) > lengthTolerance) return false;
  if (title(a.name) !== title(b.name)) return false;
  const credited = artists(a.artist);
  return [...artists(b.artist)].some(name => credited.has(name));
}

export function sameRecording(a: Version, b: Media, isrc = (b as Version).isrc): boolean {
  const ids = new Set([b.id, b.catalogId, b.reportingId].filter(Boolean));
  if ([a.id, a.catalogId, a.reportingId].some(id => id && ids.has(id))) return true;
  if (a.isrc && isrc && a.isrc === isrc) return true;
  return sameTitle(a, b);
}
