export interface Media {
  id: string;
  type: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  favourite?: boolean;
  queueIndex?: number;
  artwork?: string;
  releaseDate?: string;
  trackCount?: number;
  prerelease?: boolean;
  genre?: string;
}

export interface Playback {
  state: "playing" | "paused" | "stopped";
  nowPlaying: {
    name?: string; artistName?: string; albumName?: string; artwork?: { url?: string };
    inFavorites?: boolean; playParams?: { id?: string; catalogId?: string };
  } | null;
  time: { currentTime: number; duration: number; remaining?: number };
  volume: number;
  repeatMode: "none" | "one" | "all";
  shuffleMode: boolean;
}

export interface Page {
  items: Media[];
  more: boolean;
}

export interface Home {
  recent: Media[];
  releases: Media[];
  updated?: number;
}

export interface ArtistShelf { id: string; title: string; items: Media[] }
export interface ArtistPage { artist: Media; top: Media[]; shelves: ArtistShelf[] }

// Apple Music's catalog and the listener's library, read directly from Apple.
export interface Library {
  recent(): Promise<Media[]>;
  releases(): Promise<Media[]>;
  playlist(id: string, offset?: number): Promise<Page>;
  playlists(): Promise<Media[]>;
  search(term: string): Promise<Media[]>;
  songs(id?: string, offset?: number): Promise<Page>;
  album(id: string, offset?: number): Promise<Page>;
  albums(offset?: number): Promise<Page>;
  artists(offset?: number): Promise<Page>;
  artistId(item: Media): Promise<string | undefined>;
  artist(id: string): Promise<ArtistPage>;
}

// Cider's playback engine: the player state, the queue, and the playing song's rating.
export interface Player {
  snapshot(): Promise<Playback>;
  rating(): Promise<number>;
  queue(offset?: number): Promise<Page>;
  queuePosition(): Promise<{ position: number; total: number }>;
  playItem(item: Media): Promise<void>;
  // items is the collection as loaded so far, with the selected track at index.
  playCollectionTrack(collection: { id: string; type: string }, items: Media[], index: number): Promise<void>;
  command(path: string, body?: unknown, method?: string): Promise<void>;
}

export function media(item: Record<string, any>, type = "songs"): Media {
  const resource = item.track ?? item;
  const attrs = resource.attributes ?? resource;
  return {
    id: String(resource.id), type: resource.type ?? type,
    name: attrs.name ?? "Untitled", artist: attrs.artistName ?? "", album: attrs.albumName ?? "",
    duration: (attrs.durationInMillis ?? attrs.durationMs ?? 0) / 1000,
    favourite: attrs.tags?.includes("favorited") ?? false,
    artwork: attrs.artwork?.url, releaseDate: attrs.releaseDate, trackCount: attrs.trackCount,
    prerelease: attrs.isPrerelease, genre: attrs.genreNames?.[0],
  };
}

export const stopped: Playback = {
  state: "stopped", nowPlaying: null, time: { currentTime: 0, duration: 0 },
  volume: 0.5, repeatMode: "none", shuffleMode: false,
};

export function duration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
