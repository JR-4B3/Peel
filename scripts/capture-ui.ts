import { createTestRenderer } from "@opentui/core/testing";
import { mkdir } from "node:fs/promises";
import { fixture } from "../tests/fixture";
import { Model } from "../src/model";
import { PeelUI } from "../src/ui";

await mkdir("evidence", { recursive: true });
const api = fixture();
try {
  for (const width of [48, 80, 120]) {
    const setup = await createTestRenderer({ width, height: 32 });
    const model = new Model(api.library, api.player);
    const ui = new PeelUI(setup.renderer, model);
    try {
      await model.start(); await setup.flush();
      await Bun.write(`evidence/interface-${width}.txt`, setup.captureCharFrame());
      const frame = setup.captureSpans();
      await Bun.write(`evidence/interface-${width}.json`, JSON.stringify(frame, (_, value) => value?.toHex ? value.toHex() : value, 2));
    } finally { ui.dispose(); setup.renderer.destroy(); }
  }
  console.log("Captured the rendered OpenTUI interface at 48, 80, and 120 columns. Fixture data, no real playback.");
} finally { api.server.stop(true); }
