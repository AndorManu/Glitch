"""Capture the primary screen as numbered PNGs for N seconds (a film of the real app on the desktop).

    python dev/screen-film.py <dir> <seconds> <fps>
"""
import sys
import time
from pathlib import Path

from PIL import ImageGrab

out = Path(sys.argv[1])
secs, fps = float(sys.argv[2]), float(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
t0 = time.time()
i = 0
while time.time() - t0 < secs:
    t = time.time()
    ImageGrab.grab().save(out / f"f{i:04d}.png")
    i += 1
    time.sleep(max(0, 1 / fps - (time.time() - t)))
