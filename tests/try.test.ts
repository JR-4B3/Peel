import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryArgument } from "../src/try";
import { checkForUpdate } from "../src/update";

test("--try takes a pull request number, main, or nothing, and passes the other arguments on", () => {
  expect(tryArgument(["--try", "118"])).toEqual({ target: "118", rest: [] });
  expect(tryArgument(["--try", "#118", "--local"])).toEqual({ target: "118", rest: ["--local"] });
  expect(tryArgument(["--try", "main"])).toEqual({ target: "main", rest: [] });
  expect(tryArgument(["--try"])).toEqual({ target: undefined, rest: [] });
  expect(tryArgument(["--remote", "box", "--try"])).toEqual({ target: undefined, rest: ["--remote", "box"] });
  expect(tryArgument(["--try", "--local"])).toEqual({ target: undefined, rest: ["--local"] });
});

test("a test build never updates itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peel-try-"));
  try {
    await writeFile(join(dir, "version.json"), JSON.stringify({ version: "0.1.1-pr118.be400a9", channel: "try", commit: "be400a9", date: "2026-11-15", time: "2026-11-15T12:00:00.000Z" }));
    const result = await checkForUpdate("nightly", true, Date.now(), dir);
    expect(result.message).toContain("never updates");
    expect(result.ready).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
