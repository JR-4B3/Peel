import { apple, brand, svg } from "../src/logo";

// Writes the logo files from the pixel grids in src/logo.ts.
await Bun.write("assets/peel.svg", svg(apple, 16));
await Bun.write("assets/peel-wordmark.svg", svg(brand(), 8));
console.log("Wrote assets/peel.svg and assets/peel-wordmark.svg.");
