"""Per-sheet consistency audit of the sliced frames (art/frames), against the
original character (art/puppet/src/pose-00.png, the original front pose).

    python dev/sheet-audit.py   -> dev/out/sheet-audit.txt, dev/out/quality-lineup.png

Per sheet:
  eye      where the magenta glitch eye is relative to the head, per frame. The
           canonical side is the original front pose's (right of the head
           centre in the picture; a side view facing right shows it on the
           right too). Flags frames with the eye on the other side and sheets
           where frames disagree (mixed).
  block    source px per art px block (from the slicer's log) - drawing scale
  height   median character height (art px, glitch pixels ignored)
  outline  mean luminance of the silhouette's edge pixels (lower = darker outline)
  colour   L1 distance of the colour histogram to the original pose (0..2)
  colours  distinct colours per frame (blur / noise in the source shows up here)
"""

import json
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
FRAMES = ROOT / "art" / "frames"
OUT = ROOT / "dev" / "out"


def load(p):
    a = np.array(Image.open(p).convert("RGBA"))
    a[a[:, :, 3] < 128] = 0
    return a


def glitchy(a):
    v = a[:, :, :3].astype(int)
    return ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))


def eye_x(a):
    v = a[:, :, :3].astype(int)
    m = ((a[:, :, 3] > 0) & (v[..., 0] > 150) & (v[..., 2] > 180) & (v[..., 1] < 110)).astype(int)
    if m.sum() < 4:
        return None
    k = 5
    p = np.pad(m, k)
    c = np.cumsum(np.cumsum(p, 0), 1)
    win = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    if win.max() < 6:
        return None
    y, x = np.unravel_index(int(np.argmax(win)), win.shape)
    return x - k / 2, y - k / 2


def head_centre(a):
    m = (a[:, :, 3] > 0) & ~glitchy(a)
    ys, xs = np.where(m)
    if not len(ys):
        return None
    top, bottom = ys.min(), ys.max()
    band = m[top : top + max(1, (bottom - top) * 2 // 5)]
    hy, hx = np.where(band)
    return hx.mean()


def hist(a):
    m = (a[:, :, 3] > 0) & ~glitchy(a)
    px = a[m][:, :3] // 32
    h = np.zeros(512)
    np.add.at(h, px[:, 0] * 64 + px[:, 1] * 8 + px[:, 2], 1)
    return h / max(1, h.sum())


def outline_lum(a):
    op = a[:, :, 3] > 0
    inner = np.zeros_like(op)
    inner[1:-1, 1:-1] = op[:-2, 1:-1] & op[2:, 1:-1] & op[1:-1, :-2] & op[1:-1, 2:]
    edge = op & ~inner & ~glitchy(a)
    v = a[edge][:, :3].astype(float)
    return float((v * [0.3, 0.59, 0.11]).sum(1).mean()) if len(v) else 0.0


def main():
    sheets = {}
    for p in sorted(FRAMES.glob("*.png")):
        m = re.match(r"(.+)-(\d+)\.png$", p.name)
        sheets.setdefault(m.group(1), []).append((int(m.group(2)), p))
    log = {}
    for line in (OUT / "slice-log.txt").read_text().splitlines() if (OUT / "slice-log.txt").exists() else []:
        m = re.match(r"(\w+) (\{.*\})$", line.strip())
        if m:
            log[m.group(1)] = json.loads(m.group(2))
    ref = load(ROOT / "art" / "puppet" / "src" / "pose-00.png")
    ref_hist = hist(ref)
    rows, lineup = [], []
    for name, frames in sorted(sheets.items()):
        frames = [load(p) for _, p in sorted(frames)]
        sides = []
        for f in frames:
            e, hc = eye_x(f), head_centre(f)
            sides.append("?" if e is None or hc is None else ("R" if e[0] >= hc else "L"))
        known = [s for s in sides if s != "?"]
        mixed = len(set(known)) > 1
        wrong = [i for i, s in enumerate(sides) if s == "L"]
        heights = []
        for f in frames:
            ys = np.where(((f[:, :, 3] > 0) & ~glitchy(f)).any(1))[0]
            heights.append(int(ys.max() - ys.min() + 1) if len(ys) else 0)
        colour = float(np.abs(np.mean([hist(f) for f in frames], 0) - ref_hist).sum())
        outline = float(np.mean([outline_lum(f) for f in frames]))
        ncol = float(np.mean([len(np.unique(f[f[:, :, 3] > 0][:, :3], axis=0)) for f in frames]))
        block = log.get(name, {}).get("block_px")
        flags = []
        if mixed:
            flags.append(f"MIXED eye sides {''.join(sides)}")
        elif wrong:
            flags.append(f"eye on the LEFT in all frames ({''.join(sides)})")
        if colour > 0.9:
            flags.append(f"colours drift ({colour:.2f})")
        if outline > 60:
            flags.append(f"weak outline (lum {outline:.0f})")
        rows.append(f"{name:16s} frames {len(frames):2d}  block {block if block else '-':>5}  height {int(np.median(heights)):3d}  outline {outline:5.1f}  colour {colour:4.2f}  colours {ncol:5.0f}  eyes {''.join(sides)}  {'; '.join(flags)}")
        lineup.append((name, frames[0]))
    ref_line = f"{'ORIGINAL pose 0':16s} height {ref.shape[0]}  outline {outline_lum(ref):5.1f}  colours {len(np.unique(ref[ref[:, :, 3] > 0][:, :3], axis=0))}"
    report = "\n".join([ref_line, *rows]) + "\n"
    (OUT / "sheet-audit.txt").write_text(report)
    print(report)
    # Lineup: the original front pose, then frame 0 of every sheet, 3x, dark background.
    z = 3
    cells = [("ORIGINAL", ref)] + lineup
    cw, ch = 104 * z, 90 * z + 14
    cols = 8
    img = Image.new("RGBA", (cw * cols, ch * ((len(cells) + cols - 1) // cols)), (22, 20, 28, 255))
    d = ImageDraw.Draw(img)
    for i, (n, f) in enumerate(cells):
        x, y = (i % cols) * cw, (i // cols) * ch
        im = Image.fromarray(f, "RGBA")
        im = im.resize((im.width * z, im.height * z), Image.NEAREST)
        img.alpha_composite(im, (x + (cw - im.width) // 2, y + 90 * z - im.height))
        d.text((x + 4, y + 90 * z + 1), n, fill=(230, 230, 230, 255))
    img.save(OUT / "quality-lineup.png")
    print("wrote", OUT / "quality-lineup.png")


if __name__ == "__main__":
    main()
