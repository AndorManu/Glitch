"""Contact sheet of frames with their ANIM_HEADS hat point (red) marked.

    python dev/heads-check.py [frame names...]   -> dev/out/heads-check.png
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "src/sprites/anim.ts").read_text(encoding="utf-8")
W = int(re.search(r"ANIM_FRAME_W = (\d+)", src)[1])
H = int(re.search(r"ANIM_FRAME_H = (\d+)", src)[1])
index = {m[1]: int(m[2]) for m in re.finditer(r"^  (\w+): (\d+),$", src.split("ANIM_EYES")[0], re.M)}
heads_block = src.split("ANIM_HEADS")[1].split("};")[0]
heads = {m[1]: (int(m[2]), int(m[3])) for m in re.finditer(r"(\w+): \[(\d+), (\d+)\]", heads_block)}
sheet = Image.open(ROOT / "public/sprites/glitch-anim.png").convert("RGBA")
cols = sheet.width // W
names = sys.argv[1:] or [n for n in index if n.endswith("0") and not n[-2].isdigit()]
z, per = 3, 12
out = Image.new("RGBA", (W * z * per, H * z * ((len(names) + per - 1) // per)), (46, 107, 88, 255))
d = ImageDraw.Draw(out)
for k, n in enumerate(names):
    i = index[n]
    f = sheet.crop(((i % cols) * W, (i // cols) * H, (i % cols + 1) * W, (i // cols + 1) * H)).resize((W * z, H * z), Image.NEAREST)
    ox, oy = (k % per) * W * z, (k // per) * H * z
    out.alpha_composite(f, (ox, oy))
    hx, hy = heads[n]
    d.rectangle([ox + hx * z - 2, oy + hy * z - 2, ox + hx * z + z + 1, oy + hy * z + z + 1], outline=(255, 30, 30, 255), width=2)
    d.text((ox + 3, oy + 3), n, fill=(255, 255, 255, 255))
(ROOT / "dev/out").mkdir(parents=True, exist_ok=True)
out.save(ROOT / "dev/out/heads-check.png")
print(len(names), "frames")
