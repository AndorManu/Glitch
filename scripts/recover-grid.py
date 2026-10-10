"""Recover the pixel grid of Glitch's character art.

    python scripts/recover-grid.py            # needs: pip install pillow numpy

The source art (art/glitch-raccoon-source.webp) is upscaled pixel art: big
blocks of ~8 source px, with finer details (mouth lines, the glitch-eye ring,
highlights) drawn at half a block, and every pose drawn at a slightly
different scale. For every pose this script:

1. finds the block pitch (~8 px) and phase that line block edges up best,
2. samples the art at HALF that pitch (the finest detail the art has), so
   every pose comes out at the same art-pixel scale whatever its source size,
3. quantises all poses to one shared palette (k-means, 28 colours) and makes
   alpha binary,
4. writes art/puppet/src/pose-NN.png (1 px per art pixel), text grids
   art/puppet/src/pose-NN.txt for reading coordinates, the palette, and a
   zoomed preview dev/out/grids-preview.png.

scripts/make-puppet.py cuts these into layers and bakes the animation frames.
"""

from pathlib import Path
import importlib.util

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "art" / "puppet" / "src"
OUT_PREVIEW = ROOT / "dev" / "out" / "grids-preview.png"
ALPHA_MIN = 110
# The big block is ~8 source px; a looser search finds coarser grids that
# score well on edges but are wrong.
PITCH_MIN, PITCH_MAX = 7.6, 8.4
DIV = 2
K = 28
CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"


def load_poses():
    spec = importlib.util.spec_from_file_location("ms", ROOT / "scripts" / "make-sprites.py")
    ms = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ms)
    img = Image.open(ms.SRC).convert("RGBA")
    return ms.find_poses(img)


def edge_profile(a, axis):
    """Sum of colour change between neighbouring pixels along `axis`."""
    rgb = a[:, :, :3].astype(float)
    alpha = a[:, :, 3].astype(float)
    d = np.abs(np.diff(rgb, axis=axis)).sum(2) + np.abs(np.diff(alpha, axis=axis))
    return d.sum(axis=1 - axis) if axis == 1 else d.sum(axis=1)


def phase_score(profile, n, pitch):
    best = None
    for phase in np.arange(0, pitch, 0.25):
        idx = np.round(np.arange(phase, n - 1, pitch)).astype(int)
        idx = idx[(idx >= 0) & (idx < len(profile))]
        score = profile[idx].mean() / (profile.mean() + 1e-9)
        if best is None or score > best[0]:
            best = (score, phase)
    return best


def best_square_grid(a):
    """One pitch for both axes (the art pixels are square), best phase per axis."""
    px_prof, py_prof = edge_profile(a, 1), edge_profile(a, 0)
    best = None
    for pitch in np.arange(PITCH_MIN, PITCH_MAX + 0.001, 0.05):
        sx, ox = phase_score(px_prof, a.shape[1], pitch)
        sy, oy = phase_score(py_prof, a.shape[0], pitch)
        if best is None or sx + sy > best[0]:
            best = (sx + sy, pitch, ox, oy)
    return best[1:]


def sample(a, p, ox, oy):
    """Median colour of the middle of every p x p cell starting at (ox, oy)."""
    h, w = a.shape[:2]
    cols = int((w - ox) // p)
    rows = int((h - oy) // p)
    out = np.zeros((rows, cols, 4))
    for r in range(rows):
        for c in range(cols):
            x0 = ox + c * p
            y0 = oy + r * p
            xa = int(round(x0 + p * 0.25))
            ya = int(round(y0 + p * 0.25))
            xs = slice(xa, max(xa + 1, int(round(x0 + p * 0.75))))
            ys = slice(ya, max(ya + 1, int(round(y0 + p * 0.75))))
            out[r, c] = np.median(a[ys, xs].reshape(-1, 4), axis=0)
    return out


def kmeans(points, k, iters=40, seed=1):
    rng = np.random.default_rng(seed)
    centers = [points[rng.integers(len(points))]]
    for _ in range(1, k):
        d = np.min([((points - c) ** 2).sum(1) for c in centers], axis=0)
        centers.append(points[rng.choice(len(points), p=d / d.sum())])
    centers = np.array(centers, float)
    for _ in range(iters):
        lab = np.argmin(((points[:, None] - centers[None]) ** 2).sum(2), axis=1)
        for i in range(k):
            if (lab == i).any():
                centers[i] = points[lab == i].mean(0)
    return centers


def main():
    poses = load_poses()
    sampled = []
    for i, pose in enumerate(poses):
        a = np.array(pose).astype(float)
        a = np.pad(a, ((12, 12), (12, 12), (0, 0)))
        pitch, ox, oy = best_square_grid(a)
        p = pitch / DIV
        s = sample(a, p, ox % p, oy % p)
        alive = s[:, :, 3] > ALPHA_MIN
        rs, cs = np.where(alive.any(1))[0], np.where(alive.any(0))[0]
        s = s[rs[0] : rs[-1] + 1, cs[0] : cs[-1] + 1]
        sampled.append(s)
        print(f"pose {i:2d}: block {pitch:.2f} px -> {s.shape[1]}x{s.shape[0]} art px")

    pts = np.concatenate([s[s[:, :, 3] > ALPHA_MIN][:, :3] for s in sampled])
    centers = kmeans(pts, K)
    centers = centers[np.argsort(centers.sum(1))]
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "palette.txt", "w") as f:
        for ch, c in zip(CHARS, centers):
            f.write(f"{ch} #{int(c[0]):02x}{int(c[1]):02x}{int(c[2]):02x}\n")

    previews = []
    for i, s in enumerate(sampled):
        img = Image.new("RGBA", (s.shape[1], s.shape[0]), (0, 0, 0, 0))
        rows = []
        for r in range(s.shape[0]):
            line = ""
            for c in range(s.shape[1]):
                if s[r, c, 3] <= ALPHA_MIN:
                    line += "."
                    continue
                j = int(np.argmin(((centers - s[r, c, :3]) ** 2).sum(1)))
                line += CHARS[j]
                img.putpixel((c, r), tuple(int(v) for v in centers[j]) + (255,))
            rows.append(line)
        (OUT / f"pose-{i:02d}.txt").write_text("\n".join(rows) + "\n")
        img.save(OUT / f"pose-{i:02d}.png")
        previews.append(img)

    cell_w = max(p.width for p in previews) + 2
    cell_h = max(p.height for p in previews) + 2
    sheet = Image.new("RGBA", (cell_w * 4, cell_h * 4), (46, 107, 88, 255))
    for i, p in enumerate(previews):
        sheet.alpha_composite(p, ((i % 4) * cell_w + 1, (i // 4) * cell_h + 1))
    OUT_PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST).save(OUT_PREVIEW)
    print("wrote", OUT, OUT_PREVIEW)


if __name__ == "__main__":
    main()
