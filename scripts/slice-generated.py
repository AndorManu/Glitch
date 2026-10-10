"""Slice the generated animation sheets (art/generated/*.png) into clean,
normalised pixel-art frames.

    python scripts/slice-generated.py            # needs: pip install pillow numpy

Each sheet is one row of N frames of Glitch on a white background. For every
sheet this script:

1. removes the background: flood fill from the borders through near-white
   pixels (cream fur and eye highlights inside the black outline are never
   reached), so there is no white halo;
2. splits the row into frames at the empty columns between characters (not
   equal spacing); loose glitch pixels between frames join the frame they
   belong to;
3. finds the art's pixel grid (block pitch + phase) and samples every frame
   at half a block (the finest detail the art has), median colour per cell,
   binary alpha: crisp pixels, no blur;
4. normalises the scale to the original character (see TARGET), faces every
   side view right (the art convention; the app mirrors it), and puts each
   frame on a fixed canvas: feet on the bottom row, the body (not the tail)
   centred, so cycles don't jitter.

Output: art/frames/<sheet>-<i>.png (one per frame, CANVAS_W x CANVAS_H art px)
and dev/out/slices-<sheet>.png contact sheets for review. The frames are
packed into the app's sprite sheet by scripts/pack-sprites.py.
"""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "art" / "generated"
OUT = ROOT / "art" / "frames"
DEV = ROOT / "dev" / "out"

CANVAS_W, CANVAS_H = 104, 90
#: Height of the standing front pose of the original art in art px (pose 0
#: of the sheet, recovered at half-block resolution by recover-grid.py).
TARGET_STAND_H = 56


def remove_background(rgb: np.ndarray, tol: int = 40) -> np.ndarray:
    """Alpha mask: False where the pixel is background reachable from the border through near-white."""
    h, w = rgb.shape[:2]
    whiteish = (rgb.astype(int).min(2) > 255 - tol) & ((rgb.astype(int).max(2) - rgb.astype(int).min(2)) < 30)
    bg = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if whiteish[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if whiteish[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= yy < h and 0 <= xx < w and not bg[yy, xx] and whiteish[yy, xx]:
                bg[yy, xx] = True
                q.append((yy, xx))
    # The white fill stops at the first non-white pixel, leaving a band of
    # fur/white blend pixels outside the dark outline: a grey halo on dark
    # desktops. Keep eating inward through anything that isn't outline-dark
    # or glitch-coloured, but at most FRINGE_DEPTH px, so a gap in the outline
    # can't leak into the body.
    v = rgb.astype(int)
    lum = v[..., 0] * 0.3 + v[..., 1] * 0.59 + v[..., 2] * 0.11
    glitchy = ((v[..., 0] > 140) & (v[..., 2] > 140) & (v[..., 1] < 120)) | (
        (v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120)
    )
    passable = (lum > OUTLINE_LUM) & ~glitchy
    for _ in range(FRINGE_DEPTH):
        p = np.pad(bg, 1)
        grow = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]) & passable & ~bg
        if not grow.any():
            break
        bg |= grow
    return ~bg


OUTLINE_LUM = 70  # darker than this = the character's outline
FRINGE_DEPTH = 3  # source px (the art pixel is ~5-6 source px, so this is under one art pixel)


def segments(mask: np.ndarray, min_gap: int = 4) -> list[tuple[int, int]]:
    cols = mask.sum(0) > 0
    segs, start, gap = [], None, 0
    for x, on in enumerate(cols):
        if on:
            if start is None:
                start = x
            gap = 0
            end = x
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                segs.append((start, end + 1))
                start = None
    if start is not None:
        segs.append((start, end + 1))
    return segs


def merge_small(segs, frac=0.3):
    """Loose glitch pixels form narrow segments: join them to the frame on their left."""
    widths = [b - a for a, b in segs]
    med = float(np.median(widths))
    out = []
    for a, b in segs:
        if b - a < med * frac and out:
            out[-1] = (out[-1][0], b)
        elif b - a < med * frac:
            continue
        else:
            out.append((a, b))
    return out


def _palette() -> np.ndarray:
    """The original character's palette (art/puppet/src/palette.txt, recovered
    from the original 16 poses by recover-grid.py)."""
    rows = []
    for line in (ROOT / "art" / "puppet" / "src" / "palette.txt").read_text().splitlines():
        hexv = line.split()[1].lstrip("#")
        rows.append([int(hexv[i : i + 2], 16) for i in (0, 2, 4)])
    return np.array(rows, float)


PALETTE = _palette()
#: Colours closer than this to an original palette colour snap to it; others
#: (props: the fishing rod, the laptop, the fish) keep their own colour.
SNAP_DIST = 42


def snap_palette(a: np.ndarray) -> np.ndarray:
    """Nearest-colour pass to the original palette: the generated sheets drift
    a little in hue and carry soft in-between colours (thousands per frame
    where the original has ~26); snapping makes every sheet use the same fur,
    cream, outline and glitch colours."""
    out = a.copy()
    op = a[:, :, 3] > 0
    px = a[op][:, :3].astype(float)
    d = ((px[:, None, :] - PALETTE[None]) ** 2).sum(2)
    j = d.argmin(1)
    near = np.sqrt(d[np.arange(len(j)), j]) < SNAP_DIST
    snapped = px.copy()
    snapped[near] = PALETTE[j[near]]
    out[op, :3] = snapped.astype(np.uint8)
    return out


def trim_thin_bottom(a: np.ndarray, keep: int) -> np.ndarray:
    """A thin line (fishing line) hanging below him: from the bottom up, rows
    with at most 2 opaque pixels are the line; keep only its top `keep` rows."""
    op = a[:, :, 3] > 0
    rows = np.where(op.any(1))[0]
    if not len(rows):
        return a
    y = rows.max()
    while y >= 0 and op[y].sum() <= 2:
        y -= 1
    out = a.copy()
    out[y + 1 + keep :] = 0
    return out


def head_x(a: np.ndarray) -> float:
    """x centre of the head: the top third of the character, glitch pixels ignored."""
    v = a[:, :, :3].astype(int)
    glitchy = ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))
    m = (a[:, :, 3] > 0) & ~glitchy
    ys = np.where(m.any(1))[0]
    if not len(ys):
        return a.shape[1] / 2
    top, bottom = ys.min(), ys.max()
    band = m[top : top + max(1, (bottom - top) // 3)]
    return float(np.where(band)[1].mean())


def body_height(c: np.ndarray) -> int:
    """Height of the character in a source crop, ignoring the loose glitch
    pixels (magenta/purple/cyan) that float around him."""
    v = c[:, :, :3].astype(int)
    glitchy = ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))
    rows = np.where(((c[:, :, 3] > 0) & ~glitchy).sum(1) >= 3)[0]
    return int(rows.max() - rows.min() + 1) if len(rows) else c.shape[0]


def split_touching(segs, mask, n):
    """Frames whose tails touch the next one come out as one wide segment:
    cut it at the thinnest columns (the gap between the bodies)."""
    col = mask.sum(0)
    while True:
        widths = [b - a for a, b in segs]
        i = int(np.argmax(widths))
        a, b = segs[i]
        typical = float(np.median(widths)) if len(segs) > 2 else (b - a) / 2
        # n given: split until there are n frames. Otherwise only clearly double-wide segments.
        if (n and len(segs) >= n) or (not n and (b - a) < 1.6 * typical):
            break
        k = max(2, round((b - a) / typical))
        cuts = []
        for j in range(1, k):
            mid = a + (b - a) * j // k
            lo, hi = mid - (b - a) // (3 * k), mid + (b - a) // (3 * k)
            cuts.append(lo + int(np.argmin(col[lo:hi])))
        bounds = [a, *cuts, b]
        segs = segs[:i] + [(bounds[j], bounds[j + 1]) for j in range(len(bounds) - 1)] + segs[i + 1 :]
    return segs


def edge_profile(a, axis):
    d = np.abs(np.diff(a.astype(float), axis=axis)).sum(2)
    return d.sum(axis=1 - axis) if axis == 1 else d.sum(axis=1)


def best_pitch(rgba: np.ndarray, lo: float, hi: float):
    """Block pitch and x/y phase that line block edges up best."""
    px_prof, py_prof = edge_profile(rgba, 1), edge_profile(rgba, 0)

    def phase_score(prof, n, pitch):
        best = (-1, 0)
        for ph in np.arange(0, pitch, 0.25):
            idx = np.round(np.arange(ph, n - 1, pitch)).astype(int)
            idx = idx[idx < len(prof)]
            s = prof[idx].mean() / (prof.mean() + 1e-9)
            if s > best[0]:
                best = (s, ph)
        return best

    best = None
    for pitch in np.arange(lo, hi + 1e-6, 0.05):
        sx, ox = phase_score(px_prof, rgba.shape[1], pitch)
        sy, oy = phase_score(py_prof, rgba.shape[0], pitch)
        if best is None or sx + sy > best[0]:
            best = (sx + sy, pitch, ox, oy)
    return best[1:]


def sample(rgba: np.ndarray, cell: float, ox: float, oy: float) -> np.ndarray:
    h, w = rgba.shape[:2]
    cols = int((w - ox) // cell)
    rows = int((h - oy) // cell)
    out = np.zeros((rows, cols, 4), np.uint8)
    for r in range(rows):
        y0 = oy + r * cell
        ya = int(round(y0 + cell * 0.25))
        ys = slice(ya, max(ya + 1, int(round(y0 + cell * 0.75))))
        for c in range(cols):
            x0 = ox + c * cell
            xa = int(round(x0 + cell * 0.25))
            xs = slice(xa, max(xa + 1, int(round(x0 + cell * 0.75))))
            block = rgba[ys, xs].reshape(-1, 4)
            if (block[:, 3] > 0).mean() < 0.5:
                continue
            solid = block[block[:, 3] > 0]
            out[r, c, :3] = np.median(solid[:, :3], axis=0)
            out[r, c, 3] = 255
    return out


def dehalo(a: np.ndarray, passes: int = 2) -> np.ndarray:
    """Drop light, unsaturated pixels on the silhouette edge (left over from
    the white background's anti-aliasing); the black outline stays."""
    a = a.copy()
    for _ in range(passes):
        op = a[:, :, 3] > 0
        inner = np.zeros_like(op)
        inner[1:-1, 1:-1] = op[:-2, 1:-1] & op[2:, 1:-1] & op[1:-1, :-2] & op[1:-1, 2:]
        edge = op & ~inner
        rgb = a[:, :, :3].astype(int)
        light = (rgb.mean(2) > 150) & ((rgb.max(2) - rgb.min(2)) < 70)
        kill = edge & light
        if not kill.any():
            break
        a[kill] = 0
    return a


def drop_strays(a: np.ndarray, max_px: int = 24) -> np.ndarray:
    """Remove small loose pixel clusters on the tail side (the neighbouring
    frame's glitch pixels that ended up in this frame's slice)."""
    op = a[:, :, 3] > 0
    h, w = op.shape
    seen = np.zeros_like(op)
    out = a.copy()
    for y0, x0 in zip(*np.where(op)):
        if seen[y0, x0]:
            continue
        comp, q = [], [(y0, x0)]
        seen[y0, x0] = True
        while q:
            y, x = q.pop()
            comp.append((y, x))
            for yy in range(y - 1, y + 2):
                for xx in range(x - 1, x + 2):
                    if 0 <= yy < h and 0 <= xx < w and op[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        q.append((yy, xx))
        if len(comp) <= max_px and np.mean([x for _, x in comp]) < w * 0.3:
            for y, x in comp:
                out[y, x] = 0
    return out


def trim(a: np.ndarray) -> np.ndarray:
    op = a[:, :, 3] > 0
    if not op.any():
        return a
    ys, xs = np.where(op)
    return a[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def glitch_eye_x(a: np.ndarray) -> float | None:
    """x of the magenta pixels (glitch eye + bits), or None."""
    r, g, b = (a[:, :, i].astype(int) for i in range(3))
    m = (a[:, :, 3] > 0) & (r > 150) & (b > 180) & (g < 110)
    if m.sum() < 3:
        return None
    return float(np.where(m)[1].mean())


def body_x(a: np.ndarray, tail_side: str) -> float:
    """Centre of the torso: opaque pixels in the 45-85 % height band, ignoring
    the tail third of the bounding box."""
    h, w = a.shape[:2]
    band = a[int(h * 0.45) : int(h * 0.85), :, 3] > 0
    x0 = int(w * 0.35) if tail_side == "left" else 0
    x1 = w if tail_side == "left" else int(w * 0.65)
    xs = np.where(band[:, x0:x1])[1] + x0
    return float(xs.mean()) if len(xs) else w / 2


def _components(m: np.ndarray) -> list[np.ndarray]:
    """8-connected components of a mask, largest first."""
    h, w = m.shape
    seen = np.zeros_like(m)
    comps = []
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
        comps.append(c)
    return sorted(comps, key=lambda c: -c.sum())


def _dilate(m: np.ndarray, r: int) -> np.ndarray:
    out = m.copy()
    for _ in range(r):
        p = np.pad(out, 1)
        out = out | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | p[:-2, :-2] | p[:-2, 2:] | p[2:, :-2] | p[2:, 2:]
    return out


def _erode(m: np.ndarray, r: int) -> np.ndarray:
    return ~_dilate(~m, r)


OUTLINE_RGB = np.array([12, 10, 24], np.uint8)


def clean_cursor(frames: list[np.ndarray], mode: str = "grip") -> tuple[list[np.ndarray], list[list[int]]]:
    """cling_cursor is drawn holding a big white cursor arrow (tip up, shaft
    down to his paws). The app shows the real cursor instead, so the drawn
    arrow goes: its white body is the largest near-white component; it and
    its dark outline (2 px around it) are cleared where they stick out of
    him, and repainted from the neighbouring fur where they cross his head
    and body, with the outline closed again. The grip (where the shaft met his
    paws: the arrow's lowest pixel) is returned per frame, and the frames are
    shifted so the grip is at the same x in all of them (he hangs steadily
    from the cursor)."""
    out, grips = [], []
    for f in frames:
        a = f.copy()
        op = a[:, :, 3] > 0
        v = a[:, :, :3].astype(int)
        white = op & (v.min(2) > 200) & ((v.max(2) - v.min(2)) < 35)
        comps = _components(white)
        if not comps:
            out.append(a)
            grips.append([a.shape[1] // 2, 30])
            continue
        arrow = comps[0].copy()
        # The arrow can come out in pieces where his paws cover it (not the eye highlights: those are tiny).
        for c in comps[1:]:
            if c.sum() >= 8 and (_dilate(c, 6) & comps[0]).any():
                arrow |= c
        ys, xs = np.where(arrow)
        if mode == "bite":
            # The arrow points up-left into his mouth: its tip is the anchor.
            k = int(np.argmin(xs + ys))
            gx, gy = int(xs[k]), int(ys[k])
        else:
            gy = int(ys.max())
            gx = int(round(xs[ys == gy].mean()))
        R = _dilate(arrow, 2) & op
        body = _components(op & ~R)
        B = body[0] if body else np.zeros_like(op)
        h, w = op.shape
        inside = np.zeros_like(op)
        for y, x in zip(*np.where(R)):
            left = B[y, max(0, x - 4) : x].any()
            right = B[y, x + 1 : min(w, x + 5)].any()
            below = B[y + 1 : min(h, y + 4), x].any()
            inside[y, x] = left and right and below
        if mode == "bite":
            # The arrow lies across his chest and paws: whatever the body closes round
            # (a closing of his silhouette, ~16 px gaps) is him, not background.
            inside |= R & _erode(_dilate(B, 8), 8)
        a[R & ~inside] = 0
        # Repaint the inside from neighbouring non-arrow pixels, fur first.
        todo = inside.copy()
        known = (a[:, :, 3] > 0) & ~inside
        for _ in range(24):
            if not todo.any():
                break
            nxt = a.copy()
            done = []
            dark = (a[:, :, :3].astype(int).sum(2) < 110)
            for y, x in zip(*np.where(todo)):
                cand, dk = [], []
                for oy, ox in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
                    yy, xx = y + oy, x + ox
                    if 0 <= yy < h and 0 <= xx < w and known[yy, xx]:
                        (dk if dark[yy, xx] else cand).append(tuple(a[yy, xx]))
                pick = cand or dk
                if pick:
                    nxt[y, x] = max(set(pick), key=pick.count)
                    done.append((y, x))
            a = nxt
            for y, x in done:
                todo[y, x] = False
                known[y, x] = True
        a[todo] = 0
        # Close the outline where the repainted area meets the outside.
        op2 = a[:, :, 3] > 0
        p = np.pad(~op2, 1)
        edge = op2 & (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]) & _dilate(inside, 1)
        a[edge, :3] = OUTLINE_RGB
        # Bits of the arrow's outline left floating above him.
        for c in _components(a[:, :, 3] > 0)[1:]:
            if c.sum() <= 8 and not (_dilate(c, 1) & B).any():
                a[c] = 0
        out.append(a)
        grips.append([gx, gy])
    if mode == "bite":
        # Biting: frames stay as drawn (he lunges); the mouth point per frame is the anchor.
        _review(frames, out, grips, "bite-clean.png")
        return out, grips
    # Same grip point in every frame: he hangs steadily from the cursor tip.
    tx = int(round(np.median([g[0] for g in grips])))
    ty = min(g[1] for g in grips)  # shift up only: nothing is cut off at the bottom
    steady = []
    for a, g in zip(out, grips):
        b = np.roll(np.roll(a, tx - g[0], axis=1), ty - g[1], axis=0)
        # np.roll wraps: clear what came round the edges.
        dx, dy = tx - g[0], ty - g[1]
        if dx > 0:
            b[:, :dx] = 0
        elif dx < 0:
            b[:, dx:] = 0
        if dy > 0:
            b[:dy] = 0
        elif dy < 0:
            b[dy:] = 0
        steady.append(b)
        g[0], g[1] = tx, ty
    _review(frames, steady, grips, "cling-clean.png")
    return steady, grips


def tail_sets(frames: list[np.ndarray], sets: dict, report: dict) -> None:
    """The moving tail of a loop on other drawn bodies (art/frames files): one
    derived sheet per body, so blinks, breaths and ear flicks keep the tail
    going. `sets` = {sheet name: {"body": frame file stem, "rects": ..., "drop": ...}}."""
    for name, c in sets.items():
        body = np.array(Image.open(OUT / f"{c['body']}.png").convert("RGBA"))
        out = tail_composite([body, *frames], {**c, "base": 0, "drop": [0, *[d + 1 for d in c.get("drop", ())]]})
        for i, f in enumerate(out):
            Image.fromarray(f, "RGBA").save(OUT / f"{name}-{i}.png")
        contact(out, DEV / f"slices-{name}.png")
        report[name] = {"frames": len(out), "body": c["body"]}
        print(name, json.dumps(report[name]))


def tail_composite(frames: list[np.ndarray], cfg: dict) -> list[np.ndarray]:
    """A stable body with only the tail moving.

    The generated idle loops redraw the whole character every frame, so the
    body jitters. Keep the body of frame `base` and take only the tail region
    (`rects`, canvas art px [x0, y0, x1, y1]) from each frame, aligned to the
    base body by the best whole-pixel shift. The tail goes behind the body:
    pasted only where the base body is not. Frames in `drop` are left out.
    """
    if cfg.get("body"):
        # The body from another drawn frame (art/frames/<body>.png), the tail from every frame here.
        body_img = np.array(Image.open(OUT / f"{cfg['body']}.png").convert("RGBA"))
        return tail_composite([body_img, *frames], {"rects": cfg["rects"], "base": 0, "drop": [0, *[d + 1 for d in cfg.get("drop", ())]]})
    base = frames[cfg.get("base", 0)]
    H, W = base.shape[:2]
    R = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in cfg["rects"]:
        R[y0:y1, x0:x1] = True
    body = (base[:, :, 3] > 0) & ~R
    out = []
    for i, f in enumerate(frames):
        if i in cfg.get("drop", ()):
            continue
        best, bs = (0, 0), -1.0
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                g = np.roll(np.roll(f, dy, 0), dx, 1)
                m = (g[:, :, 3] > 0) & ~R
                iou = (m & body).sum() / max(1, (m | body).sum())
                if iou > bs:
                    best, bs = (dx, dy), iou
        g = np.roll(np.roll(f, best[1], 0), best[0], 1)
        t = (g[:, :, 3] > 0) & R
        # Only the tail itself (and glitch bits): big pieces, not slivers of its body.
        keep = np.zeros_like(t)
        for comp in _components(t):
            if comp.sum() >= 24:
                keep |= comp
        o = base.copy()
        o[R & ~body] = 0
        paste = keep & ~body
        o[paste] = g[paste]
        out.append(o)
    return out


def _review(before, after, points, file):
    """Before / after strip with the anchor point marked (red square)."""
    z = 3
    H, W = before[0].shape[:2]
    sheet = Image.new("RGBA", (W * z * len(before), H * z * 2), (46, 107, 88, 255))
    d = ImageDraw.Draw(sheet)
    for i, (bf, af, (px_, py_)) in enumerate(zip(before, after, points)):
        for row, im in enumerate((bf, af)):
            sheet.alpha_composite(Image.fromarray(im, "RGBA").resize((W * z, H * z), Image.NEAREST), (i * W * z, row * H * z))
        d.rectangle([i * W * z + px_ * z - 1, H * z + py_ * z - 1, i * W * z + px_ * z + z, H * z + py_ * z + z], outline=(255, 40, 40, 255))
    DEV.mkdir(parents=True, exist_ok=True)
    sheet.save(DEV / file)


#: Rod tip and a point on the rod near his paw (art px in the final canvas, read off
#: the contact sheets). The generated art draws a thin fishing line from the tip; the
#: app draws the real one (tip -> cursor), so everything outside the body and the
#: corridor along the rod is cut. The tip is the line's anchor (ANIM_RODS).
RODS = {
    "hook_cast": [((87, 35), (73, 55)), ((91, 19), (74, 52)), ((50, 12), (50, 45)), ((2, 20), (24, 44)),
                  ((84, 53), (70, 66)), ((97, 50), (72, 67)), ((82, 56), (66, 70)), ((101, 47), (70, 70))],
    "hook_reel": [((82, 36), (70, 60)), ((92, 26), (72, 58)), ((90, 26), (70, 60)), ((91, 28), (70, 62)),
                  ((77, 34), (62, 62)), ((80, 35), (64, 64)), ((93, 25), (72, 60)), ((93, 28), (70, 62))],
}


def corridor_clean(f: np.ndarray, tip, base, width: float = 3.0) -> np.ndarray:
    op = f[:, :, 3] > 0
    v = f[:, :, :3].astype(int)
    glitchy = is_glitchy(v)
    lum = v[..., 0] * 0.3 + v[..., 1] * 0.59 + v[..., 2] * 0.11
    fur = op & ~glitchy & (lum > 95)
    ys, xs = np.where(fur)
    yy, xx = np.indices(op.shape)
    x0, x1 = np.percentile(xs, [1, 99]); y0, y1 = np.percentile(ys, [1, 99])
    near_body = (xx >= x0 - 3) & (xx <= x1 + 3) & (yy >= y0 - 3) & (yy <= y1 + 3)
    (tx, ty), (bx, by) = tip, base
    dx, dy = tx - bx, ty - by
    n2 = max(1, dx * dx + dy * dy)
    t = np.clip(((xx - bx) * dx + (yy - by) * dy) / n2, 0, 1)
    dist = np.hypot(xx - (bx + t * dx), yy - (by + t * dy))
    keep = near_body | (dist <= width) | glitchy
    out = f.copy()
    out[op & ~keep] = 0
    # Drawn line crossing the body's box: dark pixels that are not next to any fur / the rod.
    op = out[:, :, 3] > 0
    protect = _dilate(fur | (dist <= width + 1), 2)
    out[op & (lum < 70) & ~protect & ~glitchy] = 0
    return out


MARK = (1, 2, 3)


def is_glitchy(v: np.ndarray) -> np.ndarray:
    return ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))


def rod_clean(a: np.ndarray) -> np.ndarray:
    """The fishing rod frames (hook_cast / hook_reel): the generated art draws
    a thin line from the rod tip. The app draws the real line (tip -> cursor),
    so cut the drawn one and leave a one-pixel MARK at the rod tip (the rod
    pixel farthest from the body); process() turns it into an anchor.
    Rod pixels = the ones that kept their own colour in snap_palette."""
    op = a[:, :, 3] > 0
    rgb = a[:, :, :3].astype(float)
    d = ((rgb[:, :, None, :] - PALETTE[None, None]) ** 2).sum(3).min(2)
    glitchy = is_glitchy(a[:, :, :3].astype(int))
    r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    brown = (r_ >= 80) & (r_ <= 165) & (g_ >= 38) & (g_ <= 92) & (b_ >= 18) & (b_ <= 62) & (r_ > g_ + 25) & (g_ > b_ + 8)
    rod = op & (d > 1) & ~glitchy & brown
    comps = _components(rod)
    if comps:
        keep = comps[0]
        stray = rod & ~keep
        a = a.copy()
        a[stray] = 0
        op = op & ~stray
        rod = keep
    # Fur = the tan/grey body colours: palette pixels that aren't the dark outline.
    lum = rgb[..., 0] * 0.3 + rgb[..., 1] * 0.59 + rgb[..., 2] * 0.11
    fur = op & ~rod & (lum > 95) & ~glitchy
    if not fur.any() or not rod.any():
        return a
    ys, xs = np.where(fur)
    cy, cx = ys.mean(), xs.mean()
    box = (xs.min(), xs.max(), ys.min(), ys.max())
    ry, rx = np.where(rod)
    k = int(np.argmax((rx - cx) ** 2 + (ry - cy) ** 2))
    ty, tx = int(ry[k]), int(rx[k])
    out = a.copy()
    # Thin leftovers outside the fur's bounding box: the drawn line.
    pad = np.pad(op, 1)
    nb = sum(np.roll(np.roll(pad, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx)[1:-1, 1:-1]
    yy, xx = np.indices(op.shape)
    outside = (xx < box[0] - 2) | (xx > box[1] + 2) | (yy < box[2] - 2) | (yy > box[3] + 2)
    thin = op & ~rod & ~glitchy & (nb <= 3)
    line = np.zeros_like(op)
    seen = np.zeros_like(op)
    h, w = op.shape
    for y0, x0 in zip(*np.where(thin)):
        if seen[y0, x0]:
            continue
        comp, q = [], [(y0, x0)]
        seen[y0, x0] = True
        while q:
            y, x = q.pop()
            comp.append((y, x))
            for yy in range(y - 1, y + 2):
                for xx in range(x - 1, x + 2):
                    if 0 <= yy < h and 0 <= xx < w and thin[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        q.append((yy, xx))
        if len(comp) <= 14 or any(outside[y, x] for y, x in comp):
            for y, x in comp:
                line[y, x] = True
    out[line] = 0
    out[op & ~rod & ~glitchy & outside] = 0
    out[ty, tx, :3] = MARK
    return out


def take_marks(placed: list[np.ndarray]) -> list[list[int]]:
    """Find each frame's MARK pixel (the rod tip), give it the colour of a rod
    pixel next to it, and return the tips (art px in the canvas)."""
    tips = []
    for f in placed:
        m = (f[:, :, 0] == MARK[0]) & (f[:, :, 1] == MARK[1]) & (f[:, :, 2] == MARK[2]) & (f[:, :, 3] > 0)
        if not m.any():
            tips.append(tips[-1] if tips else [60, 20])
            continue
        y, x = [int(v[0]) for v in np.where(m)]
        col = None
        for dy, dx in ((1, -1), (1, 0), (0, -1), (1, 1), (-1, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < f.shape[0] and 0 <= xx < f.shape[1] and f[yy, xx, 3] > 0 and tuple(f[yy, xx, :3]) != MARK:
                col = f[yy, xx, :3].copy()
                break
        f[y, x, :3] = col if col is not None else (110, 70, 50)
        tips.append([x, y])
    return tips


def place(a: np.ndarray, anchor_x: float) -> np.ndarray:
    out = np.zeros((CANVAS_H, CANVAS_W, 4), np.uint8)
    h, w = a.shape[:2]
    ox = int(round(CANVAS_W / 2 - anchor_x))
    oy = CANVAS_H - h
    ys0, xs0 = max(0, -oy), max(0, -ox)
    ys1, xs1 = min(h, CANVAS_H - oy), min(w, CANVAS_W - ox)
    src = a[ys0:ys1, xs0:xs1]
    m = src[:, :, 3] > 0
    out[ys0 + oy : ys1 + oy, xs0 + ox : xs1 + ox][m] = src[m]
    return out


def contact(frames, path, z=4):
    w, h = CANVAS_W * z, CANVAS_H * z
    sheet = Image.new("RGBA", ((w + 4) * len(frames), h + 4), (46, 107, 88, 255))
    for i, f in enumerate(frames):
        cell = Image.new("RGBA", (w, h), (40, 96, 79, 255))
        cell.alpha_composite(Image.fromarray(f, "RGBA").resize((w, h), Image.NEAREST))
        sheet.alpha_composite(cell, (i * (w + 4) + 2, 2))
    sheet.save(path)


def process(name: str, cfg: dict, report: dict) -> list[np.ndarray]:
    rgb = np.array(Image.open(GEN / f"{name}.png").convert("RGB"))
    mask = remove_background(rgb)
    rgba = np.dstack([rgb, np.where(mask, 255, 0).astype(np.uint8)])
    rgba[~mask] = 0
    segs = split_touching(merge_small(segments(mask)), mask, cfg.get("n", 8))
    crops = []
    for a, b in segs:
        part = rgba[:, a:b]
        ys = np.where(part[:, :, 3].any(1))[0]
        crops.append(part[ys.min() : ys.max() + 1])
    # The art's grid: block pitch from the whole sheet, then half a block per art px.
    pitch, _, _ = best_pitch(np.concatenate([np.pad(c[:400], ((0, 400 - min(400, c.shape[0])), (0, 0), (0, 0))) for c in crops], 1), 5.0, 11.0)
    cell = pitch / 2
    # Normalise to the original character's size: the reference frame's height in art px.
    ref = crops[cfg.get("ref", 0)]
    ref_h = body_height(ref)
    natural_h = ref_h / cell
    target_h = cfg.get("target", TARGET_STAND_H)
    scale_cell = ref_h / target_h
    use = cfg["cell"] if "cell" in cfg else cell if abs(natural_h / target_h - 1) < cfg.get("tolerance", 0.04) else scale_cell
    frames = []
    votes = 0
    for i, c in enumerate(crops):
        _, ox, oy = best_pitch(c, use * 2 - 0.01, use * 2 + 0.01)
        art = snap_palette(trim(drop_strays(trim(dehalo(sample(c, use, ox % use, oy % use))))))
        if "trim_line" in cfg:
            art = trim(trim_thin_bottom(art, cfg["trim_line"]))
        ex = glitch_eye_x(art)
        if ex is not None:
            votes += 1 if ex > art.shape[1] / 2 else -1
        frames.append(art)
    # The glitch eye is on his right eye: in our convention it shows on the
    # right of the picture. Mirror the whole sheet if most frames have it left.
    if cfg.get("rotate"):
        # Drawn climbing a wall on his right: turn the wall into the floor (the
        # app turns him onto the wall itself), climbing up becomes walking right.
        frames = [np.rot90(f, cfg["rotate"]).copy() for f in frames]
    elif votes < 0 and not cfg.get("keep_facing"):
        frames = [f[:, ::-1].copy() for f in frames]
    # Body centred; `shift` moves a whole sheet (e.g. the long run tail must fit the canvas).
    # The tail is on the side away from the glitch eye (front: tail left, eye right;
    # side view facing right: tail left; turned to face left: tail right).
    def tail_side(f):
        ex = glitch_eye_x(f)
        return "right" if ex is not None and ex < f.shape[1] * 0.42 else "left"

    anchors = [body_x(f, tail_side(f)) - cfg.get("shift", 0) for f in frames]
    if cfg.get("anchor") == "head":
        # Turning round: the tail swings from one side to the other, so anchor on the head
        # (its centre is the turn's pivot), keeping the first frame where body_x put it.
        heads = [head_x(f) for f in frames]
        anchors = [anchors[0] + (hx - heads[0]) for hx in heads]
    # Single frames nudged sideways (px, + = right) where the drawing runs off the canvas.
    for i, dx in cfg.get("frame_shift", {}).items():
        anchors[i] -= dx
    placed = [place(f, ax) for f, ax in zip(frames, anchors)]
    if cfg.get("rod"):
        tips = [t for t, _ in RODS[name]]
        placed = [corridor_clean(f, t, b) for f, (t, b) in zip(placed, RODS[name])]
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{name}-rods.json").write_text(json.dumps(tips))
    if cfg.get("cursor_clean"):
        placed, grips = clean_cursor(placed, cfg["cursor_clean"] if isinstance(cfg["cursor_clean"], str) else "grip")
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{name}-grips.json").write_text(json.dumps(grips))
    clipped = [i for i, (f, p) in enumerate(zip(frames, placed)) if (p[:, :, 3] > 0).sum() < (f[:, :, 3] > 0).sum()]
    if clipped:
        print(f"  WARNING {name}: frames {clipped} clipped by the canvas")
    if cfg.get("tail_sets"):
        tail_sets(placed, cfg["tail_sets"], report)
    if cfg.get("tail_composite"):
        placed = tail_composite(placed, cfg["tail_composite"])
    report[name] = {
        "frames": len(placed),
        "block_px": round(pitch, 2),
        "natural_h": round(natural_h, 1),
        "cell_used": round(use, 3),
        "sizes": [list(f.shape[:2][::-1]) for f in frames],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(placed):
        Image.fromarray(f, "RGBA").save(OUT / f"{name}-{i}.png")
    DEV.mkdir(parents=True, exist_ok=True)
    contact(placed, DEV / f"slices-{name}.png")
    return placed


#: Per sheet: is it a side view (face right), which frame is the size
#: reference and how tall it should be (art px).
SHEETS = {
    "idle": {"ref": 0},
    "talk": {"ref": 0},
    "wave": {"ref": 0},
    "walk": {"side": True, "ref": 0, "target": 55},
    "run": {"side": True, "ref": 0, "target": 44, "n": 6, "shift": 7},
    "jump": {"side": True, "ref": 0, "target": 55},
}
#: Sheets without a plain standing reference frame: sampled at the typical
#: cell size of the standing sheets above (~3.8 source px per art px).
for _name in ["think", "sleep", "wake", "dangle", "climb", "laugh", "sad", "angry", "surprised", "scared",
              "peek", "push", "spin", "teleport", "listen", "celebrate", "dance", "eat", "grab_tab",
              "dizzy", "sneeze", "typing", "point", "land", "sit"]:
    SHEETS[_name] = {"cell": 3.8}
# Transitions and idle fidgets (round 3).
for _name in ["sit_down", "stand_up_paws", "stand_up_hop", "stand_up_glitch", "turn_front_to_side", "turn_side_to_front",
              "turn_around", "turn_to_back", "walk_start", "walk_stop", "lie_down", "get_up", "shake_off", "scratch", "groom",
              "stretch", "tail_chase", "look_back", "hop_idle", "sit_idle_look"]:
    # Any number of frames; scaled so the standing end of the clip is exactly as
    # tall as idle0 (55 art px), so the transition meets the loops it joins.
    SHEETS[_name] = {"n": None, "ref": 0, "target": 55, "tolerance": 0, "keep_facing": _name.startswith("turn")}
for _name in ["stand_up_paws", "stand_up_hop", "stand_up_glitch", "turn_side_to_front", "walk_stop", "get_up"]:
    SHEETS[_name]["ref"] = -1  # these end standing
SHEETS["turn_around"]["target"] = 54  # side-on, like walk0
for _name in ["turn_around", "turn_front_to_side", "turn_side_to_front", "turn_to_back"]:
    SHEETS[_name]["anchor"] = "head"
# Sitting: as tall as the sitting end of sit_down / the start of stand_up_* (~47 px
# when standing is 55), so sitting down lands exactly on the sit loop.
SHEETS["sit"] = {"ref": 0, "target": 47, "tolerance": 0}
# Air and ledge behaviours (round 3): no standing frame to measure, sampled
# at the typical cell size of the standing sheets; checked in the lineup.
for _name in ["tail_copter", "glide", "fall_flail", "hang_ledge", "slide_down", "sit_edge_swing", "fish", "pull_up", "bounce", "wall_jump"]:
    SHEETS[_name] = {"cell": 3.8, "n": None}
# Annoyance reactions (round 3).
for _name in ["struggle", "cling_cursor", "annoyed", "bite_cursor"]:
    SHEETS[_name] = {"cell": 3.8, "n": None}
# These are drawn bigger: cell set so the head is as big as in idle0 (measured in the lineup).
for _name, _cell in {"struggle": 4.7, "bite_cursor": 4.6, "cling_cursor": 5.2, "annoyed": 3.8, "fall_flail": 5.7, "hang_ledge": 5.3, "glide": 4.9, "slide_down": 4.9, "sit_edge_swing": 4.75, "wall_jump": 4.9, "pull_up": 4.2}.items():
    SHEETS[_name]["cell"] = _cell
# wall_jump4's long tail ran off the right edge (visual QA S1-6).
SHEETS["wall_jump"]["frame_shift"] = {4: -4}
# The stretch is 8 side-on frames, three pairs touching (auto-splitting can't tell).
SHEETS["stretch"].update({"n": 8, "target": 54})
SHEETS["sit_idle_look"]["target"] = 47
# The wall crawl, rotated onto the floor; a bit smaller so the long body + tail fits the canvas.
SHEETS["climb"] = {"cell": 4.9, "rotate": -1, "shift": 6}

# The drawn cursor arrow comes out of cling_cursor (the real cursor is there); grip points saved.
SHEETS["cling_cursor"]["cursor_clean"] = True
# And out of bite_cursor (he bites the real cursor): the mouth point per frame saved.
SHEETS["bite_cursor"]["cursor_clean"] = "bite"
# Arms crossed, standing: as tall as idle0.
SHEETS["annoyed"] = {"n": None, "ref": 0, "target": 55, "tolerance": 0}
# Chaos mode 2 (the hook act, the fake-virus giggle, the swarm).
for _name in ["virus_giggle", "clone_pop"]:
    SHEETS[_name] = {"n": 8, "ref": 0, "target": 55, "tolerance": 0}
# The hook sheets are drawn smaller on the page: sampled finer so the head is as big as idle0's.
for _name in ["hook_cast", "hook_reel"]:
    SHEETS[_name] = {"n": 8, "cell": 2.7, "rod": True}
# The fishing line hangs far below him: cut it at his feet (it goes on over the edge).
SHEETS["fish"]["trim_line"] = 0  # down to his feet: frames stay on one baseline

# The living idle (round 4): 12-frame base loops, the tail always moving.
SHEETS["idle_tail"] = {"n": 12, "ref": 0, "target": 55, "tolerance": 0}
SHEETS["idle_tail_sit"] = {"n": 12, "ref": 0, "target": 47, "tolerance": 0}
# Their bodies are redrawn (jitter) every frame: a stable body, only the tail moving.
SHEETS["idle_tail"]["tail_composite"] = {"base": 0, "rects": [[0, 0, 29, 90], [29, 70, 35, 90]]}
SHEETS["idle_tail_sit"]["tail_composite"] = {"base": 0, "rects": [[0, 0, 30, 90], [30, 72, 33, 90]], "drop": [8, 9]}
# And the tail on the original idle / sit drawings (the bodies the blinks, breaths and
# ear flicks are drawn on), so the base loop is his own body with a tail that never
# stops: idle_tail (idle0), idle_tail_in (idle1, breathing in), idle_tail_ear (idle2),
# idle_tail_blink_a/b/c (idle4-6); idle_tail_sit (sit0), idle_tail_sit_blink (sit1).
_IDLE_R = [[0, 0, 28, 90], [28, 70, 34, 90]]
_SIT_R = [[0, 64, 26, 90], [26, 69, 30, 90], [30, 74, 33, 90]]
SHEETS["idle_tail"]["tail_sets"] = {
    "idle_tail_in": {"body": "idle-1", "rects": _IDLE_R},
    "idle_tail_ear": {"body": "idle-2", "rects": _IDLE_R},
    "idle_tail_blink_a": {"body": "idle-4", "rects": _IDLE_R},
    "idle_tail_blink_b": {"body": "idle-5", "rects": _IDLE_R},
    "idle_tail_blink_c": {"body": "idle-6", "rects": _IDLE_R},
}
SHEETS["idle_tail"]["tail_composite"] = {"body": "idle-0", "rects": _IDLE_R}
SHEETS["idle_tail_sit"]["tail_sets"] = {"idle_tail_sit_blink": {"body": "sit-1", "rects": _SIT_R, "drop": [8, 9]}}
SHEETS["idle_tail_sit"]["tail_composite"] = {"body": "sit-0", "rects": _SIT_R, "drop": [8, 9]}
#: Derived sheets (written by tail_sets above): packed, never sliced from a source.
DERIVED = ["idle_tail_in", "idle_tail_ear", "idle_tail_blink_a", "idle_tail_blink_b", "idle_tail_blink_c", "idle_tail_sit_blink"]
for _name in DERIVED:
    SHEETS[_name] = {"derived": True}
# Fun fidgets for the feature agents (round 4), wired under their file names.
for _name in ["dance_beat", "celebrate_focus", "hold_sign", "sweat_fan", "worried_battery", "glasses_type",
              "knock_screen", "hide_peek", "watch_tv", "fetch_ball"]:
    SHEETS[_name] = {"cell": 3.8, "n": None}
SHEETS["fetch_ball"]["side"] = True
# Standing front views: frame 0 as tall as idle0; sitting ones as tall as sit.
for _name in ["dance_beat", "celebrate_focus", "sweat_fan", "worried_battery"]:
    SHEETS[_name] = {"n": None, "ref": 0, "target": 55, "tolerance": 0}
SHEETS["knock_screen"] = {"n": 6, "ref": 0, "target": 64, "tolerance": 0}  # right up against the glass: a bit bigger
SHEETS["watch_tv"] = {"n": None, "ref": 0, "target": 47, "tolerance": 0}
SHEETS["hide_peek"]["cell"] = 6.2  # drawn big: head as big as idle0
SHEETS["glasses_type"]["cell"] = 4.9  # sitting: eye height like sit0
SHEETS["hold_sign"]["cell"] = 4.6  # the sign makes him look tall: sized by the head
SHEETS["chubby_idle"] = {"n": None, "ref": 0, "target": 55, "tolerance": 0}
SHEETS["streamer"] = {"n": 8, "ref": 0, "target": 55, "tolerance": 0}
# Interaction sheets (round 4b): standing, frame 0 as tall as idle0.
for _name, _n in {"look_dirs": 8, "petted": 8, "high_five": 6, "happy_spin": 6, "jump_scare": 6}.items():
    SHEETS[_name] = {"n": _n, "ref": 0, "target": 55, "tolerance": 0}
# Gaze directions and the spin turn his head / body round: never mirrored as a whole.
SHEETS["look_dirs"]["keep_facing"] = True
SHEETS["happy_spin"].update({"keep_facing": True, "anchor": "head"})
# A hat catalogue (one hat per frame; the hats sit on top, so not measured by height).
SHEETS["hats"] = {"n": 8, "cell": 4.7}


def main():
    only = sys.argv[1:]
    report = {}
    for name, cfg in SHEETS.items():
        if only and name not in only:
            continue
        if cfg.get("derived"):
            continue
        if not (GEN / f"{name}.png").exists():
            print("missing", name)
            continue
        process(name, cfg, report)
        print(name, json.dumps(report[name]))


if __name__ == "__main__":
    main()
