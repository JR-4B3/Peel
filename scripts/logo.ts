import { peel, svg } from "../src/logo";

// Writes the logo file from the pixel grid in src/logo.ts.
await Bun.write("assets/peel.svg", svg(peel, 8));
console.log("Wrote assets/peel.svg.");
