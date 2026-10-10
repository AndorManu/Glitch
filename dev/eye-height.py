"""Glitch-eye height above the feet (art px) per frame: a scale check for new sheets.

    python dev/eye-height.py idle-0 hats-0 ...
"""
import sys

import numpy as np
from PIL import Image


def eye(n):
    a = np.array(Image.open(f"art/frames/{n}.png")).astype(int)
    m = (a[..., 0] > 150) & (a[..., 2] > 150) & (a[..., 1] < 90) & (a[..., 3] > 0)
    ys, xs = np.where(a[..., 3] > 0)
    best = None
    for y in range(a.shape[0] - 5):
        for x in range(a.shape[1] - 5):
            c = m[y : y + 5, x : x + 5].sum()
            if best is None or c > best[0]:
                best = (c, y + 2, x + 2)
    return int(ys.max() - best[1])


for n in sys.argv[1:]:
    print(n, eye(n))
