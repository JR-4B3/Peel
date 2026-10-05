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

export interface Player {
  snapshot(): Promise<Playback>;
  recent(): Promise<Media[]>;
  releases(): Promise<Media[]>;
  playlist(id: string, offset?: number): Promise<Page>;
  rating(): Promise<number>;
  playlists(): Promise<Media[]>;
  search(term: string): Promise<Media[]>;
  songs(id?: string, offset?: number): Promise<Page>;
  album(id: string, offset?: number): Promise<Page>;
  albums(offset?: number): Promise<Page>;
  queue(offset?: number): Promise<Page>;
  queuePosition(): Promise<{ position: number; total: number }>;
  playCollectionTrack(collection: { id: string; type: string }, track: Media, index: number): Promise<void>;
  command(path: string, body?: unknown, method?: string): Promise<void>;
}

export const stopped: Playback = {
  state: "stopped", nowPlaying: null, time: { currentTime: 0, duration: 0 },
  volume: 0.5, repeatMode: "none", shuffleMode: false,
};

export function duration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
