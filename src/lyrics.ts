// Lyrics for the playing song: Apple Music's time-synced lyrics, then LRCLIB's, cached per song.
// Nothing here runs unless the lyrics pane is open.

export interface LyricLine { start: number; end: number; text: string }

export interface Lyrics {
  lines: LyricLine[];
  // False when the source has words but no timing. The pane then scrolls with the song's progress.
  synced: boolean;
  instrumental?: boolean;
  source: "Apple Music" | "LRCLIB";
}

export interface LyricsSong { catalogId?: string; name: string; artist: string; album: string; duration: number }

// Apple's TTML clock values: "12.3", "1:02.345", or "1:02:03.4".
export function parseClock(value: string): number {
  const text = value.trim().replace(/s$/, "");
  if (!text) return NaN;
  const parts = text.split(":").map(Number);
  if (parts.some(part => !Number.isFinite(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) =>
    name[0] === "#" ? String.fromCodePoint(name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
    : entities[name.toLowerCase()] ?? whole);
}

// Removes background-vocal spans, which can contain their own word spans.
function withoutBackground(body: string) {
  let out = "", depth = 0, skipping = 0;
  for (const part of body.split(/(<\/?span\b[^>]*>)/)) {
    if (part.startsWith("<span")) {
      depth++;
      if (!skipping && /ttm:role="x-bg"/.test(part)) { skipping = depth; continue; }
    } else if (part.startsWith("</span")) {
      if (skipping === depth) { skipping = 0; depth--; continue; }
      depth--;
    }
    if (!skipping) out += part;
  }
  return out;
}

// Apple's TTML: one <p begin end> per line, words in <span>s when timed by syllable, and
// background vocals in spans with ttm:role="x-bg", which are left out.
export function parseTtml(ttml: string): Lyrics | undefined {
  const timing = ttml.match(/itunes:timing="(\w+)"/)?.[1];
  const lines: LyricLine[] = [];
  for (const match of ttml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = match[1] ?? "";
    const body = withoutBackground(match[2] ?? "");
    const text = decode(body.replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = parseClock(attrs.match(/\bbegin="([^"]+)"/)?.[1] ?? "");
    const end = parseClock(attrs.match(/\bend="([^"]+)"/)?.[1] ?? "");
    lines.push({ start, end, text });
  }
  if (!lines.length) return undefined;
  const synced = timing !== "None" && lines.every(line => Number.isFinite(line.start));
  return { lines: synced ? finish(lines) : lines.map(line => ({ ...line, start: NaN, end: NaN })), synced, source: "Apple Music" };
}

// LRC: "[mm:ss.xx]text", possibly several timestamps per line, and an [offset:±ms] tag.
export function parseLrc(lrc: string): LyricLine[] {
  const offset = Number(lrc.match(/^\[offset:\s*([+-]?\d+)\]/m)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const stamp of stamps) lines.push({ start: Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2]) - offset), end: NaN, text });
  }
  // Empty timestamped lines mark breaks: they end the line before them, then are dropped.
  return finish(lines).filter(line => line.text);
}

// Sorts by start time and fills in missing end times with the next line's start.
function finish(lines: LyricLine[]): LyricLine[] {
  lines.sort((a, b) => a.start - b.start);
  return lines.map((line, index) => {
    const next = lines[index + 1]?.start ?? Infinity;
    return { ...line, end: Number.isFinite(line.end) && line.end > line.start ? Math.min(line.end, next) : next };
  });
}

// The line sung at `time`, or -1 before the first line and in gaps between lines.
export function lineAt(lines: LyricLine[], time: number): number {
  let low = 0, high = lines.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.start <= time) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found >= 0 && time < lines[found]!.end ? found : -1;
}

// The time at which lineAt's answer next changes, for scheduling one timer.
export function nextChange(lines: LyricLine[], time: number): number {
  const index = lineAt(lines, time);
  if (index >= 0) return lines[index]!.end;
  for (const line of lines) if (line.start > time) return line.start;
  return Infinity;
}

const confirmedAbsence = 6 * 60 * 60 * 1000;
const cacheSize = 64;

export interface LyricsOptions {
  // Apple Music's TTML for a catalog song, or undefined when Apple has none.
  apple?: (catalogId: string) => Promise<string | undefined>;
  lrclib?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

// Resolves lyrics: Apple first, LRCLIB second. A song with no lyrics anywhere is remembered for a
// few hours; network failures are not remembered, so the next look tries again.
export class LyricsSource {
  private cache = new Map<string, { value: Lyrics | null; at: number }>();
  private pending = new Map<string, Promise<Lyrics | null>>();
  private lrclib: string;
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private options: LyricsOptions = {}) {
    this.lrclib = (options.lrclib ?? process.env.LRCLIB_BASE ?? "https://lrclib.net").replace(/\/$/, "");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  static key(song: LyricsSong) { return song.catalogId && /^\d+$/.test(song.catalogId) ? song.catalogId : `${song.artist}\n${song.name}\n${song.album}`; }

  // The cached answer, if there is one, without looking anything up.
  peek(song: LyricsSong): Lyrics | null | undefined {
    const hit = this.cache.get(LyricsSource.key(song));
    if (!hit) return undefined;
    if (hit.value === null && this.now() - hit.at > confirmedAbsence) return undefined;
    return hit.value;
  }

  get(song: LyricsSong): Promise<Lyrics | null> {
    const key = LyricsSource.key(song);
    const cached = this.peek(song);
    if (cached !== undefined) return Promise.resolve(cached);
    let request = this.pending.get(key);
    if (!request) {
      request = this.resolve(song).then(value => {
        this.cache.delete(key); this.cache.set(key, { value, at: this.now() });
        while (this.cache.size > cacheSize) this.cache.delete(this.cache.keys().next().value!);
        return value;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, request);
    }
    return request;
  }

  private async resolve(song: LyricsSong): Promise<Lyrics | null> {
    // Apple's untimed lyrics are kept in case LRCLIB has no timed version.
    let apple: Lyrics | undefined, appleFailure: unknown;
    if (this.options.apple && song.catalogId && /^\d+$/.test(song.catalogId)) {
      try {
        const ttml = await this.options.apple(song.catalogId);
        apple = ttml ? parseTtml(ttml) : undefined;
        if (apple?.synced) return apple;
      } catch (error) { appleFailure = error; }
    }
    let other: Lyrics | null;
    try { other = await this.fromLrclib(song); }
    catch (error) { if (apple) return apple; throw appleFailure ?? error; }
    if (other) return other;
    if (apple) return apple;
    // "No lyrics" is only certain when Apple answered too.
    if (appleFailure) throw appleFailure;
    return null;
  }

  private async request(path: string): Promise<any> {
    const response = await this.fetch(`${this.lrclib}${path}`, {
      headers: { "Lrclib-Client": "Peel (https://github.com/JR-4B3/Peel)", "User-Agent": "Peel (https://github.com/JR-4B3/Peel)" },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}.`);
    return response.json();
  }

  private async fromLrclib(song: LyricsSong): Promise<Lyrics | null> {
    if (!song.name || !song.artist) return null;
    const query = (fields: Record<string, string | number>) => new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString();
    let record = song.duration > 0
      ? await this.request(`/api/get?${query({ track_name: song.name, artist_name: song.artist, album_name: song.album, duration: Math.round(song.duration) })}`)
      : undefined;
    if (!record) {
      // The exact lookup needs the album and duration to match. A search tolerates differences.
      const results: any[] = await this.request(`/api/search?${query({ track_name: song.name, artist_name: song.artist })}`) ?? [];
      const close = (item: any) => !(song.duration > 0) || Math.abs((item.duration ?? 0) - song.duration) <= 3;
      record = results.find(item => item.syncedLyrics && close(item)) ?? results.find(item => (item.plainLyrics || item.instrumental) && close(item));
    }
    if (!record) return null;
    if (record.instrumental) return { lines: [], synced: false, instrumental: true, source: "LRCLIB" };
    const synced = typeof record.syncedLyrics === "string" ? parseLrc(record.syncedLyrics) : [];
    if (synced.length) return { lines: synced, synced: true, source: "LRCLIB" };
    const plain = typeof record.plainLyrics === "string" ? record.plainLyrics.split(/\r?\n/).map((text: string) => text.trim()).filter(Boolean) : [];
    return plain.length ? { lines: plain.map((text: string) => ({ start: NaN, end: NaN, text })), synced: false, source: "LRCLIB" } : null;
  }
}
