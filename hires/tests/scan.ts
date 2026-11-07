import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const home = homedir();
const user = JSON.parse(readFileSync(`${home}/.config/peel/apple.json`, "utf8"));
const developer = JSON.parse(readFileSync(`${home}/.cache/peel/apple-developer-token.json`, "utf8"));
const headers = { Authorization: `Bearer ${developer.token}`, "Music-User-Token": user.userToken, Origin: "https://music.apple.com" };
for (const term of process.argv.slice(2)) {
  const r = await fetch(`https://amp-api.music.apple.com/v1/catalog/${user.storefront}/search?types=songs&limit=10&extend=audioTraits,extendedAssetUrls&term=${encodeURIComponent(term)}`, { headers });
  for (const s of (await r.json()).results?.songs?.data ?? []) {
    const a = s.attributes;
    if (!a.audioTraits?.includes("hi-res-lossless") || !a.extendedAssetUrls?.enhancedHls) continue;
    const m = await (await fetch(a.extendedAssetUrls.enhancedHls)).text();
    const rates = [...m.matchAll(/audio-alac-stereo-(\d+)-(\d+)/g)].map(x => `${x[1]}/${x[2]}`);
    console.log(s.id, a.artistName, "-", a.name, [...new Set(rates)].join(" "), a.url);
  }
}
