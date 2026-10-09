#!/usr/bin/env bash
# Draws the name in JetBrains Mono, Ghostty's default font, as SVG outlines and a PNG for the
# interface. Needs Inkscape and the JetBrains Mono Nerd Font. Run it on main, where both are installed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
# figlet's Small Slant face without its top row. Lines are 1.3 em apart, close to Ghostty's
# cell height, so the strokes join up as they do in the terminal.
rows=(
  '   ___  ___ ___ / /'
  '  / _ \/ -_) -_) / '
  ' / .__/\__/\__/_/  '
  '/_/                '
)
size=40 advance=24 line=52
{
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">\n' $(( ${#rows[0]} * advance )) $(( ${#rows[@]} * line ))
  printf '<g font-family="JetBrainsMono Nerd Font Mono" font-size="%d" fill="#cdd6f4" xml:space="preserve">\n' $size
  for index in "${!rows[@]}"; do
    text=${rows[$index]//&/&amp;}; text=${text//</&lt;}
    printf '<text x="0" y="%d" textLength="%d">%s</text>\n' $(( index * line + 38 )) $(( ${#rows[$index]} * advance )) "$text"
  done
  printf '</g>\n</svg>\n'
} > "$work/text.svg"
inkscape "$work/text.svg" --export-text-to-path --export-plain-svg --export-filename=assets/peel-wordmark.svg
inkscape assets/peel-wordmark.svg --export-type=png --export-height=208 --export-filename=assets/peel-wordmark.png
echo "Wrote assets/peel-wordmark.svg and assets/peel-wordmark.png."
