"""One contact sheet row per sliced sheet (art/frames): python dev/frames-grid.py idle walk ... -> dev/out/frames-grid.png"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
names = sys.argv[1:]
Z = 2
rows = []
for n in names:
    ims = []
    i = 0
    while (ROOT / "art" / "frames" / f"{n}-{i}.png").exists():
        ims.append(Image.open(ROOT / "art" / "frames" / f"{n}-{i}.png"))
        i += 1
    rows.append((n, ims))
W, H = 100 * Z, 76 * Z
cols = max(len(r[1]) for r in rows)
out = Image.new("RGBA", (60 + cols * (W + 2), len(rows) * (H + 2)), (30, 30, 30, 255))
d = ImageDraw.Draw(out)
for j, (n, ims) in enumerate(rows):
    d.text((2, j * (H + 2) + H // 2), n, fill=(255, 255, 255, 255))
    for i, im in enumerate(ims):
        cell = Image.new("RGBA", (W, H), (46, 107, 88, 255))
        cell.alpha_composite(im.resize((W, H), Image.NEAREST))
        out.alpha_composite(cell, (60 + i * (W + 2), j * (H + 2)))
out.save(ROOT / "dev" / "out" / (sys.argv[0] and "frames-grid.png"))
