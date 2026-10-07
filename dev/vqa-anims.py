"""Visual QA, steps 2 and 3: judges dev/out/vqa/anims.json (node dev/vqa-anims.mjs)
against the art: every pair of consecutive drawn keys is overlaid as the
renderer places it (dx/dy, flip; rotation/scale ignored) and measured.

    python dev/vqa-anims.py   -> dev/out/vqa/anims.txt, anim-findings.json,
                                 dev/out/vqa/anims/<name>.png strips + .gif,
                                 dev/out/vqa/pairs/<A>-<B>.png strips of the worst switches

Between consecutive drawn keys a -> b:
  iou     silhouette overlap (body pixels, glitch colours ignored)
  head    head-centre jump (art px), feet = feet-centre jump, base = feet row change
  fam     family change a -> b with no clip frame on either side (a pose pop)
A key is "masked" when either side has glitch >= 0.3 or dissolve > 0 (a cut hidden by an effect).
Per animation: loop seam (last key of a loop -> first of the next), flicker (a frame
shown for <= 60 ms between two of another), long holds, flip on frames that never mirror.
"""

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
V = ROOT / "dev" / "out" / "vqa"
(V / "anims").mkdir(parents=True, exist_ok=True)
(V / "pairs").mkdir(parents=True, exist_ok=True)
FW, FH = 104, 90
S = 1.5  # CSS px per art px

src = (ROOT / "src/sprites/anim.ts").read_text()
INDEX = {m[0]: int(m[1]) for m in re.findall(r"^  (\w+): (\d+),", src.split("ANIM_EYES")[0], re.M)}
data = json.loads((V / "anims.json").read_text())
FR = data["frames"]
art = np.array(Image.open(ROOT / "public/sprites/glitch-anim.png").convert("RGBA"))
COLS = art.shape[1] // FW
try:
    FONT = ImageFont.truetype("consola.ttf", 11)
except OSError:
    FONT = ImageFont.load_default()


def glitchy(px):
    v = px[..., :3].astype(int)
    return ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))


_cell = {}


def cell(frame):
    t = FR.get(frame, {}).get("target", frame)
    if t not in _cell:
        r, c = divmod(INDEX[t], COLS)
        a = art[r * FH : (r + 1) * FH, c * FW : (c + 1) * FW]
        _cell[t] = (a, (a[..., 3] > 0) & ~glitchy(a))
    return _cell[t]


PAD = 40


def placed(key):
    """Body mask on a padded canvas as the renderer places it (facing right)."""
    _, m = cell(key["frame"])
    mir = FR.get(key["frame"], {}).get("mirrorable", True) and key.get("flip")
    if mir:
        m = m[:, ::-1]
    c = np.zeros((FH + 2 * PAD, FW + 2 * PAD), bool)
    ox = PAD + int(round(key.get("dx", 0) / S))
    oy = PAD + int(round(key.get("dy", 0) / S))
    ox = max(0, min(2 * PAD, ox))
    oy = max(0, min(2 * PAD, oy))
    c[oy : oy + FH, ox : ox + FW] = m
    return c


def geom(c):
    ys, xs = np.where(c)
    if not len(ys):
        return None
    top = ys.min() + 0.3 * (ys.max() - ys.min())
    feet = xs[ys >= ys.max() - 2]
    return {"head": (xs[ys <= top].mean(), ys.min()), "feet": (feet.mean(), ys.max()), "c": (xs.mean(), ys.mean())}


def compare(a, b):
    ca, cb = placed(a), placed(b)
    inter = (ca & cb).sum()
    uni = (ca | cb).sum()
    ga, gb = geom(ca), geom(cb)
    if not ga or not gb:
        return {"iou": 1.0, "head": 0, "feet": 0, "base": 0}
    return {
        "iou": round(float(inter / max(1, uni)), 2),
        "head": round(float(np.hypot(ga["head"][0] - gb["head"][0], ga["head"][1] - gb["head"][1])), 1),
        "feet": round(float(abs(ga["feet"][0] - gb["feet"][0])), 1),
        "base": int(gb["feet"][1] - ga["feet"][1]),
    }


CLIPS = ("sit_down", "stand_up_", "turn_", "walk_start", "walk_stop", "lie_down", "get_up", "wake")


def is_clip(f):
    return f.startswith(CLIPS)


def masked(k):
    return (k.get("glitch") or 0) >= 0.3 or (k.get("dissolve") or 0) > 0


def drawn_change(a, b):
    return a["frame"] != b["frame"] or a.get("flip") != b.get("flip") or abs(a.get("dx", 0) - b.get("dx", 0)) > 0.01 or abs(a.get("dy", 0) - b.get("dy", 0)) > 0.01


def judge(a, b):
    """Is a -> b a visible pop? Returns (score, reasons)."""
    if (a.get("dissolve") or 0) >= 1 or (b.get("dissolve") or 0) >= 1:
        return 0, []
    m = compare(a, b)
    fa, fb = FR[a["frame"]]["family"], FR[b["frame"]]["family"]
    r = []
    sc = 0
    same_sheet = re.sub(r"\d+$", "", FR[a["frame"]]["target"]) == re.sub(r"\d+$", "", FR[b["frame"]]["target"])
    if fa != fb and "any" not in (fa, fb) and not is_clip(a["frame"]) and not is_clip(b["frame"]):
        r.append(f"family {fa}->{fb} with no clip")
        sc += 3
    if m["iou"] < 0.45:
        r.append(f"IoU {m['iou']}")
        sc += 2 if m["iou"] < 0.3 else 1
    if m["head"] > 10:
        r.append(f"head jumps {m['head']} art px")
        sc += 1 + (m["head"] > 18)
    if fa in ("front", "sit", "side", "curled") and fb == fa and abs(m["base"]) > 1:
        r.append(f"feet row moves {m['base']:+d} art px")
        sc += 1
    if fa in ("front", "sit", "curled") and fb == fa and m["feet"] > 3 and abs(a.get("dx", 0) - b.get("dx", 0)) < 0.5:
        r.append(f"feet slide {m['feet']} art px")
        sc += 1
    if not same_sheet and sc:
        sc += 1
    return sc, r + ([f"metrics {m}"] if r else [])


findings = []


def analyse(label, keys, kind, t0=None):
    out = []
    for i in range(1, len(keys)):
        a, b = keys[i - 1], keys[i]
        if not drawn_change(a, b):
            continue
        sc, why = judge(a, b)
        if sc >= 2:
            f = {
                "where": label,
                "kind": kind,
                "i": i,
                "at": b["at"] - (t0 or 0),
                "from": f"{a['anim']}:{a['frame']}{' flip' if a.get('flip') else ''}",
                "to": f"{b['anim']}:{b['frame']}{' flip' if b.get('flip') else ''}",
                "score": sc,
                "masked": masked(a) or masked(b),
                "why": why,
            }
            out.append(f)
    return out


# ------------------------------------------------------------ solo animations
solo_rows = []
per_anim = {}
for key, keys in data["solo"].items():
    name, seed = key.split("#")
    fs = analyse(key, keys, "solo")
    findings.extend(fs)
    # flicker: frame shown <= 60 ms between two keys of another identical frame
    flick = []
    for i in range(1, len(keys) - 1):
        a, b, c = keys[i - 1], keys[i], keys[i + 1]
        dur = c["at"] - b["at"]
        if dur <= 60 and a["frame"] == c["frame"] and b["frame"] != a["frame"] and not masked(b):
            flick.append(f"{b['frame']}@{b['at']}({dur}ms)")
    # holds: the longest static key
    holds = [(keys[i + 1]["at"] - keys[i]["at"], keys[i]["frame"]) for i in range(len(keys) - 1)]
    longest = max(holds, default=(0, "-"))
    flips = sorted({k["frame"] for k in keys if k.get("flip") and not FR[k["frame"]]["mirrorable"]})
    seq = [k["frame"] for k in keys]
    per_anim.setdefault(name, []).append({"seed": seed, "keys": len(keys), "flicker": flick, "longest_hold": longest, "flip_ignored": flips, "pops": len([f for f in fs if not f["masked"]]), "frames": Counter(re.sub(r"\d+$", "", s) for s in seq)})

# ------------------------------------------------------------ A -> B switches
pair_scores = []
for key, p in data["pairs"].items():
    A, B = key.split(">")
    keys = p["keys"]
    # only the switch itself and the first 1.2 s after it (B's own pops are solo findings)
    k0 = next((i for i, k in enumerate(keys) if k["at"] >= p["t0"]), len(keys))
    if k0 == 0 or k0 >= len(keys):
        continue
    seg = keys[k0 - 1 :]
    seg = [k for k in seg if k["at"] <= p["t0"] + 1200]
    fs = analyse(key, seg, "pair", p["t0"])
    worst = max([f for f in fs if not f["masked"]], key=lambda f: f["score"], default=None)
    first = compare(keys[k0 - 1], keys[k0]) if k0 < len(keys) else None
    pair_scores.append({"pair": key, "worst": worst, "first": first, "fromFrame": keys[k0 - 1]["frame"], "toFrame": keys[k0]["frame"], "path": [k["frame"] for k in seg[:14]]})
    findings.extend(fs)


# ------------------------------------------------------------ strips
def strip(keys, title, path, limit=28, t0=0):
    keys = keys[:limit]
    k = 2
    tw, th = (FW + 2 * PAD) * k // 2 + 10, (FH + 2 * PAD) * k // 2 + 10
    W = max(1, len(keys)) * (tw + 4) + 4
    out = Image.new("RGB", (W, th + 64), (21, 19, 31))
    d = ImageDraw.Draw(out)
    d.text((4, 2), title, fill=(255, 255, 255), font=FONT)
    prev = None
    for j, key in enumerate(keys):
        a, _ = cell(key["frame"])
        img = Image.fromarray(a)
        if FR[key["frame"]]["mirrorable"] and key.get("flip"):
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
        tile = Image.new("RGBA", (FW + 2 * PAD, FH + 2 * PAD), (36, 32, 58, 255))
        ox = PAD + int(round(key.get("dx", 0) / S))
        oy = PAD + int(round(key.get("dy", 0) / S))
        tile.alpha_composite(img, (max(0, min(2 * PAD, ox)), max(0, min(2 * PAD, oy))))
        td = ImageDraw.Draw(tile)
        td.line([(0, PAD + FH), (FW + 2 * PAD, PAD + FH)], fill=(80, 255, 120))
        td.line([(PAD + FW // 2, 0), (PAD + FW // 2, 6)], fill=(80, 255, 120))
        tile = tile.resize(((FW + 2 * PAD) * k // 2, (FH + 2 * PAD) * k // 2), Image.NEAREST)
        x0 = 4 + j * (tw + 4)
        out.paste(tile.convert("RGB"), (x0, 16))
        nxt = keys[j + 1]["at"] if j + 1 < len(keys) else None
        dur = f"{nxt - key['at']}ms" if nxt is not None else ""
        col = (255, 220, 120)
        if prev is not None and drawn_change(prev, key):
            sc, _ = judge(prev, key)
            if sc >= 2:
                col = (255, 90, 90) if not (masked(prev) or masked(key)) else (200, 120, 255)
        d.text((x0, th + 18), key["frame"][:16], fill=col, font=FONT)
        d.text((x0, th + 30), f"{key['at'] - t0}ms {dur}", fill=(200, 200, 200), font=FONT)
        extra = []
        if key.get("glitch"):
            extra.append(f"g{key['glitch']:.2f}")
        if key.get("flip"):
            extra.append("flip")
        if key.get("dissolve"):
            extra.append(f"dis{key['dissolve']:.1f}")
        d.text((x0, th + 42), (key["anim"][:10] + " " + " ".join(extra))[:20], fill=(160, 160, 200), font=FONT)
        prev = key
    out.save(path)


def gif(keys, path):
    frames, durs = [], []
    for j, key in enumerate(keys[:120]):
        a, _ = cell(key["frame"])
        img = Image.fromarray(a)
        if FR[key["frame"]]["mirrorable"] and key.get("flip"):
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
        tile = Image.new("RGBA", (FW + 2 * PAD, FH + 2 * PAD), (36, 32, 58, 255))
        ox = PAD + int(round(key.get("dx", 0) / S))
        oy = PAD + int(round(key.get("dy", 0) / S))
        tile.alpha_composite(img, (max(0, min(2 * PAD, ox)), max(0, min(2 * PAD, oy))))
        ImageDraw.Draw(tile).line([(0, PAD + FH), (FW + 2 * PAD, PAD + FH)], fill=(80, 255, 120))
        frames.append(tile.resize(((FW + 2 * PAD) * 2, (FH + 2 * PAD) * 2), Image.NEAREST).convert("P", palette=Image.ADAPTIVE, colors=96))
        nxt = keys[j + 1]["at"] if j + 1 < len(keys) else key["at"] + 400
        durs.append(max(20, nxt - key["at"]))
    if frames:
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=durs, loop=0)


for key, keys in data["solo"].items():
    if key.endswith("#1"):
        name = key[:-2]
        strip(keys, f"{name} (seed 1)", V / "anims" / f"{name}.png", limit=32)
        gif(keys, V / "anims" / f"{name}.gif")

pair_scores.sort(key=lambda p: -(p["worst"]["score"] if p["worst"] else 0))
for p in pair_scores[:60]:
    if not p["worst"]:
        break
    keys = data["pairs"][p["pair"]]["keys"]
    t0 = data["pairs"][p["pair"]]["t0"]
    strip(keys[:20], f"{p['pair']}  worst: {p['worst']['from']} -> {p['worst']['to']}  {'; '.join(p['worst']['why'][:-1])}", V / "pairs" / f"{p['pair'].replace('>', '-')}.png", limit=20, t0=t0)

# ------------------------------------------------------------ report
lines = []
lines.append("== per animation (3 seeds) ==")
for name, rows in per_anim.items():
    fl = sorted({x for r in rows for x in r["flicker"]})[:6]
    hold = max(r["longest_hold"] for r in rows)
    flips = sorted({x for r in rows for x in r["flip_ignored"]})
    pops = sum(r["pops"] for r in rows)
    lines.append(f"{name:14s} keys {[r['keys'] for r in rows]} pops {pops} longest-hold {hold[0]}ms {hold[1]} flicker {fl} flip-ignored {flips}")
lines.append("\n== solo pops (unmasked, score>=3) ==")
agg = defaultdict(list)
for f in findings:
    if f["kind"] == "solo" and not f["masked"] and f["score"] >= 3:
        agg[(f["where"].split("#")[0], f["from"].split(":")[1], f["to"].split(":")[1])].append(f)
for (n, a, b), fs in sorted(agg.items(), key=lambda x: -x[1][0]["score"]):
    lines.append(f"{n:12s} {a} -> {b}  x{len(fs)}  score {fs[0]['score']}  {'; '.join(fs[0]['why'])}")
lines.append("\n== switches A>B: unmasked pops (score>=3), grouped by the drawn frames ==")
agg2 = defaultdict(list)
for f in findings:
    if f["kind"] == "pair" and not f["masked"] and f["score"] >= 3:
        agg2[(f["from"].split(":")[1], f["to"].split(":")[1])].append(f["where"])
for (a, b), ws in sorted(agg2.items(), key=lambda x: -len(x[1])):
    lines.append(f"{a} -> {b}: {len(ws)} pairs, e.g. {', '.join(ws[:6])}")
(V / "anims.txt").write_text("\n".join(lines))
json.dump({"findings": findings, "pairs": pair_scores[:200]}, open(V / "anim-findings.json", "w"), indent=0)
print(len(findings), "findings;", len(agg), "solo pop kinds;", len(agg2), "switch pop kinds")

# One representative strip per kind of switch pop (the drawn frames a -> b), most frequent first.
(V / "switch").mkdir(exist_ok=True)
for n, ((a, b), ws) in enumerate(sorted(agg2.items(), key=lambda x: -len(x[1]))[:45]):
    pk = ws[0]
    keys = data["pairs"][pk]["keys"]
    t0 = data["pairs"][pk]["t0"]
    strip(keys[:20], f"{pk}: {a} -> {b} ({len(ws)} pairs)", V / "switch" / f"{n:02d}-{a}-{b}.png", limit=20, t0=t0)
# Solo pop kinds.
for n, ((nm, a, b), fs) in enumerate(agg.items()):
    keys = data["solo"][fs[0]["where"]]
    i = fs[0]["i"]
    strip(keys[max(0, i - 6) : i + 8], f"{nm}: {a} -> {b}", V / "switch" / f"solo-{nm}-{a}-{b}.png", limit=14, t0=0)
