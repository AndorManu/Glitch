"""Zoom a few frames of the art sheet: python dev/vqa-zoom.py out.png frame [frame...] [--k=6]"""
import re, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parent.parent
FW, FH = 104, 90
src = (ROOT / "src/sprites/anim.ts").read_text()
head, rest = src.split("ANIM_EYES", 1)
INDEX = {m[0]: int(m[1]) for m in re.findall(r"^  (\w+): (\d+),", head, re.M)}
EYES = {m[0]: (int(m[1]), int(m[2])) for m in re.findall(r"^  (\w+): \[(\d+), (\d+)\],", rest.split("ANIM_GRIPS")[0], re.M)}
art = Image.open(ROOT / "public/sprites/glitch-anim.png").convert("RGBA")
COLS = art.width // FW
args = [a for a in sys.argv[2:] if not a.startswith("--")]
k = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--k=")), 5))
out = Image.new("RGB", (len(args) * (FW * k + 6), FH * k + 20), (110, 110, 120))
d = ImageDraw.Draw(out)
for i, n in enumerate(args):
    r, c = divmod(INDEX[n], COLS)
    fr = art.crop((c * FW, r * FH, (c + 1) * FW, (r + 1) * FH)).resize((FW * k, FH * k), Image.NEAREST)
    x0 = i * (FW * k + 6)
    bg = Image.new("RGBA", fr.size, (128, 128, 140, 255))
    # checker so pure grey/white pixels show
    a = np.array(bg)
    for yy in range(0, FH):
        for xx in range(0, FW):
            if (xx + yy) % 2:
                a[yy * k:(yy + 1) * k, xx * k:(xx + 1) * k, :3] = (100, 100, 112)
    bg = Image.fromarray(a)
    bg.alpha_composite(fr)
    dd = ImageDraw.Draw(bg)
    if n in EYES:
        ex, ey = EYES[n]
        dd.rectangle([ex * k - 1, ey * k - 1, ex * k + k, ey * k + k], outline=(0, 255, 255))
    out.paste(bg.convert("RGB"), (x0, 20))
    d.text((x0 + 4, 4), n, fill=(255, 255, 0))
out.save(sys.argv[1])
