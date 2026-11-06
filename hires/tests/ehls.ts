import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const home = homedir();
const user = JSON.parse(readFileSync(`${home}/.config/peel/apple.json`, "utf8"));
const developer = JSON.parse(readFileSync(`${home}/.cache/peel/apple-developer-token.json`, "utf8"));
const headers = { Authorization: `Bearer ${developer.token}`, "Music-User-Token": user.userToken, Origin: "https://music.apple.com" };
const id = process.argv[2];
const r = await fetch(`https://amp-api.music.apple.com/v1/catalog/${user.storefront}/songs/${id}?extend=extendedAssetUrls`, { headers });
const s = (await r.json()).data?.[0];
const urls = s?.attributes?.extendedAssetUrls ?? {};
console.log(Object.keys(urls));
if (urls.enhancedHls) {
  console.log(urls.enhancedHls.replace(/\?.*/, ""));
  const m = await (await fetch(urls.enhancedHls)).text();
  for (const line of m.split("\n")) if (/EXT-X-MEDIA:|EXT-X-STREAM-INF/.test(line)) console.log(line.replace(/STABLE-VARIANT-ID="[^"]*",?/, "").slice(0, 200));
}
