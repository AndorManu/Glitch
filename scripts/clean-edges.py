"""Remove the pale halo the white-background cut-out leaves around generated frames.

    python scripts/clean-edges.py [sheet.png ...]   # default: public/sprites/glitch-anim.png

The image generator draws on white; the pixels just outside the dark outline are
a fur/white mix that shows up as a grey fringe on dark desktops. This pass:
  1. peels light, non-magenta pixels off the silhouette edge (a few rounds),
  2. closes the outline: every transparent pixel touching a light body pixel
     becomes outline colour, so the sprite always ends in a crisp dark line.
Magenta glitch bits are left alone (they float free in the original art too).
Runs in place, alpha stays strictly 0/255.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "public" / "sprites" / "glitch-anim.png"

OUTLINE = np.array([27, 20, 26], dtype=np.uint8)  # the dark outline of the original sheet
LIGHT = 70  # luminance above which an edge pixel is fringe, not outline
PEEL_ROUNDS = 2


def neighbours_transparent(opaque: np.ndarray) -> np.ndarray:
    p = np.pad(opaque, 1)
    return ~p[:-2, 1:-1] | ~p[2:, 1:-1] | ~p[1:-1, :-2] | ~p[1:-1, 2:]


def neighbours_any(mask: np.ndarray) -> np.ndarray:
    p = np.pad(mask, 1)
    return p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]


def clean(path: Path, cell: tuple[int, int] | None = None) -> None:
    """Clean a sheet in place; with `cell` = (w, h) each frame cell on its own
    (a frame's top row must not grow outline from the feet of the frame above)."""
    im = np.array(Image.open(path).convert("RGBA"))
    if cell:
        cw, ch = cell
        peeled = closed = 0
        for y in range(0, im.shape[0], ch):
            for x in range(0, im.shape[1], cw):
                sub, p, c = _clean(im[y : y + ch, x : x + cw])
                im[y : y + ch, x : x + cw] = sub
                peeled += p
                closed += c
        Image.fromarray(im).save(path)
        print(f"{path.name}: peeled {peeled} fringe px, closed outline with {closed} px (per {cw}x{ch} cell)")
        return
    im, peeled, closed = _clean(im)
    Image.fromarray(im).save(path)
    print(f"{path.name}: peeled {peeled} fringe px, closed outline with {closed} px")


def _clean(im: np.ndarray) -> tuple[np.ndarray, int, int]:
    im = im.copy()
    rgb = im[..., :3].astype(int)
    lum = rgb[..., 0] * 0.3 + rgb[..., 1] * 0.59 + rgb[..., 2] * 0.11
    magenta = (rgb[..., 0] > 140) & (rgb[..., 2] > 140) & (rgb[..., 1] < 120)
    cyan = (rgb[..., 2] > 150) & (rgb[..., 1] > 150) & (rgb[..., 0] < 120)
    glitchy = magenta | cyan
    opaque = im[..., 3] > 0
    before = opaque.sum()

    for _ in range(PEEL_ROUNDS):
        fringe = opaque & neighbours_transparent(opaque) & (lum > LIGHT) & ~glitchy
        # Never peel thin features to nothing: keep pixels with >= 3 opaque neighbours of dark colour.
        opaque &= ~fringe

    body = opaque & ~glitchy
    light_body_edge = body & (lum > LIGHT)
    close = ~opaque & neighbours_any(light_body_edge)
    im[..., 3] = np.where(opaque, 255, 0)
    im[close, :3] = OUTLINE
    im[close, 3] = 255
    im[~(opaque | close), :] = 0

    return im, int(before - opaque.sum()), int(close.sum())


if __name__ == "__main__":
    for p in sys.argv[1:] or [str(DEFAULT)]:
        clean(Path(p))
