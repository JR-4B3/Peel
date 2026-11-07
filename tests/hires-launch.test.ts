// Captures the arguments Peel passes to systemd-run for the hi-res host, through a stand-in
// systemd-run. It never reaches the user's systemd manager.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "linux" || !existsSync("/run/systemd/system"))("the systemd host gets the folders this Peel resolved", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "peel-hires-launch-"));
  try {
    const bin = join(temporary, "bin"), runtime = join(temporary, "runtime"), argsFile = join(temporary, "arguments");
    await mkdir(bin);
    await mkdir(join(runtime, "systemd"), { recursive: true });
    await writeFile(join(bin, "systemd-run"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$LAUNCH_ARGS"\n', { mode: 0o700 });
    const source = `
      import { ensureHires, hiresHome } from ${JSON.stringify(new URL("../src/hires.ts", import.meta.url).pathname)};
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 300);
      try { await ensureHires({ state: async () => { throw new Error("offline"); } } as any, () => {}, abort.signal); }
      catch (error) { if (!abort.signal.aborted) throw error; }
      console.log(hiresHome);
    `;
    const config = join(temporary, "custom-config"), cache = join(temporary, "custom-cache");
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, LAUNCH_ARGS: argsFile };
    for (const name of ["PEEL_HIRES_HOME", "PEEL_CONFIG_DIR", "PEEL_CACHE_DIR"]) delete env[name];
    const child = Bun.spawn([process.execPath, "-e", source], { env, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output.trim()).toBe(join(config, "peel-hires-host"));
    const args = (await readFile(argsFile, "utf8")).split("\n");
    for (const setting of [`PEEL_HIRES_HOME=${join(config, "peel-hires-host")}`, `PEEL_CONFIG_DIR=${join(config, "peel")}`, `PEEL_CACHE_DIR=${join(cache, "peel")}`,
      `XDG_CONFIG_HOME=${config}`, `XDG_CACHE_HOME=${cache}`]) expect(args).toContain(`--setenv=${setting}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
