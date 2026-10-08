// Peel's playback engine: a hidden MusicKit JS player in castlabs' Electron, which adds
// Widevine. Peel controls it through a local HTTP interface that requires a private key.
const { app, BrowserWindow, components, net, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.env.PEEL_ENGINE_PORT ?? 10768);
const home = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "peel-engine");
// Apple accepts the web player's token only from music.apple.com. A tiny real page there
// gives the engine that origin; its content policy allows MusicKit from Apple's CDN.
const page = "https://music.apple.com/robots.txt";
const log = text => console.log(`${new Date().toISOString()} ${text}`);

app.setPath("userData", home);
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.exit(0);

function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(home, name), "utf8")); } catch { return fallback; } }
function writeJson(name, value) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, name), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

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
  throw new Error("Apple Music's web player script no longer contains its developer token.");
}

// Only the page's player methods can be called, by name, with JSON arguments.
function serve(window, key) {
  const call = (method, args = []) => {
    if (!/^\w+$/.test(method)) throw new Error("Invalid method");
    return window.webContents.executeJavaScript(`window.peelEngine ? Promise.resolve(window.peelEngine.${method}(...${JSON.stringify(args)})) : { ready: false }`);
  };
  http.createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value ?? null)); };
    if (request.headers["x-peel-key"] !== key) return reply(403, { error: "Wrong engine key" });
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      if (request.method === "GET" && request.url === "/state") return reply(200, await call("state"));
      if (request.method === "POST" && request.url === "/call") {
        const { method, args } = JSON.parse(body || "{}");
        return reply(200, await call(method, args));
      }
      reply(404, { error: "Not found" });
    } catch (error) { reply(500, { error: String(error?.message ?? error) }); }
  }).listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}`));
}

app.whenReady().then(async () => {
  await components.whenReady();
  const key = crypto.randomBytes(24).toString("hex");
  writeJson("key.json", { port, key });
  const engine = session.fromPartition("persist:peel-engine");
  const token = await developerToken();
  const volume = readJson("volume.json", { volume: 0.5 }).volume;
  const window = new BrowserWindow({
    show: process.env.PEEL_ENGINE_SHOW === "1", width: 480, height: 320,
    webPreferences: { session: engine, autoplayPolicy: "no-user-gesture-required", additionalArguments: [`--peel-token=${token}`, `--peel-volume=${volume}`], preload: path.join(__dirname, "preload.js") },
  });
  // Apple's sign-in opens as a popup. It must be visible so the listener can sign in.
  window.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { show: true, width: 520, height: 720, webPreferences: { session: engine } } }));
  window.webContents.on("console-message", event => {
    const text = event.message ?? "";
    if (!text.startsWith("peel:")) return;
    const volumeChange = text.match(/^peel:volume ([\d.]+)/);
    if (volumeChange) writeJson("volume.json", { volume: Number(volumeChange[1]) });
    else log(text.slice(5));
  });
  // Closing the hidden window would stop playback; the engine runs until it is stopped.
  window.on("close", event => event.preventDefault());
  await window.loadURL(page);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, "engine.js"), "utf8"));
  serve(window, key);
});
app.on("window-all-closed", () => {});
