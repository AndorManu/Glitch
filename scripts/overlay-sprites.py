"""Build the stream overlay's extra art: the "streamer" reaction sheet.

    python scripts/overlay-sprites.py            # needs: pip install pillow numpy

Uses the same slicer as the app's sprites (scripts/slice-generated.py: white
background removed, frames split, snapped to the art grid, normalised to
the original character's size, feet on the bottom row of a 104x90 canvas),
then lays the 8 frames of art/generated/streamer.png side by side as
public/sprites/streamer.png. Only the overlay page (src/overlay/) draws it,
1.5 CSS px per art px like the app's sheet; the desktop app's sprite sheet
is not touched.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("slicer", ROOT / "scripts" / "slice-generated.py")
slicer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slicer)

OUT = ROOT / "public" / "sprites" / "streamer.png"


def main() -> None:
    report: dict = {}
    # Front view, standing in frame 0, headset on: as tall as idle0 (55 art px).
    frames = slicer.process("streamer", {"n": 8, "ref": 0, "target": 55, "tolerance": 0}, report)
    print("streamer", report["streamer"])
    h, w = frames[0].shape[:2]
    strip = np.zeros((h, w * len(frames), 4), np.uint8)
    for i, f in enumerate(frames):
        strip[:, i * w : (i + 1) * w] = f
    OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(strip, "RGBA").save(OUT, optimize=True)
    print("wrote", OUT.relative_to(ROOT), f"{len(frames)} frames of {w}x{h}")


if __name__ == "__main__":
    main()
