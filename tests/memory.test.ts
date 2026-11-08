// Peel's memory, read from a stand-in for Linux's cgroup tree and /proc.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { formatBytes, memoryUse } from "../src/memory";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";
import { fixture } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const MB = 1e6;
const stat = (anon: number, file: number, kernel: number, shmem = 0) => `anon ${anon}\nfile ${file}\nkernel ${kernel}\nkernel_stack 1\nshmem ${shmem}\n`;

test.skipIf(process.platform !== "linux")("Peel's memory adds its interface, its players and Android, without file cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-memory-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "cgroup"), proc = join(dir, "proc"), manager = "/user.slice/user-1000.slice/user@1000.service";
  const apps = join(root, manager, "app.slice");
  const group = async (path: string, text: string) => { await mkdir(path, { recursive: true }); await writeFile(join(path, "memory.stat"), text); };
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, "status"), "Name:\tbun\nVmRSS:\t   40000 kB\n");
  await writeFile(join(proc, "cgroup"), `0::${manager}/app.slice/app-ghostty-1.scope\n`);
  // The players in Peel's slice, and one an older Peel started on its own.
  await group(join(apps, "app-peel.slice"), stat(100 * MB, 500 * MB, 10 * MB, 20 * MB));
  await group(join(apps, "peel-engine.service"), stat(50 * MB, 300 * MB, 5 * MB));
  // Someone else's unit is not Peel's.
  await group(join(apps, "firefox.service"), stat(900 * MB, 0, 0));
  await group(join(root, "lxc.payload.waydroid"), stat(800 * MB, 1000 * MB, 90 * MB, 30 * MB));
  const use = await memoryUse(root, proc);
  expect(use!.parts).toEqual([
    { name: "interface", bytes: 40000 * 1024 },
    { name: "players", bytes: 185 * MB },
    { name: "Android", bytes: 920 * MB },
  ]);
  expect(use!.total).toBe(40000 * 1024 + 185 * MB + 920 * MB);
  // Without hi-res there is no Android part, and nothing readable means no row.
  await rm(join(root, "lxc.payload.waydroid"), { recursive: true });
  expect((await memoryUse(root, proc))!.parts.map(part => part.name)).toEqual(["interface", "players"]);
  expect(await memoryUse(join(dir, "none"), join(dir, "none"))).toBeUndefined();
});

test("sizes read in MB, and in GB from a billion bytes", () => {
  expect(formatBytes(40 * MB)).toBe("40 MB");
  expect(formatBytes(1.24e9)).toBe("1.2 GB");
});

test("Settings shows Peel's memory with its parts", async () => {
  const api = fixture(); cleanup.push(() => api.server.stop(true));
  const app = await createTestRenderer({ width: 120, height: 36 }); cleanup.push(() => app.renderer.destroy());
  const model = new Model(api.library, api.player);
  model.readMemory = async () => ({ total: 1.2e9, parts: [{ name: "interface", bytes: 40 * MB }, { name: "players", bytes: 190 * MB }, { name: "Android", bytes: 970 * MB }] });
  const ui = new PeelUI(app.renderer, model); cleanup.push(() => ui.dispose());
  await model.start(); await model.open("settings"); await Bun.sleep(10); ui.tracks.focus(); await app.flush();
  const frame = app.captureCharFrame();
  expect(frame).toContain("Memory");
  expect(frame).toContain("1.2 GB");
});
