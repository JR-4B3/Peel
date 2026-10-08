import { createCliRenderer } from "@opentui/core";
import { AppleMusic, type AppleOptions } from "./apple";
import { Cider } from "./cider";
import { cacheDir, readAppleSignIn, readCache, readPreferences, readToken, saveJson } from "./config";
import { Engine, ensureEngine } from "./engine";
import { Model } from "./model";
import { PeelUI } from "./ui";
import { ensureCider } from "./startup";

// Peel plays through its own engine. PEEL_PLAYER=cider uses Cider instead.
const useCider = process.env.PEEL_PLAYER === "cider";

try {
  if (process.argv.includes("--help")) {
    console.log("Peel, an OpenTUI Apple Music interface\n\nbun run connect  Sign in to Apple Music once\nbun start        Open the player\n\nAn Apple Music subscription is required.\nSet PEEL_PLAYER=cider to play through Cider, and CIDER_API_BASE for another Cider address.");
  } else if (process.argv.includes("--connect") && useCider) {
    await ensureCider(new Cider().base, "", false, console.log);
    console.log("Approve Peel's access request in Cider. Waiting up to two minutes...");
    const result = await new Cider().connect();
    await saveJson("auth.json", { token: result.token });
    // Peel reads the library from Apple directly with Cider's Apple Music sign-in.
    const apple = await new Cider(undefined, result.token).appleTokens();
    await saveJson("apple.json", apple);
    console.log(`Connected. Granted permissions: ${result.scopes.join(", ")}. Run bun start.`);
  } else if (process.argv.includes("--connect")) {
    const engine = new Engine();
    await ensureEngine(engine, console.log);
    await saveJson("apple.json", await engine.appleTokens());
    console.log("Signed in to Apple Music. Run bun start.");
  } else {
    const preferences = await readPreferences();
    const signIn = await readAppleSignIn();
    const startup = new AbortController();
    const status = (text: string) => { model.status = text; model.changed(); };
    let player: Cider | Engine, options: AppleOptions, wake: () => Promise<void>;
    if (useCider) {
      const token = await readToken();
      const cider = player = new Cider(undefined, token);
      // Without a working sign-in, the library is read through Cider, which means waiting for Cider to start.
      let proxied = false;
      options = {
        proxy: async path => {
          await model.ensurePlayback();
          if (!proxied) { proxied = true; status("Reading your library through Cider. Run peel --connect once so it loads without waiting."); }
          return cider.amapi(path);
        },
      };
      wake = () => ensureCider(cider.base, token, true, status, startup.signal);
    } else {
      const engine = player = new Engine();
      // Without a saved sign-in, Peel waits for the engine, which has one.
      options = {};
      wake = () => ensureEngine(engine, status, startup.signal);
    }
    // A rejected Apple sign-in is renewed from the player once it runs.
    const library = new AppleMusic(signIn.userToken, {
      ...options, storefront: signIn.storefront,
      renewUser: async () => {
        if (!useCider) await model.ensurePlayback();
        const fresh = await player.appleTokens();
        await saveJson("apple.json", fresh);
        return fresh.userToken;
      },
    });
    const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 10 });
    const model = new Model(library, player, preferences, value => saveJson("layout.json", value), {
      read: () => readCache("home.json"), write: value => saveJson("home.json", value, cacheDir),
    });
    model.wake = wake;
    let interval: ReturnType<typeof setInterval> | undefined;
    const ui = new PeelUI(renderer, model, () => { clearInterval(interval); ui.dispose(); renderer.destroy(); });
    ui.startAnimation();
    renderer.on("destroy", () => { startup.abort(); clearInterval(interval); ui.dispose(); });
    interval = setInterval(() => void model.refresh(), 1000);
    void model.start();
    // Start the player alongside browsing, so it is usually ready by the first song.
    model.ensurePlayback().catch(error => { if (!renderer.isDestroyed) model.fail(error); });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
