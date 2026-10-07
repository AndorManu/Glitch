"""Contact sheets and animated GIFs of baked frames (for review)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from . import pixels as px

BG = (46, 107, 88, 255)
BG2 = (40, 96, 79, 255)


def contact(frames: list[tuple[str, np.ndarray]], cols: int, z: int, path: Path, label: bool = True) -> None:
    h, w = frames[0][1].shape[:2]
    lh = 12 if label else 0
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGBA", ((w * z + 6) * min(cols, len(frames)), (h * z + 6 + lh) * rows), BG)
    d = ImageDraw.Draw(sheet)
    for i, (name, a) in enumerate(frames):
        x = (i % cols) * (w * z + 6) + 3
        y = (i // cols) * (h * z + 6 + lh) + 3
        d.rectangle([x, y, x + w * z - 1, y + h * z - 1], fill=BG2)
        sheet.alpha_composite(px.to_image(a).resize((w * z, h * z), Image.NEAREST), (x, y))
        if label:
            d.text((x + 2, y + h * z + 1), name, fill=(235, 240, 235, 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def gif(frames: list[np.ndarray], durations: list[int], z: int, path: Path) -> None:
    ims = []
    for a in frames:
        bg = Image.new("RGBA", (a.shape[1] * z, a.shape[0] * z), BG)
        bg.alpha_composite(px.to_image(a).resize((a.shape[1] * z, a.shape[0] * z), Image.NEAREST))
        ims.append(bg.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=128))
    path.parent.mkdir(parents=True, exist_ok=True)
    ims[0].save(path, save_all=True, append_images=ims[1:], duration=[max(20, int(d)) for d in durations], loop=0, disposal=1)
