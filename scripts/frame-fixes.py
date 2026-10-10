"""Per-frame art fixes applied by pack-sprites.py after slicing (visual QA
2026-10-07, docs/testing/visual-qa-2026-10-07.md).

- every frame: small detached non-glitch bits touching the top edge (sheet
  bleed from the cell above: a dark dash over his head, S2-1) are dropped;
- FIXES: frame-specific repairs (blue glitch eye recoloured to the magenta
  ramp, stray marks erased, a white wedge repainted).
"""

from __future__ import annotations

import numpy as np

OUTLINE = (12, 10, 24)


def _components(m: np.ndarray) -> list[np.ndarray]:
    """8-connected components of a mask."""
    h, w = m.shape
    seen = np.zeros_like(m)
    out = []
    for y0, x0 in zip(*np.where(m)):
        if seen[y0, x0]:
            continue
        pts, q = [], [(y0, x0)]
        seen[y0, x0] = True
        while q:
            y, x = q.pop()
            pts.append((y, x))
            for yy in range(y - 1, y + 2):
                for xx in range(x - 1, x + 2):
                    if 0 <= yy < h and 0 <= xx < w and m[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        q.append((yy, xx))
        c = np.zeros_like(m)
        ys, xs = zip(*pts)
        c[list(ys), list(xs)] = True
        out.append(c)
    return sorted(out, key=lambda c: -c.sum())


def glitchy(a: np.ndarray) -> np.ndarray:
    v = a[:, :, :3].astype(int)
    return (a[:, :, 3] > 0) & (((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 0] < 120)))


def magenta(a: np.ndarray) -> np.ndarray:
    v = a[:, :, :3].astype(int)
    return (a[:, :, 3] > 0) & (v[..., 0] > 150) & (v[..., 2] > 180) & (v[..., 1] < 110)


def drop_top_bleed(a: np.ndarray, rows: int = 2, max_px: int = 16) -> tuple[np.ndarray, int]:
    """Detached non-glitch pieces (< max_px) touching the top `rows` rows: bleed from the cell above."""
    op = a[:, :, 3] > 0
    comps = _components(op)
    if len(comps) < 2:
        return a, 0
    out = a.copy()
    n = 0
    for c in comps[1:]:
        if c[:rows].any() and c.sum() < max_px and not (glitchy(a) & c).any():
            out[c] = 0
            n += int(c.sum())
    return out, n


def repaint(a: np.ndarray, mask: np.ndarray, iters: int = 24) -> np.ndarray:
    """Fill `mask` from its opaque neighbours (most common colour), from the edge in."""
    out = a.copy()
    todo = mask.copy()
    h, w = mask.shape
    for _ in range(iters):
        if not todo.any():
            break
        done = []
        for y, x in zip(*np.where(todo)):
            cols = {}
            for yy in range(max(0, y - 1), min(h, y + 2)):
                for xx in range(max(0, x - 1), min(w, x + 2)):
                    if (yy, xx) != (y, x) and not todo[yy, xx] and out[yy, xx, 3] > 0:
                        k = tuple(out[yy, xx, :3])
                        cols[k] = cols.get(k, 0) + 1
            if cols:
                done.append((y, x, max(cols, key=cols.get)))
        for y, x, c in done:
            out[y, x, :3] = c
            out[y, x, 3] = 255
            todo[y, x] = False
    return out


def recolour_blue_eye(a: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Blue / cyan glitch-eye pixels -> the magenta ramp of `ref` (matched by brightness)."""
    v = a[:, :, :3].astype(int)
    blue = (a[:, :, 3] > 0) & (v[..., 2] > 140) & (v[..., 0] < 130) & (v[..., 2] - v[..., 1] > 40)
    ramp = ref[magenta(ref)][:, :3].astype(int)
    if not blue.any() or not len(ramp):
        return a
    ramp = ramp[np.argsort(ramp.sum(1))]
    out = a.copy()
    lum = v[blue].sum(1)
    lo, hi = lum.min(), max(lum.max(), lum.min() + 1)
    idx = ((lum - lo) / (hi - lo) * (len(ramp) - 1)).round().astype(int)
    out[blue, :3] = ramp[idx]
    return out


def erase_near_white(a: np.ndarray, min_px: int = 4, x_max: int | None = None) -> np.ndarray:
    """Near-white blobs (>= min_px, left of x_max: away from his eyes and teeth) repainted from around them."""
    v = a[:, :, :3].astype(int)
    white = (a[:, :, 3] > 0) & (v.min(2) > 225)
    if x_max is not None:
        white[:, x_max:] = False
    m = np.zeros_like(white)
    for c in _components(white):
        if c.sum() >= min_px:
            m |= c
    return repaint(a, m) if m.any() else a


def erase_glitch_below(a: np.ndarray, from_row: int) -> np.ndarray:
    """Loose glitch marks under him (rows >= from_row, not touching the body)."""
    g = glitchy(a)
    g[:from_row] = False
    out = a.copy()
    out[g] = 0
    return out


def erase_glitch_far_from_eye(a: np.ndarray, eye: tuple[int, int], r: int = 14) -> np.ndarray:
    out = a.copy()
    for c in _components(glitchy(a)):
        ys, xs = np.where(c)
        if np.hypot(xs.mean() - eye[0], ys.mean() - eye[1]) > r:
            out[c] = 0
    return out


def erase_box(a: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    out = a.copy()
    out[y0:y1, x0:x1] = 0
    return out


def erase_thin_above_head(a: np.ndarray, top_rows: int) -> np.ndarray:
    """Thin dark hair-line strokes in the top `top_rows` rows of the character, 1 px wide."""
    op = a[:, :, 3] > 0
    ys = np.where(op.any(1))[0]
    if not len(ys):
        return a
    t = int(ys.min())
    out = a.copy()
    v = a[:, :, :3].astype(int)
    dark = op & (v.max(2) < 60)
    for y in range(t, t + top_rows):
        for x in np.where(dark[y])[0]:
            # 1 px wide: nothing opaque left and right of it.
            if not op[y, max(0, x - 1)] or x == 0:
                if x + 1 < op.shape[1] and not op[y, x + 1]:
                    out[y, x] = 0
    return out


def apply(sheet: str, frames: list[np.ndarray], lookup) -> list[np.ndarray]:
    own = lookup

    def lookup(name):  # this sheet's own frames first
        rest = name[len(sheet) :]
        return frames[int(rest)] if name.startswith(sheet) and rest.isdigit() and int(rest) < len(frames) else own(name)

    out = []
    for i, f in enumerate(frames):
        f, n = drop_top_bleed(f)
        if n:
            print(f"  fix {sheet}{i}: dropped {n} px of top-edge bleed")
        fix = FIXES.get(f"{sheet}{i}")
        if fix:
            f = fix(f, lookup)
            print(f"  fix {sheet}{i}: {fix.__doc__}")
        out.append(f)
    return out


def _eye(a):
    m = magenta(a).astype(int)
    k = 5
    p = np.pad(m, k)
    c = np.cumsum(np.cumsum(p, 0), 1)
    win = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    y, x = np.unravel_index(int(np.argmax(win)), win.shape)
    return int(x - k / 2), int(y - k / 2)


def _stretch5(f, lookup):
    """blue glitch eye -> magenta (stretch4's ramp)"""
    ref = lookup("stretch4")
    return recolour_blue_eye(f, ref if ref is not None else f)


def _scared1(f, lookup):
    """magenta marks on the floor under him erased"""
    return erase_glitch_below(f, f.shape[0] - 14)


def _grab_tab(f, lookup):
    """white wedge at the neck repainted"""
    return erase_near_white(f, min_px=1, x_max=50)


def _glide4(f, lookup):
    """glitch sparks on the wrong side of his head dropped"""
    out = f.copy()
    ys, xs = np.where(f[:, :, 3] > 0)
    mid = (xs.min() + xs.max()) / 2
    for c in _components(glitchy(f)):
        if np.where(c)[1].mean() < mid - 8:
            out[c] = 0
    return out


def _cling2(f, lookup):
    """hair line above his head erased"""
    return erase_box(f, 49, 0, 55, 27)


FIXES = {
    "stretch5": _stretch5,
    "scared1": _scared1,
    **{f"grab_tab{i}": _grab_tab for i in range(5)},
    "glide4": _glide4,
    "cling_cursor2": _cling2,
}
