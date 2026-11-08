import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiresCommand, hiresSelected } from "../src/hires";

const saved = { player: process.env.PEEL_PLAYER, command: process.env.PEEL_HIRES_COMMAND, state: process.env.XDG_STATE_HOME };
const state = mkdtempSync(join(tmpdir(), "peel-hires-state-"));
afterAll(() => rmSync(state, { recursive: true, force: true }));
afterEach(() => {
  for (const [name, value] of [["PEEL_PLAYER", saved.player], ["PEEL_HIRES_COMMAND", saved.command], ["XDG_STATE_HOME", saved.state]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("hi-res plays where peel-hires is set up, unless another player is chosen", () => {
  process.env.PEEL_HIRES_COMMAND = "/opt/peel-hires";
  process.env.XDG_STATE_HOME = state;
  delete process.env.PEEL_PLAYER;
  expect(hiresCommand()).toEqual(["/opt/peel-hires"]);
  // Installed, but setup has not passed its tests yet.
  expect(hiresSelected()).toBe(false);
  mkdirSync(join(state, "peel-hires"), { recursive: true });
  writeFileSync(join(state, "peel-hires", "seen"), "key\n");
  expect(hiresSelected()).toBe(true);
  process.env.PEEL_PLAYER = "auto";
  expect(hiresSelected()).toBe(true);
  for (const other of ["web", "something-else"]) {
    process.env.PEEL_PLAYER = other;
    expect(hiresSelected()).toBe(false);
  }
  process.env.PEEL_PLAYER = "hires";
  delete process.env.PEEL_HIRES_COMMAND;
  expect(hiresSelected()).toBe(true);
});
