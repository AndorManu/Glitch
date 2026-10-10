"""Continuity audit of every junction (see dev/trans-export.mjs).

    node dev/trans-export.mjs && python dev/audit-transitions.py [name-substring ...]

For each sequence (the frame before, the transition/clip keys, the frame
after) it compares consecutive frames as they appear on screen (mirroring
and dx/dy applied):
  - silhouette IoU (how much of the outline stays put),
  - head anchor: x of the head (top third of the body, glitch pixels ignored),
  - feet: the lowest opaque row.
A junction (into or out of the clip) jumps when IoU < 0.55, the head moves
more than 4 art px sideways or the feet more than 2 px; inside a clip the
limits are looser (IoU 0.4, head 8 px), since motion is expected there.

Writes dev/out/transition-audit.txt, and per sequence a strip
dev/out/trans-<name>.png and an animated dev/out/trans-<name>.gif.
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "out"
Z = 3
SCALE = 1.5


def load_index():
    src = (ROOT / "src" / "sprites" / "anim.ts").read_text()
    w = int(re.search(r"ANIM_FRAME_W = (\d+)", src).group(1))
    h = int(re.search(r"ANIM_FRAME_H = (\d+)", src).group(1))
    idx = {m.group(1): int(m.group(2)) for m in re.finditer(r"^  (\w+): (\d+),$", src, re.M)}
    alias_src = (ROOT / "src" / "sprites" / "glitch-anim.ts").read_text()
    for m in re.finditer(r'^  (\w+): "(\w+)",$', alias_src, re.M):
        if m.group(2) in idx and m.group(1) not in idx:
            idx[m.group(1)] = idx[m.group(2)]
    return w, h, idx


W, H, IDX = load_index()
SHEET = np.array(Image.open(ROOT / "public" / "sprites" / "glitch-anim.png").convert("RGBA"))
COLS = SHEET.shape[1] // W


def frame(name, mirror=False, dx=0, dy=0):
    i = IDX.get(name)
    if i is None:
        return None
    a = SHEET[(i // COLS) * H : (i // COLS + 1) * H, (i % COLS) * W : (i % COLS + 1) * W].copy()
    if mirror:
        a = a[:, ::-1]
    ox, oy = round(dx / SCALE), round(dy / SCALE)
    if ox or oy:
        b = np.zeros_like(a)
        ys, xs = slice(max(0, oy), H + min(0, oy)), slice(max(0, ox), W + min(0, ox))
        ys2, xs2 = slice(max(0, -oy), H + min(0, -oy)), slice(max(0, -ox), W + min(0, -ox))
        b[ys, xs] = a[ys2, xs2]
        a = b
    return a


def body_mask(a):
    v = a[:, :, :3].astype(int)
    glitchy = ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))
    return (a[:, :, 3] > 0) & ~glitchy


def metrics(a):
    m = body_mask(a)
    ys, xs = np.where(m)
    if not len(ys):
        return m, None, None
    top, bottom = ys.min(), ys.max()
    head = m[top : top + max(1, (bottom - top) // 3)]
    hy, hx = np.where(head)
    return m, float(hx.mean()), int(bottom)


def compare(a, b):
    ma, ha, fa = metrics(a)
    mb, hb, fb = metrics(b)
    inter = (ma & mb).sum()
    union = (ma | mb).sum()
    iou = inter / union if union else 1.0
    dh = abs(ha - hb) if ha is not None and hb is not None else 0
    df = abs(fa - fb) if fa is not None and fb is not None else 0
    return iou, dh, df


def main():
    seqs = json.loads((OUT / "transitions.json").read_text())
    only = sys.argv[1:]
    lines = []
    flagged = 0
    for s in seqs:
        if only and not any(o in s["name"] for o in only):
            continue
        keys = s["keys"]
        imgs = []
        for k in keys:
            mirror = k.get("mirror", k.get("flip", False))
            f = frame(k["frame"], mirror, k.get("dx", 0), k.get("dy", 0))
            imgs.append(f)
        issues = []
        for i in range(len(keys) - 1):
            a, b = imgs[i], imgs[i + 1]
            if a is None or b is None:
                issues.append(f"missing frame {keys[i]['frame'] if a is None else keys[i + 1]['frame']}")
                continue
            if keys[i]["frame"] == keys[i + 1]["frame"] and keys[i].get("mirror") == keys[i + 1].get("mirror"):
                continue
            iou, dh, df = compare(a, b)
            junction = i == 0 or i == len(keys) - 2
            lim_iou, lim_h, lim_f = (0.55, 4, 2) if junction else (0.4, 8, 3)
            if iou < lim_iou or dh > lim_h or df > lim_f:
                where = "junction" if junction else "inside"
                issues.append(f"{where} {keys[i]['frame']}->{keys[i + 1]['frame']}: IoU {iou:.2f}, head {dh:.1f}px, feet {df}px")
        status = "OK  " if not issues else "JUMP"
        flagged += bool(issues)
        lines.append(f"{status} {s['name']} ({len(keys) - 2} keys)")
        lines.extend(f"       {x}" for x in issues)
        write_strip(s["name"], keys, imgs)
    report = "\n".join(lines) + f"\n\n{flagged} of {len(lines) - sum(1 for l in lines if l.startswith('       '))} sequences flagged\n"
    (OUT / "transition-audit.txt").write_text(report)
    print(report)


def write_strip(name, keys, imgs):
    cw, ch = W * Z, H * Z
    n = len(imgs)
    strip = Image.new("RGBA", (cw * n, ch + 14), (20, 20, 20, 255))
    d = ImageDraw.Draw(strip)
    frames = []
    for j, (k, a) in enumerate(zip(keys, imgs)):
        cell = Image.new("RGBA", (cw, ch), (46, 107, 88, 255))
        cd = ImageDraw.Draw(cell)
        cd.line([(cw // 2, 0), (cw // 2, ch)], fill=(38, 92, 75, 255))
        if a is not None:
            cell.alpha_composite(Image.fromarray(a, "RGBA").resize((cw, ch), Image.NEAREST))
        strip.alpha_composite(cell, (j * cw, 0))
        d.text((j * cw + 3, ch + 2), f"{k['frame']}{' m' if k.get('mirror', k.get('flip')) else ''} {int(k['ms'])}", fill=(230, 230, 230, 255))
        frames.append(cell.convert("RGB"))
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", name)
    strip.save(OUT / f"trans-{safe}.png")
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=96) for f in frames]
    pal[0].save(OUT / f"trans-{safe}.gif", save_all=True, append_images=pal[1:], duration=[max(20, int(k["ms"])) for k in keys], loop=0)


if __name__ == "__main__":
    main()
