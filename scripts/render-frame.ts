// Render the captured OpenTUI cells as a portable SVG. This does not create UI state.
export {};
const [input = "evidence/interface-120.json", output = input.replace(/\.json$/, ".svg")] = process.argv.slice(2);
const frame = await Bun.file(input).json();
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const colour = (value: any) => {
  const buffer = value.buffer;
  return `rgb(${buffer[0]},${buffer[1]},${buffer[2]})`;
};
const cell = 8.4, height = 20, margin = 12;
const elements = [`<rect width="100%" height="100%" fill="#101419"/>`];
frame.lines.forEach((line: any, row: number) => {
  let column = 0;
  for (const span of line.spans) {
    const x = margin + column * cell, y = margin + row * height, width = span.width * cell;
    elements.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${colour(span.bg)}"/>`);
    if (span.text.trim()) elements.push(`<text x="${x}" y="${y + 15}" fill="${colour(span.fg)}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${escape(span.text)}</text>`);
    column += span.width;
  }
});
await Bun.write(output, `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.cols * cell + margin * 2}" height="${frame.rows * height + margin * 2}" font-family="monospace" font-size="14" xml:space="preserve">${elements.join("\n")}</svg>\n`);
console.log(`Rendered captured terminal cells to ${output}`);
