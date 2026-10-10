"""Visual QA, step 1: static audit of every frame of the animation sheet.

    python dev/vqa-frames.py   -> dev/out/vqa/frames/*.png contact sheets + dev/out/vqa/frames.json

Contact sheets (one per animation group, 4 rows each):
  art 2x on dark, art 2x on light (nearest neighbour, the true pixels)
  @1x display sheet (1.5x, smoothed) on dark and on light (where a halo would show)
with a green baseline (the group's median feet row), a red frame border and the
measured glitch eye (cyan cross = ANIM_EYES, as the renderer uses it).

Per frame metrics (art px):
  bbox, h (character height), base (lowest opaque row), clip (touches frame edge: which sides)
  semi    pixels with 0 < alpha < 255 (pixel art should have none)
  halo    edge pixels that are light and unsaturated (grey/white fringe), in the art sheet
  halo1x  same in the @1x display sheet, resampled (fringe from smoothing against white)
  outline share of the silhouette's edge pixels that are dark (lum < 90)
  strays  small detached components (< 6 px) away from the body, glitch colours excluded
  eye     magenta pixels near ANIM_EYES, and the eye's side vs the head centre
  colours distinct opaque colours
"""

import json
import re
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "out" / "vqa" / "frames"
OUT.mkdir(parents=True, exist_ok=True)
FW, FH = 104, 90

src = (ROOT / "src/sprites/anim.ts").read_text()
head, rest = src.split("ANIM_EYES", 1)
INDEX = {m[0]: int(m[1]) for m in re.findall(r"^  (\w+): (\d+),", head, re.M)}
EYES = {m[0]: (int(m[1]), int(m[2])) for m in re.findall(r"^  (\w+): \[(\d+), (\d+)\],", rest.split("ANIM_GRIPS")[0], re.M)}
GROUPS: "OrderedDict[str, list[str]]" = OrderedDict()
for n in INDEX:
    GROUPS.setdefault(re.sub(r"\d+$", "", n), []).append(n)

art = np.array(Image.open(ROOT / "public/sprites/glitch-anim.png").convert("RGBA"))
d1 = np.array(Image.open(ROOT / "public/sprites/glitch-anim@1x.png").convert("RGBA"))
COLS = art.shape[1] // FW

FRONT = ["idle", "talk", "wave", "think", "laugh", "celebrate", "sad", "angry", "scared", "eat", "dance", "typing", "point", "dizzy", "sneeze", "listen", "surprised", "scratch", "groom", "shake_off", "hop_idle", "tail_chase", "annoyed", "bite_cursor", "sit_down", "stand_up_paws", "stand_up_hop", "stand_up_glitch", "wake", "sit", "pose_front", "pose_happy", "pose_think", "pose_laugh", "pose_wave", "pose_sit"]


def cell(a, i, k=1):
    r, c = divmod(i, COLS)
    return a[int(r * FH * k) : int((r + 1) * FH * k), int(c * FW * k) : int((c + 1) * FW * k)]


def glitchy(px):
    v = px[..., :3].astype(int)
    return ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))


def magenta(px):
    v = px[..., :3].astype(int)
    return (v[..., 0] > 150) & (v[..., 2] > 150) & (v[..., 1] < 110)


def lum(px):
    v = px[..., :3].astype(float)
    return 0.299 * v[..., 0] + 0.587 * v[..., 1] + 0.114 * v[..., 2]


def edge_mask(op):
    pad = np.pad(op, 1)
    inner = pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
    return op & ~inner


def components(mask):
    """4-connected components: list of (size, ys, xs)."""
    h, w = mask.shape
    seen = np.zeros_like(mask, bool)
    out = []
    for y0, x0 in zip(*np.where(mask)):
        if seen[y0, x0]:
            continue
        stack = [(y0, x0)]
        seen[y0, x0] = True
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    stack.append((yy, xx))
        out.append(pts)
    return out


def audit(name):
    a = cell(art, INDEX[name])
    al = a[..., 3]
    op = al > 0
    m = {"name": name}
    if not op.any():
        m["empty"] = True
        return m
    ys, xs = np.where(op)
    m["bbox"] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    m["h"] = int(ys.max() - ys.min() + 1)
    m["base"] = int(ys.max())
    clip = []
    if op[0].any():
        clip.append("top")
    if op[-1].any():
        clip.append("bottom")
    if op[:, 0].any():
        clip.append("left")
    if op[:, -1].any():
        clip.append("right")
    m["clip"] = clip
    m["semi"] = int(((al > 0) & (al < 255)).sum())
    e = edge_mask(op)
    L = lum(a)
    sat = a[..., :3].max(-1).astype(int) - a[..., :3].min(-1).astype(int)
    m["halo"] = int((e & (L > 170) & (sat < 40)).sum())
    m["outline"] = round(float((e & (L < 90)).sum()) / max(1, e.sum()), 2)
    # strays: small components not glitch coloured
    comps = components(op & ~glitchy(a))
    comps.sort(key=len, reverse=True)
    strays = [c for c in comps[1:] if len(c) < 6]
    m["strays"] = [[int(c[0][1]), int(c[0][0]), len(c)] for c in strays][:8]
    m["parts"] = len([c for c in comps if len(c) >= 6])
    # @1x display halo: light fringe along the edge
    b = cell(d1, INDEX[name], 1.5)
    ob = b[..., 3] > 40
    eb = edge_mask(ob)
    Lb = lum(b)
    satb = b[..., :3].max(-1).astype(int) - b[..., :3].min(-1).astype(int)
    m["halo1x"] = int((eb & (Lb > 170) & (satb < 40)).sum())
    # eye
    mg = magenta(a) & op
    m["magenta"] = int(mg.sum())
    ey = EYES.get(name)
    if ey:
        x, y = ey
        win = mg[max(0, y - 3) : y + 4, max(0, x - 3) : x + 4]
        m["eye_hit"] = bool(win.any())
        # head centre: the bbox's horizontal centre of the top 35% of the silhouette
        top = ys.min() + 0.35 * (ys.max() - ys.min())
        hx = xs[ys <= top]
        m["eye_side"] = "R" if x > (hx.min() + hx.max()) / 2 else "L"
    m["colours"] = int(len(np.unique(a[op][:, :3], axis=0)))
    body = op & ~glitchy(a)
    by, bx = np.where(body)
    m["cx"], m["cy"] = round(float(bx.mean()), 1), round(float(by.mean()), 1)
    fb = by.max()
    fx = bx[by >= fb - 2]
    m["feet"] = [int(fx.min()), int(fx.max())]
    # head centre: top 30% of the body silhouette (glitch pixels ignored)
    ht = by.min() + 0.3 * (by.max() - by.min())
    hx = bx[by <= ht]
    m["head"] = [round(float(hx.mean()), 1), int(by.min())]
    return m


metrics = {n: audit(n) for n in INDEX}

# group medians: height and baseline
for g, names in GROUPS.items():
    hs = [metrics[n]["h"] for n in names if "h" in metrics[n]]
    bs = [metrics[n]["base"] for n in names if "base" in metrics[n]]
    mh, mb = float(np.median(hs)), float(np.median(bs))
    for n in names:
        mm = metrics[n]
        mm["dh"] = mm["h"] - mh
        mm["dbase"] = mm["base"] - mb

GLOBAL_BASE = float(np.median([m["base"] for m in metrics.values() if "base" in m]))
GLOBAL_H = float(np.median([metrics[n]["h"] for n in GROUPS["idle"]]))

try:
    FONT = ImageFont.truetype("consola.ttf", 11)
except OSError:
    FONT = ImageFont.load_default()


def sheet(g, names):
    k = 2
    tw, th = FW * k, FH * k
    rows = [("art 2x dark", (21, 19, 31)), ("art 2x light", (240, 238, 245)), ("@1x display, dark", (21, 19, 31)), ("@1x display, light", (255, 255, 255))]
    W = len(names) * (tw + 6) + 6
    H = len(rows) * (th + 30) + 24
    out = Image.new("RGB", (W, H), (60, 60, 70))
    dr = ImageDraw.Draw(out)
    dr.text((6, 4), f"{g}  ({len(names)} frames)  green = group baseline, yellow = global baseline {GLOBAL_BASE:.0f}, cyan = ANIM_EYES", fill=(255, 255, 255), font=FONT)
    base = np.median([metrics[n]["base"] for n in names])
    for r, (label, bg) in enumerate(rows):
        y0 = 24 + r * (th + 30)
        for j, n in enumerate(names):
            x0 = 6 + j * (tw + 6)
            tile = Image.new("RGBA", (tw, th), bg + (255,))
            if r < 2:
                fr = Image.fromarray(cell(art, INDEX[n])).resize((tw, th), Image.NEAREST)
            else:
                fr = Image.fromarray(cell(d1, INDEX[n], 1.5)).resize((tw, th), Image.NEAREST)
            tile.alpha_composite(fr)
            td = ImageDraw.Draw(tile)
            td.rectangle([0, 0, tw - 1, th - 1], outline=(255, 60, 60))
            td.line([(0, (base + 1) * k), (tw, (base + 1) * k)], fill=(80, 255, 120))
            td.line([(0, (GLOBAL_BASE + 1) * k), (8, (GLOBAL_BASE + 1) * k)], fill=(255, 230, 0))
            if n in EYES:
                ex, ey = EYES[n]
                cx, cy = ex * k + k / 2, ey * k + k / 2
                td.line([(cx - 6, cy), (cx + 6, cy)], fill=(0, 255, 255))
                td.line([(cx, cy - 6), (cx, cy + 6)], fill=(0, 255, 255))
            out.paste(tile.convert("RGB"), (x0, y0))
            mm = metrics[n]
            flags = []
            if mm.get("clip"):
                flags.append("CLIP " + "/".join(mm["clip"]))
            if abs(mm.get("dh", 0)) > 4:
                flags.append(f"h{mm['dh']:+.0f}")
            if abs(mm.get("dbase", 0)) > 1:
                flags.append(f"base{mm['dbase']:+.0f}")
            if mm.get("strays"):
                flags.append(f"stray{len(mm['strays'])}")
            if mm.get("eye_hit") is False:
                flags.append("EYE?")
            if mm.get("halo", 0) > 3:
                flags.append(f"halo{mm['halo']}")
            if r == 0:
                dr.text((x0, y0 + th + 2), n, fill=(255, 255, 255), font=FONT)
                dr.text((x0, y0 + th + 14), " ".join(flags), fill=(255, 140, 140), font=FONT)
            elif r == 2:
                dr.text((x0, y0 + th + 2), f"h{mm['h']} base{mm['base']} out{mm['outline']} halo1x {mm['halo1x']}", fill=(220, 220, 220), font=FONT)
        dr.text((W - 160, y0 + th + 16), label, fill=(255, 255, 0), font=FONT)
    out.save(OUT / f"{g}.png")


for g, names in GROUPS.items():
    sheet(g, names)

# Height lineup: one representative frame of every group side by side on a common baseline.
k = 2
reps = [names[0] for names in GROUPS.values()]
lw = len(reps) * FW * k // 2 + 40
line = Image.new("RGB", (min(lw, 6000), FH * k * 2 + 60), (21, 19, 31))
per_row = (len(reps) + 1) // 2
dr = ImageDraw.Draw(line)
for i, n in enumerate(reps):
    r, c = divmod(i, per_row)
    fr = Image.fromarray(cell(art, INDEX[n])).resize((FW * k, FH * k), Image.NEAREST)
    x0, y0 = 10 + c * (FW * k - 60), 10 + r * (FH * k + 30)
    line.paste(fr, (x0, y0), fr)
    dr.text((x0 + 60, y0 + FH * k + 2), n, fill=(255, 255, 255), font=FONT)
    dr.line([(x0, y0 + (GLOBAL_BASE + 1) * k), (x0 + FW * k, y0 + (GLOBAL_BASE + 1) * k)], fill=(80, 255, 120))
line.save(OUT / "_lineup.png")

json.dump({"global_base": GLOBAL_BASE, "idle_h": GLOBAL_H, "frames": metrics}, open(OUT.parent / "frames.json", "w"), indent=0)

# Text summary of suspects.
lines = []
for n, m in metrics.items():
    f = []
    if m.get("empty"):
        f.append("EMPTY")
    if m.get("clip"):
        f.append("clip:" + "/".join(m["clip"]))
    if m.get("semi"):
        f.append(f"semi-alpha:{m['semi']}")
    if m.get("halo", 0) > 3:
        f.append(f"halo:{m['halo']}")
    if m.get("strays"):
        f.append(f"strays:{m['strays']}")
    if m.get("eye_hit") is False:
        f.append(f"eye-miss@{EYES.get(n)} magenta={m['magenta']}")
    if abs(m.get("dh", 0)) > 4:
        f.append(f"height {m['h']} ({m['dh']:+.0f} vs group)")
    if abs(m.get("dbase", 0)) > 1:
        f.append(f"baseline {m['base']} ({m['dbase']:+.0f} vs group)")
    if m.get("outline", 1) < 0.45:
        f.append(f"weak-outline:{m['outline']}")
    if f:
        lines.append(f"{n:22s} " + "; ".join(f))
(OUT.parent / "frames.txt").write_text("\n".join(lines))
print(len(lines), "frames with flags; global base", GLOBAL_BASE, "idle h", GLOBAL_H)


# Compact review pages: 5 groups per page, each group = art 2x on dark + @1x display on white.
def compact():
    k = 2
    tw, th = FW * k, FH * k
    items = list(GROUPS.items())
    pages = [items[i : i + 5] for i in range(0, len(items), 5)]
    for p, chunk in enumerate(pages):
        W = 8 * (tw + 4) + 4
        H = len(chunk) * (2 * th + 40)
        out = Image.new("RGB", (W, H), (70, 70, 80))
        dr = ImageDraw.Draw(out)
        for gi, (g, names) in enumerate(chunk):
            y0 = gi * (2 * th + 40)
            base = np.median([metrics[n]["base"] for n in names])
            for j, n in enumerate(names[:8]):
                x0 = 4 + j * (tw + 4)
                for r, (bg, src) in enumerate((((21, 19, 31), "art"), ((255, 255, 255), "d1"))):
                    tile = Image.new("RGBA", (tw, th), bg + (255,))
                    fr = Image.fromarray(cell(art, INDEX[n]) if src == "art" else cell(d1, INDEX[n], 1.5)).resize((tw, th), Image.NEAREST)
                    tile.alpha_composite(fr)
                    td = ImageDraw.Draw(tile)
                    td.line([(0, (base + 1) * k - 1), (tw, (base + 1) * k - 1)], fill=(80, 255, 120))
                    out.paste(tile.convert("RGB"), (x0, y0 + 14 + r * (th + 2)))
                dr.text((x0, y0 + 2), n, fill=(255, 255, 0), font=FONT)
        out.save(OUT / f"_page{p:02d}.png")
    return len(pages)


print("pages", compact())
