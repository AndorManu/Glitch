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
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "art" / "generated"
OUT = ROOT / "art" / "frames"
DEV = ROOT / "dev" / "out"

CANVAS_W, CANVAS_H = 100, 90
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
    return ~bg


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


def split_touching(segs, mask, n):
    """Frames whose tails touch the next one come out as one wide segment:
    cut it at the thinnest columns (the gap between the bodies)."""
    col = mask.sum(0)
    while len(segs) < n:
        widths = [b - a for a, b in segs]
        i = int(np.argmax(widths))
        a, b = segs[i]
        typical = float(np.median(widths)) if len(segs) > 2 else (b - a) / 2
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
    pitch, _, _ = best_pitch(np.concatenate([np.pad(c, ((0, 400 - c.shape[0] if c.shape[0] < 400 else 0), (0, 0), (0, 0))) for c in crops], 1)[:400], 5.0, 11.0)
    cell = pitch / 2
    # Normalise to the original character's size: the reference frame's height in art px.
    ref = crops[cfg.get("ref", 0)]
    natural_h = ref.shape[0] / cell
    target_h = cfg.get("target", TARGET_STAND_H)
    scale_cell = ref.shape[0] / target_h
    use = cfg["cell"] if "cell" in cfg else cell if abs(natural_h / target_h - 1) < cfg.get("tolerance", 0.04) else scale_cell
    frames = []
    votes = 0
    for i, c in enumerate(crops):
        _, ox, oy = best_pitch(c, use * 2 - 0.01, use * 2 + 0.01)
        art = trim(dehalo(sample(c, use, ox % use, oy % use)))
        ex = glitch_eye_x(art)
        if ex is not None:
            votes += 1 if ex > art.shape[1] / 2 else -1
        frames.append(art)
    # The glitch eye is on his right eye: in our convention it shows on the
    # right of the picture. Mirror the whole sheet if most frames have it left.
    if votes < 0:
        frames = [f[:, ::-1].copy() for f in frames]
    # Body centred; `shift` moves a whole sheet (e.g. the long run tail must fit the canvas).
    anchors = [body_x(f, "left") - cfg.get("shift", 0) for f in frames]
    placed = [place(f, ax) for f, ax in zip(frames, anchors)]
    clipped = [i for i, (f, p) in enumerate(zip(frames, placed)) if (p[:, :, 3] > 0).sum() < (f[:, :, 3] > 0).sum()]
    if clipped:
        print(f"  WARNING {name}: frames {clipped} clipped by the canvas")
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
              "peek", "push", "spin", "teleport", "listen", "celebrate", "dance", "eat", "grab_tab"]:
    SHEETS[_name] = {"cell": 3.8}


def main():
    only = sys.argv[1:]
    report = {}
    for name, cfg in SHEETS.items():
        if only and name not in only:
            continue
        if not (GEN / f"{name}.png").exists():
            print("missing", name)
            continue
        process(name, cfg, report)
        print(name, json.dumps(report[name]))


if __name__ == "__main__":
    main()
