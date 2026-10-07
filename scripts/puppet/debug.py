"""Debug views of a rig: the cut labels and each layer on its own.

    python -m scripts.puppet.debug front
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

from . import pixels as px
from .rigs import RIGS

OUT = Path(__file__).resolve().parents[2] / "dev" / "out"
COLS = [(230, 60, 60), (60, 200, 90), (70, 120, 240), (240, 200, 40), (200, 70, 220), (40, 210, 220), (250, 140, 40), (150, 150, 150), (255, 255, 255), (120, 60, 30), (90, 255, 160)]


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "front"
    rig = RIGS[name]()
    h, w = rig.base.shape[:2]
    Z = 6
    tiles = []
    lab = rig.base.copy()
    for i, n in enumerate(rig.layers):
        m = rig.labels == i
        lab[m, :3] = (lab[m, :3].astype(int) * 0.45 + np.array(COLS[i % len(COLS)]) * 0.55).astype(np.uint8)
    tiles.append(lab)
    for L in rig.layers.values():
        t = L.img.copy()
        x, y = int(L.pivot[0]), int(L.pivot[1])
        t[y, x] = (255, 0, 0, 255)
        tiles.append(t)
    per = 4
    rows = (len(tiles) + per - 1) // per
    sheet = Image.new("RGBA", ((w + 2) * per * Z, (h + 2) * rows * Z), (46, 107, 88, 255))
    for i, t in enumerate(tiles):
        im = px.to_image(t).resize((w * Z, h * Z), Image.NEAREST)
        sheet.alpha_composite(im, ((i % per) * (w + 2) * Z, (i // per) * (h + 2) * Z + Z))
    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / f"rig-{name}.png")
    print("wrote", OUT / f"rig-{name}.png", list(rig.layers))


if __name__ == "__main__":
    main()
