import { createCliRenderer } from "@opentui/core";
import { AppleMusic } from "./apple";
import { Cider } from "./cider";
import { cacheDir, readAppleSignIn, readCache, readPreferences, readToken, saveJson } from "./config";
import { Model } from "./model";
import { PeelUI } from "./ui";
import { ensureCider } from "./startup";

try {
  if (process.argv.includes("--help")) {
    console.log("Peel, an OpenTUI Apple Music interface\n\nbun run connect  Approve Peel in Cider once\nbun start        Open the player\n\nCider and an Apple Music subscription are required.\nSet CIDER_API_BASE for another local API address.");
  } else if (process.argv.includes("--connect")) {
    await ensureCider(new Cider().base, "", false, console.log);
    console.log("Approve Peel's access request in Cider. Waiting up to two minutes...");
    const result = await new Cider().connect();
    await saveJson("auth.json", { token: result.token });
    // Peel reads the library from Apple directly with Cider's Apple Music sign-in.
    const apple = await new Cider(undefined, result.token).appleTokens();
    await saveJson("apple.json", apple);
    console.log(`Connected. Granted permissions: ${result.scopes.join(", ")}. Run bun start.`);
  } else {
    const preferences = await readPreferences();
    const token = await readToken();
    const signIn = await readAppleSignIn();
    const player = new Cider(undefined, token);
    // A rejected Apple sign-in is renewed from Cider when it is running.
    const library = new AppleMusic(signIn.userToken, {
      storefront: signIn.storefront,
      renewUser: async () => {
        const fresh = await player.appleTokens();
        await saveJson("apple.json", fresh);
        return fresh.userToken;
      },
    });
    const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 10 });
    const model = new Model(library, player, preferences, value => saveJson("layout.json", value), {
      read: () => readCache("home.json"), write: value => saveJson("home.json", value, cacheDir),
    });
    const startup = new AbortController();
    model.wake = () => ensureCider(player.base, token, true, text => { model.status = text; model.changed(); }, startup.signal);
    let interval: ReturnType<typeof setInterval> | undefined;
    const ui = new PeelUI(renderer, model, () => { clearInterval(interval); ui.dispose(); renderer.destroy(); });
    ui.startAnimation();
    renderer.on("destroy", () => { startup.abort(); clearInterval(interval); ui.dispose(); });
    interval = setInterval(() => void model.refresh(), 1000);
    void model.start();
    // Start Cider alongside browsing, so it is usually ready by the first song.
    model.ensurePlayback().catch(error => { if (!renderer.isDestroyed) model.fail(error); });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
