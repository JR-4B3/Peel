import { apple, lineSvg, svg, wordmark } from "../src/logo";

// Writes the logo files from the grids in src/logo.ts.
await Bun.write("assets/peel.svg", svg(apple, 16));
await Bun.write("assets/peel-wordmark.svg", lineSvg(wordmark));
console.log("Wrote assets/peel.svg and assets/peel-wordmark.svg.");
