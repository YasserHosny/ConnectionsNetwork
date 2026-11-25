#!/usr/bin/env bash
# Rebuilds public/fonts/material-symbols-outlined.woff2: Material Symbols Outlined at the axes the
# app uses (FILL 0, GRAD 0, opsz 24, wght 400), cut down to the icons in material-icons.txt (a few
# KB instead of 4 MB). Run it after adding an icon; check-icons.mjs fails lint until you do.
# Needs npm and uv (fontTools runs in a throwaway environment).
set -euo pipefail

VERSION=0.49.0
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../public/fonts/material-symbols-outlined.woff2"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(cd "$tmp" && npm pack --silent "material-symbols@$VERSION" >/dev/null && tar xzf material-symbols-*.tgz)

uv run --quiet --with fonttools --with brotli python - "$tmp/package/material-symbols-outlined.woff2" "$out" \
  $(grep -v '^\s*$' "$here/material-icons.txt") <<'PY'
import sys
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

source, out, *icons = sys.argv[1:]
font = instantiateVariableFont(TTFont(source), {"FILL": 0, "GRAD": 0, "opsz": 24, "wght": 400})
chars = "abcdefghijklmnopqrstuvwxyz_0123456789"
cmap = font.getBestCmap()
options = Options()
options.layout_features = ["liga", "rlig"]
options.layout_closure = False  # keep only these ligatures, not every icon spelled with the letters
options.flavor = "woff2"
subsetter = Subsetter(options)
subsetter.populate(glyphs=icons + [cmap[ord(c)] for c in chars if ord(c) in cmap], unicodes=[ord(c) for c in chars])
subsetter.subset(font)
font.save(out)
print(f"{out}: {len(icons)} icons")
PY
