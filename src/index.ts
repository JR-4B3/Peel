import { createCliRenderer } from "@opentui/core";
import { Cider } from "./cider";
import { readPreferences, readToken, saveJson } from "./config";
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
    console.log(`Connected. Granted permissions: ${result.scopes.join(", ")}. Run bun start.`);
  } else {
    const preferences = await readPreferences();
    const token = await readToken();
    const player = new Cider(undefined, token);
    const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 10 });
    const model = new Model(player, preferences, value => saveJson("layout.json", value));
    const startup = new AbortController();
    let interval: ReturnType<typeof setInterval> | undefined;
    const ui = new PeelUI(renderer, model, () => { clearInterval(interval); ui.dispose(); renderer.destroy(); });
    ui.startAnimation();
    renderer.on("destroy", () => { startup.abort(); clearInterval(interval); ui.dispose(); });
    void (async () => {
      let startupError: unknown;
      try { await ensureCider(player.base, token, true, text => { model.status = text; model.changed(); }, startup.signal); }
      catch (error) { startupError = error; }
      if (renderer.isDestroyed) return;
      await model.start();
      if (startupError) model.fail(startupError);
      interval = setInterval(() => void model.refresh(), 1000);
    })();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
