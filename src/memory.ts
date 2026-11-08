import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// How much memory Peel uses on this computer, read from Linux's cgroups. Peel runs as several
// processes: the interface in the terminal, its players as user units in app-peel.slice, and with
// hi-res, Android in Waydroid's container. Adding up each process's memory counts shared pages
// many times, so each part is read from its cgroup instead. File cache that Linux can reclaim at
// any time is left out.
export interface MemoryUse { total: number; parts: { name: string; bytes: number }[] }

// Units an older Peel started directly in app.slice, before it used app-peel.slice.
const looseUnits = ["peel-engine.service", "peel-hires-host.service", "peel-hires-display.service", "app-peel\\x2dhires\\x2dsession.slice"];

// Memory a cgroup holds that Linux can't simply drop: anonymous, kernel and shared memory.
async function held(group: string) {
  const stat = await readFile(join(group, "memory.stat"), "utf8").catch(() => undefined);
  if (stat === undefined) return undefined;
  const field = (name: string) => Number(stat.match(new RegExp(`^${name} (\\d+)$`, "m"))?.[1] ?? 0);
  return field("anon") + field("kernel") + field("shmem");
}

export async function memoryUse(root = "/sys/fs/cgroup", proc = "/proc/self"): Promise<MemoryUse | undefined> {
  if (process.platform !== "linux") return undefined;
  // The interface is this process. Its terminal shares its cgroup, so its own resident memory counts.
  const interfaceBytes = (await readFile(join(proc, "status"), "utf8").catch(() => "")).match(/^VmRSS:\s+(\d+) kB$/m)?.[1];
  const parts: MemoryUse["parts"] = [];
  if (interfaceBytes) parts.push({ name: "interface", bytes: Number(interfaceBytes) * 1024 });
  // The user manager's cgroup, from this process's own: /user.slice/user-1000.slice/user@1000.service/...
  const own = (await readFile(join(proc, "cgroup"), "utf8").catch(() => "")).match(/^0::(\/.*)$/m)?.[1] ?? "";
  const manager = own.match(/^(.*\/user@\d+\.service)\//)?.[1];
  if (manager) {
    const apps = join(root, manager, "app.slice");
    let players = (await held(join(apps, "app-peel.slice"))) ?? 0;
    const names = new Set(await readdir(apps).catch(() => [] as string[]));
    for (const unit of looseUnits) if (names.has(unit)) players += (await held(join(apps, unit))) ?? 0;
    if (players) parts.push({ name: "players", bytes: players });
  }
  const android = await held(join(root, "lxc.payload.waydroid"));
  if (android) parts.push({ name: "Android", bytes: android });
  if (!parts.length) return undefined;
  return { total: parts.reduce((sum, part) => sum + part.bytes, 0), parts };
}

export function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
