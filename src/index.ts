import { createCliRenderer } from "@opentui/core";
import { AppleMusic, type AppleOptions } from "./apple";
import { Cider } from "./cider";
import { cacheDir, readAppleSignIn, readCache, readPreferences, readToken, saveJson } from "./config";
import { Engine, ensureEngine, stopEngine } from "./engine";
import { Hires, ensureHires, hiresSelected } from "./hires";
import { DevicePlayer, validHost } from "./remote";
import { DeviceNetwork } from "./devices";
import { Model } from "./model";
import { PeelUI } from "./ui";
import { ensureCider } from "./startup";
import { checkForUpdate, currentBuild, readyVersion, restartCommand } from "./update";

// Peel plays through its own engine. PEEL_PLAYER=cider uses Cider instead. Where the hi-res
// pipeline (hires/) is installed, Apple Music's Android app plays in hi-res unless PEEL_PLAYER=web.
const useCider = process.env.PEEL_PLAYER === "cider";
const useHires = hiresSelected();

try {
  if (process.argv.includes("--remote-host")) {
    await (await import("./remote-host")).runRemoteHost();
  } else if (process.argv.includes("--stop-host")) {
    await Promise.allSettled([new Engine().quit(), new Hires().quit()]);
  } else if (process.argv.includes("--version")) {
    const build = await currentBuild();
    console.log(build ? `Peel ${build.version} (${build.channel}, ${build.commit.slice(0, 7)}, built ${build.date})` : "Peel from a source folder");
  } else if (process.argv.includes("--help")) {
    console.log("Peel, an OpenTUI Apple Music interface\n\nbun run connect  Sign in to Apple Music once\nbun start        Open the player\n\nAn Apple Music subscription is required.\nPress d in Peel to choose which device on the network plays.\n\npeel --remote main  Control main through SSH, keeping its queue there\npeel --local        Control this computer\npeel --stop-host    Stop the playback engine on this computer at once\n\nWhere hi-res (hires/) is installed, Peel plays through it. Set PEEL_PLAYER=web for the web engine,\nor PEEL_PLAYER=cider to play through Cider, and CIDER_API_BASE for another Cider address.");
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
    const remoteOption = process.argv.indexOf("--remote");
    if (remoteOption >= 0) {
      const host = process.argv[remoteOption + 1];
      if (!host || !validHost(host)) throw new Error("Use peel --remote <ssh-host>.");
      if (useCider) throw new Error("Remote control uses Peel's engine. Unset PEEL_PLAYER=cider first.");
      preferences.remote = host;
      preferences.remotes = [...new Set([...(preferences.remotes ?? []), host])];
      await saveJson("layout.json", preferences);
    }
    if (process.argv.includes("--local")) { delete preferences.remote; await saveJson("layout.json", preferences); }
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
      const engine = player = useHires ? new DevicePlayer(preferences.remote, status, new Hires(), ensureHires) : new DevicePlayer(preferences.remote, status);
      // Without a saved sign-in, Peel waits for the engine, which has one.
      options = {};
      wake = () => engine.ensure(startup.signal);
    }
    // A rejected Apple sign-in is renewed from the player once it runs.
    const library = new AppleMusic(signIn.userToken, {
      ...options, storefront: signIn.storefront,
      renewUser: async () => {
        // The hi-res player signs in inside Android and has no token for Peel. This computer's web
        // engine renews it then, also when the player is a hi-res host reached over SSH. An engine
        // started only for this is released afterwards; one that was running keeps running.
        const viaWebEngine = async () => {
          const web = new Engine(), running = await web.state().then(() => true, () => false);
          try { await ensureEngine(web, status, startup.signal); return await web.appleTokens(); }
          finally { if (!running) stopEngine(web); }
        };
        let fresh: { userToken: string; storefront?: string };
        if (useHires) fresh = await viaWebEngine();
        else {
          if (!useCider) await model.ensurePlayback();
          fresh = await player.appleTokens().catch(error => useCider ? Promise.reject(error) : viaWebEngine());
        }
        await saveJson("apple.json", fresh);
        return fresh.userToken;
      },
    });
    const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 10 });
    const model = new Model(library, player, preferences, value => saveJson("layout.json", value), {
      read: () => readCache("home.json"), write: value => saveJson("home.json", value, cacheDir),
    });
    model.wake = wake;
    if (player instanceof DevicePlayer) {
      const devices = player;
      model.outputTargets = preferences.remotes ?? [];
      model.onOutput = async host => { await devices.select(host); model.target = devices.target; model.targetId = devices.peer; };
      // Every Peel on the network is a device. PEEL_DEVICES=off keeps this one off the network.
      if (process.env.PEEL_DEVICES !== "off") {
        const network = new DeviceNetwork({ local: devices.localPlayer() });
        devices.attach(network);
        const show = () => { model.devices = network.views(); model.pairing = network.pairing; model.target = devices.target; model.targetId = devices.peer; model.changed(); };
        network.on("change", show);
        network.on("pairing", (pairing: { name: string }) => { model.status = `${pairing.name} wants to pair. Check the code on both screens.`; show(); });
        model.onPlayOn = id => devices.playOn(id);
        model.onPair = id => { try { network.pair(id); show(); } catch (error) { model.fail(error); } };
        model.onForgetDevices = () => network.forget();
        model.onDevicesOpened = () => network.openForPairing();
        // A Peel that controlled an SSH host and followed the music elsewhere stays on the device
        // network after a restart too, as if its listener had chosen the device.
        devices.onRetarget = () => void model.retarget(async () => {
          const text = devices.applyTarget(); model.target = devices.target; model.targetId = devices.peer;
          if (!devices.host) await model.forgetRemote();
          return text;
        });
        void network.start().catch(error => model.fail(new Error(`Devices on the network are unavailable: ${error instanceof Error ? error.message : String(error)}`)));
      }
    }
    // Updates install in the background and start the next time Peel opens. The settings page
    // shows the result, and choosing another channel checks it at once.
    const updates = (force: boolean) => {
      const channel = model.preferences.channel;
      model.update = { ...model.update, checking: true }; model.changed();
      void checkForUpdate(channel, force).then(result => {
        if (channel !== model.preferences.channel) return;
        const announce = result.ready && !result.older && result.ready !== model.update.ready;
        model.update = { installed: !!result.build, version: result.build?.version, channel: result.build?.channel, message: result.message, ready: result.ready, older: result.older, newEngine: result.newEngine };
        if (announce) model.status = `Peel ${result.ready} is ready. Restart Peel from Settings to start it.`;
        model.changed();
      }, error => {
        model.update = { ...model.update, checking: false, message: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` };
        model.changed();
      });
    };
    model.onChannel = () => { model.update = { ...model.update, message: "Checking for updates..." }; model.changed(); updates(true); };
    model.onCheckUpdate = () => { model.update = { ...model.update, message: "Checking for updates..." }; updates(true); };
    // A restart keeps this computer's engine, so the new Peel finds the music still playing. This
    // process waits for the new one, which keeps the engine owned until the new Peel closes.
    let restartInto: string | undefined;
    model.playsLocally = () => !useCider && player instanceof DevicePlayer && !player.host && !player.peer;
    // The version to start is read again, since another Peel window may have changed it. A change
    // updates the row, so the listener sees what the restart would do before choosing it again.
    model.onRestart = () => void readyVersion().then(next => {
      const shown = model.update;
      if (next.ready && next.ready === shown.ready && next.newEngine === shown.newEngine && next.older === shown.older) { restartInto = next.ready; renderer.destroy(); return; }
      model.update = { ...shown, ...next, ready: next.ready };
      model.status = next.ready ? `Another Peel window installed ${next.ready}. Check the row and choose it again.` : "The update is no longer installed. Check for updates again.";
      model.changed();
    }, error => model.fail(error));
    const restart = async (version: string) => {
      if (player instanceof DevicePlayer) player.detach();
      // OpenTUI restores the terminal right after its destroy event, so the new Peel starts after that.
      await new Promise(resolve => setTimeout(resolve, 0));
      const { cmd, cwd } = restartCommand(version);
      const child = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"], env: process.env });
      // A signal meant for this Peel reaches the new one, which owns the terminal now.
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
      process.exit(await child.exited);
    };
    updates(false);
    let interval: ReturnType<typeof setInterval> | undefined;
    const ui = new PeelUI(renderer, model, () => { clearInterval(interval); ui.dispose(); renderer.destroy(); });
    // q, Ctrl+C, and closing the terminal window all destroy the renderer. The engine stops with it.
    renderer.on("destroy", () => {
      startup.abort(); clearInterval(interval); ui.dispose();
      if (restartInto) void restart(restartInto).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
      else if (!useCider) stopEngine(player as Engine);
    });
    interval = setInterval(() => void model.refresh(), 1000);
    void model.start();
    // Start the player alongside browsing, so it is usually ready by the first song.
    model.ensurePlayback().catch(error => { if (!renderer.isDestroyed) model.fail(error); });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
