"""Where the feet are in each frame of a walk/run sheet (art/frames), to check
the legs really alternate and to measure the stride (the distance a planted
foot travels backwards over a cycle = how far he should move per cycle).

    python dev/feet.py walk run   -> prints per frame the foot blobs' x and the bottom row
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def feet(a: np.ndarray, rows: int = 4):
    op = a[:, :, 3] > 0
    ys = np.where(op.any(1))[0]
    bottom = ys.max()
    band = op[bottom - rows + 1 : bottom + 1]
    cols = band.any(0)
    xs = np.where(cols)[0]
    # The tail sits low on the left in side views: only look right of the body's horizontal middle minus a margin.
    mid = np.where(op.any(0))[0]
    body_left = mid.min() + (mid.max() - mid.min()) * 0.35
    blobs, start = [], None
    for x in range(a.shape[1] + 1):
        on = x < a.shape[1] and cols[x] and x >= body_left
        if on and start is None:
            start = x
        elif not on and start is not None:
            if x - start >= 2:
                blobs.append((start + x - 1) / 2)
            start = None
    return bottom, blobs


def main():
    for name in sys.argv[1:] or ["walk", "run"]:
        i = 0
        print(name)
        while (ROOT / "art" / "frames" / f"{name}-{i}.png").exists():
            a = np.array(Image.open(ROOT / "art" / "frames" / f"{name}-{i}.png").convert("RGBA"))
            b, bl = feet(a)
            print(f"  {i}: bottom {b}  feet x {', '.join(f'{x:.0f}' for x in bl)}  spread {max(bl) - min(bl) if len(bl) > 1 else 0:.0f}")
            i += 1


if __name__ == "__main__":
    main()
