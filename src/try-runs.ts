// Which test builds (peel --try, src/try.ts) run now. While a test build runs, peel --try keeps a
// record of it in <hi-res home>/try/<pid>.json: the build's folder, its version, and the processes
// that use it, which are peel --try itself and the test build it started. A record counts while
// one of those processes runs, so a record left behind by a crash or a closed terminal ends by
// itself, and the next peel --try deletes it. A process ID that the system gives to another
// program after a crash keeps the record until that program exits.
//
// The test builds' folders stay while a record names them (#123). A hi-res host that runs a
// test build's code stays while its test build runs, and an installed Peel restarts it once the
// test build ended (#124, outdated in src/hires.ts).
//
// The hi-res host's code imports this file, so it imports none of Peel's other modules.
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TestRun { dir: string; version: string; pids: number[] }

// peel --try gives a test build a version that says so: 0.1.1-try.pr118.be400a9.
export const testVersion = (version?: string) => /^[^-]+-try\./.test(version ?? "");

// A process that runs as another user answers EPERM, and runs too.
export function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// The records of test builds that run, and the files of records that ended or cannot be read.
// It reads synchronously, since Peel asks before each command it sends to the hi-res host.
export function testRuns(folder: string) {
  const live: TestRun[] = [], ended: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(folder).filter(name => /^\d+\.json$/.test(name)); } catch {}
  for (const name of names) {
    const file = join(folder, name);
    let run: TestRun | undefined;
    try { run = JSON.parse(readFileSync(file, "utf8")); } catch {}
    if (run && typeof run.dir === "string" && typeof run.version === "string" && Array.isArray(run.pids) && run.pids.some(alive)) live.push(run);
    else ended.push(file);
  }
  return { live, ended };
}

// Writes the record of this process's test build. Writing it again replaces it. The rename makes
// a reader see the old record or the new one, never a part.
export async function recordTestRun(folder: string, run: TestRun, pid = process.pid) {
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${pid}.json`), partial = `${file}.${Date.now()}.tmp`;
  await writeFile(partial, JSON.stringify(run) + "\n");
  await rename(partial, file);
}

export async function endTestRun(folder: string, pid = process.pid) {
  await rm(join(folder, `${pid}.json`), { force: true });
}
