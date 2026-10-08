// Prototype: a hidden MusicKit JS player in castlabs' Electron, which adds Widevine.
// It logs timings from launch to playback so they can be compared with Cider's startup.
const { app, BrowserWindow, components, net, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const launched = Number(process.env.PEEL_ENGINE_LAUNCHED ?? Date.now());
const mark = (label, extra = "") => console.log(`[${String(Date.now() - launched).padStart(6)} ms] ${label}${extra ? ` ${extra}` : ""}`);
mark("main process running");

// Apple accepts the web player's token only from music.apple.com. A tiny real page there
// gives the engine that origin; its content policy allows MusicKit from Apple's CDN.
const page = "https://music.apple.com/robots.txt";
app.setPath("userData", path.join(os.homedir(), ".config", "peel-engine"));

async function developerToken() {
  const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "peel", "apple-developer-token.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (cached.expires - Date.now() > 86400000) return cached.token;
  } catch {}
  const html = await (await net.fetch("https://music.apple.com/us/new")).text();
  const script = html.match(/\/assets\/index[^"'\s]*\.js/)[0];
  const source = await (await net.fetch(`https://music.apple.com${script}`)).text();
  for (const token of source.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? []) {
    try { if (JSON.parse(Buffer.from(token.split(".")[1], "base64url")).iss === "AMPWebPlay") return token; } catch {}
  }
  throw new Error("No web player token found");
}

app.whenReady().then(async () => {
  mark("electron ready");
  await components.whenReady();
  mark("widevine ready", JSON.stringify(components.status()));
  const engine = session.fromPartition("persist:peel-engine");
  const token = await developerToken();
  mark("developer token");
  const window = new BrowserWindow({
    show: process.env.PEEL_ENGINE_SHOW === "1", width: 480, height: 320,
    webPreferences: { session: engine, autoplayPolicy: "no-user-gesture-required", additionalArguments: [`--peel-token=${token}`, `--peel-play=${process.env.PEEL_PLAY_TERM ?? ""}`], preload: path.join(__dirname, "preload.js") },
  });
  // Apple's sign-in opens as a popup. It must be visible so the listener can sign in.
  window.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { show: true, width: 520, height: 720, webPreferences: { session: engine } } }));
  window.webContents.on("console-message", (event) => {
    const text = event.message ?? "";
    if (text.startsWith("peel:")) mark(text.slice(5));
    else if (process.env.PEEL_ENGINE_DEBUG) console.log("page:", text);
  });
  await window.loadURL(page);
  mark("page loaded");
  // Injected code is not subject to the page's content policy. The MusicKit script it adds is.
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, "engine.js"), "utf8"));
});
