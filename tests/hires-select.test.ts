import { afterEach, expect, test } from "bun:test";
import { hiresCommand, hiresSelected } from "../src/hires";

const saved = { player: process.env.PEEL_PLAYER, command: process.env.PEEL_HIRES_COMMAND };
afterEach(() => {
  for (const [name, value] of [["PEEL_PLAYER", saved.player], ["PEEL_HIRES_COMMAND", saved.command]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("hi-res plays where peel-hires is found, unless another player is chosen", () => {
  process.env.PEEL_HIRES_COMMAND = "/opt/peel-hires";
  delete process.env.PEEL_PLAYER;
  expect(hiresCommand()).toEqual(["/opt/peel-hires"]);
  expect(hiresSelected()).toBe(true);
  process.env.PEEL_PLAYER = "auto";
  expect(hiresSelected()).toBe(true);
  for (const other of ["web", "cider"]) {
    process.env.PEEL_PLAYER = other;
    expect(hiresSelected()).toBe(false);
  }
  process.env.PEEL_PLAYER = "hires";
  delete process.env.PEEL_HIRES_COMMAND;
  expect(hiresSelected()).toBe(true);
});
