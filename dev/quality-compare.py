"""Old original-sheet frame vs the new display sheets, at the real display
size on a dark background (DPR 1 and DPR 2), plus a 3x zoom of each.

    python dev/quality-compare.py [frame ...]   -> dev/out/quality-compare.png
"""

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "out" / "quality-compare.png"
BG = (24, 22, 30, 255)


def index():
    src = (ROOT / "src" / "sprites" / "anim.ts").read_text()
    w = int(re.search(r"ANIM_FRAME_W = (\d+)", src).group(1))
    h = int(re.search(r"ANIM_FRAME_H = (\d+)", src).group(1))
    idx = {m.group(1): int(m.group(2)) for m in re.finditer(r"^  (\w+): (\d+),$", src, re.M)}
    return w, h, idx


def frame(sheet: Image.Image, i: int, fw: int, fh: int) -> Image.Image:
    cols = sheet.width // fw
    return sheet.crop(((i % cols) * fw, (i // cols) * fh, (i % cols + 1) * fw, (i // cols + 1) * fh))


def main():
    names = sys.argv[1:] or ["idle0", "walk0", "sit0", "wave4"]
    W, H, idx = index()
    old = Image.open(ROOT / "public" / "sprites" / "glitch.png").convert("RGBA")
    old0 = frame(old, 0, 276, 180)
    s1 = Image.open(ROOT / "public" / "sprites" / "glitch-anim@1x.png").convert("RGBA")
    s2 = Image.open(ROOT / "public" / "sprites" / "glitch-anim@2x.png").convert("RGBA")
    tiles = [("old dpr1", old0.resize((138, 90), Image.LANCZOS)), ("old dpr2", old0)]
    for n in names:
        if n not in idx:
            continue
        tiles.append((f"{n} dpr1", frame(s1, idx[n], round(W * 1.5), round(H * 1.5))))
        tiles.append((f"{n} dpr2", frame(s2, idx[n], W * 3, H * 3)))
    pad = 12
    row1 = sum(t.width for _, t in tiles) + pad * (len(tiles) + 1)
    zoomed = [(l, t.resize((t.width * 3 // (2 if "dpr2" in l else 1), t.height * 3 // (2 if "dpr2" in l else 1)), Image.NEAREST)) for l, t in tiles]
    row2 = sum(t.width for _, t in zoomed) + pad * (len(zoomed) + 1)
    hh = max(t.height for _, t in tiles) + 20
    zh = max(t.height for _, t in zoomed) + 20
    img = Image.new("RGBA", (max(row1, row2), hh + zh + pad * 3), BG)
    d = ImageDraw.Draw(img)
    x = pad
    for label, t in tiles:
        img.alpha_composite(t, (x, pad + hh - 20 - t.height))
        d.text((x, pad + hh - 16), label, fill=(220, 220, 220, 255))
        x += t.width + pad
    x = pad
    for label, t in zoomed:
        img.alpha_composite(t, (x, hh + pad * 2))
        d.text((x, hh + pad * 2 + t.height + 2), label + " (zoom)", fill=(160, 160, 160, 255))
        x += t.width + pad
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
