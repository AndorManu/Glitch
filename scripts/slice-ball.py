"""Cut the fetch ball out of art/generated/ball.png into its own sprite sheet.

    python scripts/slice-ball.py            # needs: pip install pillow numpy

ball.png is one row of 12 frames of the ball on a white background: 0-7 the
roll loop (a full turn), 8 squash, 9 stretch, 10 glitch, 11 glow. Same steps
as the animation sheets (scripts/slice-generated.py): background off, pixel
grid recovered (one art px per drawn block, so the ball body is ~23 art px, drawn 1:1 on the overlay,
matching the BALL_R physics radius), palette snapped to the character's,
halo off, binary alpha. Each frame is centred on its ball body (loose glitch
bits stay where they are around it) on a CELL x CELL canvas.

Output:
* public/sprites/ball.png: 13 cells side by side. 0-11 as above; 12 is the
  clean ball body alone, sampled at one art px per block (~12 px): the one he
  carries in his mouth, at his own art scale.
* dev/out/slices-ball.png: contact sheet for review.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("sg", ROOT / "scripts" / "slice-generated.py")
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)

CELL = 40
SCALE = 0.5  # the art is drawn at half-block detail, like the character sheets
N = 12


def body(a: np.ndarray) -> np.ndarray:
    """The ball body: the biggest connected blob."""
    comps = sg._components(a[:, :, 3] > 0)
    return max(comps, key=lambda c: c.sum())


def main() -> None:
    rgb = np.array(Image.open(sg.GEN / "ball.png").convert("RGB"))
    mask = sg.remove_background(rgb)
    rgba = np.dstack([rgb, np.where(mask, 255, 0).astype(np.uint8)])
    rgba[~mask] = 0
    segs = sg.merge_small(sg.segments(mask, min_gap=6), 0.2)
    assert len(segs) == N, f"expected {N} frames, found {len(segs)}"
    crops = []
    for a, b in segs:
        part = rgba[:, a:b]
        ys = np.where(part[:, :, 3].any(1))[0]
        crops.append(part[ys.min() : ys.max() + 1])
    # Block pitch from the whole sheet: one art px per drawn block.
    wide = np.concatenate([np.pad(c, ((0, 260 - c.shape[0]), (0, 0), (0, 0))) for c in crops], 1)
    pitch, _, _ = sg.best_pitch(wide, 4.0, 12.0)
    pitch *= SCALE
    print(f"block pitch {pitch:.2f}")
    frames = []
    for c in crops:
        _, ox, oy = sg.best_pitch(c, pitch - 0.01, pitch + 0.01)
        art = sg.snap_palette(sg.trim(sg.dehalo(sg.sample(c, pitch, ox % pitch, oy % pitch))))
        frames.append(art)
    # The mouth ball is drawn at his art scale, so it is sampled at the full block (~12 art px).
    c7 = crops[7]
    _, ox, oy = sg.best_pitch(c7, pitch * 2 - 0.01, pitch * 2 + 0.01)
    coarse = sg.snap_palette(sg.trim(sg.dehalo(sg.sample(c7, pitch * 2, ox % (pitch * 2), oy % (pitch * 2)))))
    mouth = np.where(body(coarse)[..., None], coarse, 0).astype(np.uint8)
    sheet = Image.new("RGBA", (CELL * (N + 1), CELL))
    review = Image.new("RGBA", (CELL * (N + 1), CELL), (40, 96, 79, 255))
    cells = []
    for f in frames:
        b = body(f)
        ys, xs = np.where(b)
        cy, cx = (ys.min() + ys.max()) // 2, (xs.min() + xs.max()) // 2
        cells.append((f, b, cy, cx))
    sizes = [(b.any(0).sum(), b.any(1).sum()) for _, b, _, _ in cells]
    print("body sizes (w,h):", sizes)
    mb = body(mouth)
    my, mx = np.where(mb)
    for i, (f, b, cy, cx) in enumerate(cells + [(mouth, mb, (my.min() + my.max()) // 2, (mx.min() + mx.max()) // 2)]):
        out = np.zeros((CELL, CELL, 4), np.uint8)
        src = f
        oy, ox = CELL // 2 - cy, CELL // 2 - cx
        for y, x in zip(*np.where(src[:, :, 3] > 0)):
            ty, tx = y + oy, x + ox
            if 0 <= ty < CELL and 0 <= tx < CELL:
                out[ty, tx] = src[y, x]
            else:
                print(f"  WARNING frame {i}: pixel clipped by the {CELL}px canvas")
        im = Image.fromarray(out, "RGBA")
        sheet.alpha_composite(im, (i * CELL, 0))
        review.alpha_composite(im, (i * CELL, 0))
    sheet.save(ROOT / "public" / "sprites" / "ball.png")
    sg.DEV.mkdir(parents=True, exist_ok=True)
    review.resize((review.width * 6, review.height * 6), Image.NEAREST).save(sg.DEV / "slices-ball.png")


if __name__ == "__main__":
    main()
