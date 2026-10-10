"""Pixel-art image helpers for the puppet (RGBA numpy arrays, binary alpha).

Everything works on the art's own pixel grid: no blur, no resampling except
RotSprite for small rotations (Scale2x three times, nearest rotation, sample
back), which keeps outlines one pixel wide and colours from the palette.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw

OUTLINE = np.array([12, 10, 24, 255], np.uint8)


def load(path) -> np.ndarray:
    a = np.array(Image.open(path).convert("RGBA"))
    a[:, :, 3] = np.where(a[:, :, 3] > 127, 255, 0)
    a[a[:, :, 3] == 0] = 0
    return a


def to_image(a: np.ndarray) -> Image.Image:
    return Image.fromarray(a, "RGBA")


def blank(w: int, h: int) -> np.ndarray:
    return np.zeros((h, w, 4), np.uint8)


def opaque(a: np.ndarray) -> np.ndarray:
    return a[:, :, 3] > 0


def poly_mask(shape, polys) -> np.ndarray:
    """Union of polygons [(x, y), ...] in pixel coords (inclusive of edge pixels)."""
    img = Image.new("L", (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    for poly in polys:
        if len(poly) == 2 and not isinstance(poly[0], (tuple, list)):
            continue
        if len(poly) == 2:  # a rectangle given as two corners
            (x0, y0), (x1, y1) = poly
            d.rectangle([x0, y0, x1, y1], fill=255)
        else:
            d.polygon([tuple(p) for p in poly], fill=255, outline=255)
    return np.array(img) > 0


def masked(a: np.ndarray, m: np.ndarray) -> np.ndarray:
    out = a.copy()
    out[~m] = 0
    return out


def is_dark(a: np.ndarray) -> np.ndarray:
    """Outline-ish pixels (near black)."""
    rgb = a[:, :, :3].astype(int)
    return (rgb.sum(2) < 110) & opaque(a)


def shift(a: np.ndarray, dx: int, dy: int) -> np.ndarray:
    h, w = a.shape[:2]
    out = np.zeros_like(a)
    xs0, xs1 = max(0, -dx), min(w, w - dx)
    ys0, ys1 = max(0, -dy), min(h, h - dy)
    if xs1 > xs0 and ys1 > ys0:
        out[ys0 + dy : ys1 + dy, xs0 + dx : xs1 + dx] = a[ys0:ys1, xs0:xs1]
    return out


def over(dst: np.ndarray, src: np.ndarray, dx: int = 0, dy: int = 0) -> None:
    """Paste src over dst (binary alpha) at an offset, clipped."""
    h, w = src.shape[:2]
    H, W = dst.shape[:2]
    x0, y0 = max(0, dx), max(0, dy)
    x1, y1 = min(W, dx + w), min(H, dy + h)
    if x1 <= x0 or y1 <= y0:
        return
    s = src[y0 - dy : y1 - dy, x0 - dx : x1 - dx]
    m = s[:, :, 3] > 0
    dst[y0:y1, x0:x1][m] = s[m]


def neighbours4(m: np.ndarray) -> np.ndarray:
    out = np.zeros_like(m)
    out[1:] |= m[:-1]
    out[:-1] |= m[1:]
    out[:, 1:] |= m[:, :-1]
    out[:, :-1] |= m[:, 1:]
    return out


def underfill(a: np.ndarray, region: np.ndarray, max_steps: int = 40, avoid_dark: bool = True) -> np.ndarray:
    """Grow the layer's colours into transparent pixels of `region` (hidden
    areas another part used to cover), preferring non-outline colours, so the
    part has no hole when the covering part moves."""
    a = a.copy()
    for _ in range(max_steps):
        op = opaque(a)
        todo = region & ~op & neighbours4(op)
        if not todo.any():
            break
        dark = is_dark(a) if avoid_dark else np.zeros_like(op)
        ys, xs = np.where(todo)
        new = a.copy()
        for y, x in zip(ys, xs):
            cands, darks = [], []
            for oy, ox in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
                yy, xx = y + oy, x + ox
                if 0 <= yy < a.shape[0] and 0 <= xx < a.shape[1] and op[yy, xx]:
                    (darks if dark[yy, xx] else cands).append(tuple(a[yy, xx]))
            pick = cands or darks
            if pick:
                new[y, x] = max(set(pick), key=pick.count)
        a = new
    return a


def reoutline(a: np.ndarray, region: np.ndarray | None = None) -> np.ndarray:
    """Pixels on the silhouette edge (inside `region`) become outline colour."""
    a = a.copy()
    op = opaque(a)
    edge = op & neighbours4(~op)
    if region is not None:
        edge &= region
    a[edge] = OUTLINE
    return a


def add_outline(a: np.ndarray) -> np.ndarray:
    """Grow a 1px outline around the silhouette."""
    a = a.copy()
    op = opaque(a)
    ring = neighbours4(op) & ~op
    a[ring] = OUTLINE
    return a


# ---------------------------------------------------------------- RotSprite

def scale2x(a: np.ndarray) -> np.ndarray:
    """EPX / Scale2x on RGBA (pixels compared exactly)."""
    h, w = a.shape[:2]
    key = (a[:, :, 0].astype(np.int64) << 24) | (a[:, :, 1].astype(np.int64) << 16) | (a[:, :, 2].astype(np.int64) << 8) | a[:, :, 3]
    p = np.pad(key, 1, mode="edge")
    P = p[1:-1, 1:-1]
    A = p[:-2, 1:-1]
    B = p[1:-1, 2:]
    C = p[1:-1, :-2]
    D = p[2:, 1:-1]
    pa = np.pad(a, ((1, 1), (1, 1), (0, 0)), mode="edge")
    up = pa[:-2, 1:-1]
    right = pa[1:-1, 2:]
    left = pa[1:-1, :-2]
    down = pa[2:, 1:-1]
    out = np.repeat(np.repeat(a, 2, 0), 2, 1)
    c1 = (C == A) & (C != D) & (A != B)
    c2 = (A == B) & (A != C) & (B != D)
    c3 = (D == C) & (D != B) & (C != A)
    c4 = (B == D) & (B != A) & (D != C)
    out[0::2, 0::2][c1] = up[c1]
    out[0::2, 1::2][c2] = right[c2]
    out[1::2, 0::2][c3] = left[c3]
    out[1::2, 1::2][c4] = down[c4]
    return out


def rotsprite(a: np.ndarray, deg: float, px: float, py: float) -> np.ndarray:
    """Rotate `a` by `deg` (counter-clockwise on screen) about pixel (px, py)."""
    if abs(deg) < 0.01:
        return a
    return _rot_cached(a.tobytes(), a.shape, round(deg, 2), px, py)


@lru_cache(maxsize=4096)
def _rot_cached(buf: bytes, shape, deg: float, px: float, py: float) -> np.ndarray:
    a = np.frombuffer(buf, np.uint8).reshape(shape)
    big = scale2x(scale2x(scale2x(a)))
    img = Image.fromarray(big, "RGBA")
    c = ((px + 0.5) * 8, (py + 0.5) * 8)
    r = np.array(img.rotate(deg, resample=Image.NEAREST, center=c, expand=False))
    out = r[4::8, 4::8].copy()
    out[out[:, :, 3] < 128] = 0
    out[:, :, 3] = np.where(out[:, :, 3] > 0, 255, 0)
    return out


# ------------------------------------------------------------ deformations

def stretch_rows(a: np.ndarray, row: int, n: int) -> np.ndarray:
    """n > 0: duplicate row `row` n times, pushing everything above it up.
    n < 0: delete |n| rows at `row`, pulling everything above down."""
    if n == 0:
        return a
    h = a.shape[0]
    if n > 0:
        rep = np.repeat(a[row : row + 1], n, 0)
        stacked = np.concatenate([a[:row], rep, a[row:]], 0)  # h + n rows
        return stacked[n:]  # drop n rows at the top: the part grew upward
    n = -n
    stacked = np.concatenate([np.zeros((n,) + a.shape[1:], a.dtype), a[:row], a[row + n :]], 0)
    return stacked[:h]


def stretch_cols(a: np.ndarray, col: int, n: int) -> np.ndarray:
    """Like stretch_rows but horizontal, growing symmetrically is up to the caller."""
    return np.transpose(stretch_rows(np.transpose(a, (1, 0, 2)), col, n), (1, 0, 2))


def recolor(a: np.ndarray, mapping: dict) -> np.ndarray:
    out = a.copy()
    for src, dst in mapping.items():
        m = np.all(a[:, :, :3] == np.array(src[:3]), axis=2) & opaque(a)
        out[m, :3] = dst[:3]
    return out


def darken(a: np.ndarray, f: float = 0.72) -> np.ndarray:
    out = a.copy()
    op = opaque(a)
    out[op, :3] = (out[op, :3].astype(float) * f).astype(np.uint8)
    return out


def hexrgb(h: str):
    n = int(h.lstrip("#"), 16)
    return np.array([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], np.uint8)


def grid_to_array(rows, palette: dict) -> np.ndarray:
    """Text grid -> RGBA (chars from `palette`, '.' clear)."""
    h, w = len(rows), max(len(r) for r in rows)
    out = np.zeros((h, w, 4), np.uint8)
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            if ch in palette:
                out[y, x] = palette[ch]
    return out
