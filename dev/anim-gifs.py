"""Animated GIFs + frame strips of every animation from dev/out/anims.json
(see dev/anim-export.mjs), drawn from public/sprites/glitch-anim.png.

    python dev/anim-gifs.py [name ...]

Offsets (dx/dy) and mirroring are applied; scale/rotation and glitch effects
are not (those are the renderer's live effects): this is for judging the
drawn motion. A faint baseline and centre line show jitter.
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "out"
Z = 3
SCALE = 1.5  # CSS px per art px, as in the app


def load_index():
    src = (ROOT / "src" / "sprites" / "anim.ts").read_text()
    w = int(re.search(r"ANIM_FRAME_W = (\d+)", src).group(1))
    h = int(re.search(r"ANIM_FRAME_H = (\d+)", src).group(1))
    idx = {m.group(1): int(m.group(2)) for m in re.finditer(r"^  (\w+): (\d+),$", src, re.M)}
    alias_src = (ROOT / "src" / "sprites" / "glitch-anim.ts").read_text()
    for m in re.finditer(r'^  (\w+): "(\w+)",$', alias_src, re.M):
        if m.group(2) in idx:
            idx[m.group(1)] = idx[m.group(2)]
    return w, h, idx


def main():
    w, h, idx = load_index()
    sheet = Image.open(ROOT / "public" / "sprites" / "glitch-anim.png").convert("RGBA")
    cols = sheet.width // w
    anims = json.loads((OUT / "anims.json").read_text())
    only = set(sys.argv[1:])
    W, H = (w + 24) * Z, (h + 20) * Z
    for name, keys in anims.items():
        if only and name not in only:
            continue
        frames, durs, strip = [], [], []
        for k in keys:
            i = idx.get(k["frame"], 0)
            f = sheet.crop(((i % cols) * w, (i // cols) * h, (i % cols + 1) * w, (i // cols + 1) * h))
            if k.get("flip"):
                f = f.transpose(Image.FLIP_LEFT_RIGHT)
            canvas = Image.new("RGBA", (W, H), (46, 107, 88, 255))
            d = ImageDraw.Draw(canvas)
            base_y = (h + 12) * Z
            d.line([(0, base_y), (W, base_y)], fill=(30, 80, 64, 255))
            d.line([(W // 2, 0), (W // 2, H)], fill=(38, 92, 75, 255))
            big = f.resize((w * Z, h * Z), Image.NEAREST)
            ox = 12 * Z + round(k["dx"] / SCALE * Z)
            oy = 12 * Z + round(k["dy"] / SCALE * Z)
            canvas.alpha_composite(big, (ox, oy))
            if k.get("glitch"):
                d.text((4, 4), f"g{k['glitch']:.1f}", fill=(255, 120, 255, 255))
            frames.append(canvas.convert("RGB"))
            durs.append(max(20, int(k["ms"])))
            strip.append((canvas, k))
        if not frames:
            continue
        pal = [fr.convert("P", palette=Image.ADAPTIVE, colors=96) for fr in frames]
        pal[0].save(OUT / f"anim-{name}.gif", save_all=True, append_images=pal[1:], duration=durs, loop=0)
        n = min(len(strip), 16)
        s = Image.new("RGBA", (W * n, H + 14), (20, 20, 20, 255))
        d = ImageDraw.Draw(s)
        for j, (c, k) in enumerate(strip[:n]):
            s.alpha_composite(c, (j * W, 0))
            d.text((j * W + 3, H + 2), f"{k['frame']} {int(k['ms'])}ms", fill=(230, 230, 230, 255))
        s.save(OUT / f"strip-{name}.png")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
