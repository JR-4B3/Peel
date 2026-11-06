// Peel's playback engine: a hidden MusicKit JS player in castlabs' Electron, which adds
// Widevine. Peel controls it through a local HTTP interface that requires a private key.
const { app, BrowserWindow, components, net, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.env.PEEL_ENGINE_PORT ?? 10768);
// Peel passes the folders for this system. The fallbacks are Linux's.
const home = process.env.PEEL_ENGINE_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "peel-engine");
const cacheDir = process.env.PEEL_CACHE_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "peel");
// Apple accepts the web player's token only from music.apple.com. A tiny real page there
// gives the engine that origin; its content policy allows MusicKit from Apple's CDN.
const page = "https://music.apple.com/robots.txt";
// Peel compares this with the files on disk and restarts an engine that runs older code.
const version = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "engine.js"))).update(fs.readFileSync(__filename)).digest("hex");
const log = text => console.log(`${new Date().toISOString()} ${text}`);
// Tells engines apart, so Peel does not move a queue from an engine into the same engine reached
// another way, such as over SSH and over the network.
const instance = crypto.randomUUID();

app.setPath("userData", home);
app.disableHardwareAcceleration();
// The engine has no window of its own to show, so it stays out of the macOS Dock.
app.dock?.hide();
if (!app.requestSingleInstanceLock()) app.exit(0);

function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(home, name), "utf8")); } catch { return fallback; } }
function writeJson(name, value) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, name), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function developerToken() {
  const cache = path.join(cacheDir, "apple-developer-token.json");
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

// Each Peel sends its process ID. Once every Peel that used the engine has exited, the engine
// quits, so music stops even when a terminal closes before Peel can stop it. The Peel that
// started the engine counts from the start, so a Peel closed while the engine loads stops it too.
const owners = new Set();
const launcher = Number(process.env.PEEL_OWNER);
if (Number.isInteger(launcher) && launcher > 0) owners.add(launcher);
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
setInterval(() => {
  if (!owners.size) return;
  for (const pid of owners) if (!alive(pid)) owners.delete(pid);
  if (!owners.size) { log("every Peel has exited"); app.quit(); }
}, 1000).unref();

const maxBody = 8 * 1024 * 1024;
// Playback gestures wait at most one second to start. A running operation keeps its lock.
// Pause and resume also coordinate device moves and must complete even after a long wait.
const controls = new Set(["toggle", "next", "previous", "jump", "seek", "volume", "shuffle", "toggleShuffle", "toggleRepeat"]);

// Only the page's player methods can be called, by name, with JSON arguments.
function serve(window, key) {
  let calling = Promise.resolve();
  const call = (method, args = []) => {
    if (!/^\w+$/.test(method)) throw new Error("Invalid method");
    const run = () => window.webContents.executeJavaScript(`Promise.resolve().then(() => window.peelEngine ? window.peelEngine.${method}(...${JSON.stringify(args)}) : { ready: false })`);
    if (method === "state") return run();
    const expires = Date.now() + 1000;
    const result = calling.catch(() => {}).then(() => {
      if (controls.has(method) && Date.now() > expires) throw new Error("The player was busy. An old playback control was discarded. Try again.");
      return run();
    });
    calling = result;
    return result;
  };
  http.createServer((request, response) => {
    const reply = (status, value) => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value ?? null));
    };
    // A client that disconnects mid-request must not take the engine down with it.
    handle(request, reply).catch(error => { log(`request failed: ${error?.message ?? error}`); reply(500, { error: "Request failed" }); });
  }).listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}`));

  async function handle(request, reply) {
    if (request.headers["x-peel-key"] !== key) return reply(403, { error: "Wrong engine key" });
    const owner = Number(request.headers["x-peel-owner"]);
    const known = Number.isInteger(owner) && owner > 0;
    // A closing Peel releases the engine. Music stops only when no other Peel still uses it.
    if (request.method === "POST" && request.url === "/release") {
      if (known) owners.delete(owner);
      reply(200, null);
      if (!owners.size) { log("the last Peel has closed"); app.quit(); }
      return;
    }
    if (known) owners.add(owner);
    // Older SSH helpers asked the engine to keep playing after every Peel closed. The music now
    // stops once the last Peel that uses it closes, wherever it was opened.
    if (request.method === "POST" && request.url === "/retain") return reply(200, null);
    try {
      // Peel's largest request queues a few hundred songs. Anything far larger is refused.
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > maxBody) return reply(413, { error: "Request too large" });
      }
      if (request.method === "GET" && request.url === "/state") return reply(200, { ...await call("state"), version, instance });
      if (request.method === "POST" && request.url === "/quit") { reply(200, null); return app.quit(); }
      if (request.method === "POST" && request.url === "/call") {
        const { method, args } = JSON.parse(body || "{}");
        return reply(200, await call(method, args));
      }
      reply(404, { error: "Not found" });
    } catch (error) { reply(500, { error: String(error?.message ?? error) }); }
  }
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
  // A process without a Dock icon on macOS does not come to the front by itself.
  window.webContents.on("did-create-window", popup => { popup.focus(); app.focus({ steal: true }); });
  window.webContents.on("console-message", event => {
    const text = event.message ?? "";
    if (!text.startsWith("peel:")) return;
    const volumeChange = text.match(/^peel:volume ([\d.]+)/);
    if (volumeChange) writeJson("volume.json", { volume: Number(volumeChange[1]) });
    else log(text.slice(5));
  });
  // Closing the hidden window would stop playback; the engine runs until it is stopped.
  window.on("close", event => { if (!quitting) event.preventDefault(); });
  await window.loadURL(page);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, "engine.js"), "utf8"));
  serve(window, key);
});
app.on("window-all-closed", () => {});
// systemd stops the engine with SIGTERM. Electron answers SIGTERM by closing its windows,
// which the handler above refuses, so the engine would hang until systemd aborts it.
let quitting = false;
app.on("before-quit", () => { quitting = true; });
process.on("SIGTERM", () => app.quit());
