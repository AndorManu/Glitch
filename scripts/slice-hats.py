"""Cut the hats out of art/generated/hats.png as overlay sprites.

    python scripts/slice-hats.py            # needs: pip install pillow numpy

hats.png is one row of 8 frames of Glitch standing (like idle0) wearing a
hat, in this order: party, wizard, cap, pumpkin, santa, crown, cowboy,
headphones. Each frame is sliced with the same steps as the animation
sheets (scripts/slice-generated.py: background off, pixel grid recovered,
palette snapped), at the scale where his body matches idle0 best, and
lined up on idle0 by his body. The hat is what differs from idle0 in the
head area (bits of fur that merely moved are dropped as small specks).

Output:
* public/sprites/hats.png: the 8 hats side by side, HAT_W x HAT_H art px each
* src/mascot/hats-data.ts: per hat its cell in that sheet and its anchor:
  the point of the hat that sits on idle0's head top (see headTop()).
  At runtime src/mascot/accessories.ts finds the head top in whatever frame
  is showing (front, side, sitting... the same rule) and pins the anchor there.
* dev/out/slices-hats-overlay.png: the hats on idle0, for review.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("sg", ROOT / "scripts" / "slice-generated.py")
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)

NAMES = ["party", "wizard", "cap", "pumpkin", "santa", "crown", "cowboy", "headphones"]
HAT_W, HAT_H = 64, 48
#: idle0 in the art grid sheet, and its glitch eye (src/sprites/anim.ts ANIM_EYES).
IDLE_EYE = (66, 58)
#: The head-top rule (mirrored in accessories.ts): the head centre is this many
#: art px left of the glitch eye (in the unmirrored frame); the head top is the
#: topmost opaque pixel within +-HEAD_HALF columns of it.
HEAD_DX = -9
HEAD_HALF = 5


def idle0() -> np.ndarray:
    sheet = np.array(Image.open(ROOT / "public" / "sprites" / "glitch-anim.png").convert("RGBA"))
    return sheet[0 : sg.CANVAS_H, 0 : sg.CANVAS_W]


def head_top(a: np.ndarray, eye_x: int) -> tuple[int, int]:
    cx = eye_x + HEAD_DX
    cols = a[:, max(0, cx - HEAD_HALF) : cx + HEAD_HALF + 1, 3] > 0
    rows = np.where(cols.any(1))[0]
    return cx, int(rows.min()) if len(rows) else 0


def shifted(a: np.ndarray, dx: int, dy: int) -> np.ndarray:
    out = np.zeros_like(a)
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def body_fit(f: np.ndarray, ref: np.ndarray) -> tuple[float, int, int]:
    """Best overlap (IoU) of the body below the eyes, and the shift that gives it."""
    rows = slice(IDLE_EYE[1] + 4, sg.CANVAS_H)
    r = ref[rows, :, 3] > 0
    best = (0.0, 0, 0)
    for dy in range(-4, 5):
        for dx in range(-8, 9):
            m = shifted(f, dx, dy)[rows, :, 3] > 0
            iou = (m & r).sum() / max(1, (m | r).sum())
            if iou > best[0]:
                best = (iou, dx, dy)
    return best


def specks_off(m: np.ndarray, min_px: int = 6) -> np.ndarray:
    out = np.zeros_like(m)
    for c in sg._components(m):
        if c.sum() >= min_px:
            out |= c
    return out


def main() -> None:
    ref = idle0()
    report = {}
    # The scale where the bodies match best (the sheet is drawn a bit bigger than idle).
    best = None
    for cell in np.arange(3.6, 4.61, 0.1):
        frames = sg.process("hats", {"cell": float(cell), "n": 8}, {})
        fits = [body_fit(f, ref) for f in frames]
        score = float(np.mean([x[0] for x in fits]))
        if best is None or score > best[0]:
            best = (score, float(cell), frames, fits)
    score, cell, frames, fits = best
    print(f"cell {cell:.2f}, body overlap {score:.2f}")
    hx, hy = head_top(ref, IDLE_EYE[0])
    sheet = Image.new("RGBA", (HAT_W * len(NAMES), HAT_H))
    review = Image.new("RGBA", (sg.CANVAS_W * len(NAMES), sg.CANVAS_H), (40, 96, 79, 255))
    data = {}
    for i, (name, f, (iou, dx, dy)) in enumerate(zip(NAMES, frames, fits)):
        f = shifted(f, dx, dy)
        a = f[:, :, 3] > 0
        b = ref[:, :, 3] > 0
        diff = np.abs(f[:, :, :3].astype(int) - ref[:, :, :3].astype(int)).sum(2)
        hat = a & (~b | (diff > 90))
        # Only the head area: above the muzzle, and never the glitch-eye bits on the right.
        hat[IDLE_EYE[1] + 6 :] = False
        r, g, bl = (f[:, :, k].astype(int) for k in range(3))
        magenta = (r > 150) & (bl > 180) & (g < 110)
        if name not in ("party", "wizard", "cap", "headphones"):
            hat &= ~magenta
        hat[:, IDLE_EYE[0] + 6 :] &= ~magenta[:, IDLE_EYE[0] + 6 :]
        # The face below the eyes' top belongs to him (winking Santa), except headphone cups.
        if name != "headphones":
            hat[IDLE_EYE[1] - 4 :] = False
        else:
            # Only the ear cups at the sides of the face.
            hat[IDLE_EYE[1] - 4 :, hx - 14 : hx + 15] = False
        hat = specks_off(hat)
        if name == "headphones":
            # The right cup hides in the glitch eye's sparks: mirror the left one over.
            y_lo = IDLE_EYE[1] - 10
            row = ref[IDLE_EYE[1] - 6]
            rr, rg, rb = (row[:, k].astype(int) for k in range(3))
            face = np.where((row[:, 3] > 0) & ~((rr > 150) & (rb > 180) & (rg < 110)) & (rb < 200))[0]
            mid2 = int(face.min() + face.max())
            for y, x in zip(*np.where(hat[y_lo:, : face.min() + 3])):
                y += y_lo
                mx = mid2 - x
                if 0 <= mx < f.shape[1]:
                    hat[y, mx] = True
                    f[y, mx] = f[y, x]
        ys, xs = np.where(hat)
        if not len(ys):
            print("  no hat found in", name)
            continue
        x0 = max(0, min(xs.min(), hx - HAT_W // 2))
        y0 = ys.min()
        crop = np.zeros((HAT_H, HAT_W, 4), np.uint8)
        part = np.where(hat[..., None], f, 0)[y0 : y0 + HAT_H, x0 : x0 + HAT_W]
        crop[: part.shape[0], : part.shape[1]] = part
        sheet.alpha_composite(Image.fromarray(crop, "RGBA"), (i * HAT_W, 0))
        data[name] = {"cell": i, "anchor": [int(hx - x0), int(hy - y0)]}
        report[name] = {"iou": round(iou, 2), "shift": [dx, dy], "px": int(hat.sum())}
        over = Image.fromarray(ref, "RGBA").copy()
        over.alpha_composite(Image.fromarray(crop, "RGBA"), (int(x0), int(y0)))
        review.alpha_composite(over, (i * sg.CANVAS_W, 0))
    out = ROOT / "public" / "sprites" / "hats.png"
    sheet.save(out)
    sg.DEV.mkdir(parents=True, exist_ok=True)
    review.resize((review.width * 4, review.height * 4), Image.NEAREST).save(sg.DEV / "slices-hats-overlay.png")
    ts = [
        "// GENERATED by scripts/slice-hats.py - do not edit by hand.",
        "// Hat overlays in public/sprites/hats.png: cell index and the anchor (art px",
        "// inside the cell) that sits on the head top (see accessories.ts headTop).",
        "",
        f"export const HAT_CELL = {{ w: {HAT_W}, h: {HAT_H} }};",
        f"export const HEAD_DX = {HEAD_DX};",
        f"export const HEAD_HALF = {HEAD_HALF};",
        "export const HAT_SPRITES: Record<string, { cell: number; anchor: [number, number] }> = "
        + json.dumps(data).replace('"cell"', "cell").replace('"anchor"', "anchor")
        + ";",
        "",
    ]
    (ROOT / "src" / "mascot" / "hats-data.ts").write_text("\n".join(ts), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
