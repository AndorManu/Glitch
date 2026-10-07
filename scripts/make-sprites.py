"""Build Glitch's sprite sheet and app-icon source from the character art.

    python3 scripts/make-sprites.py            # needs: pip install pillow numpy
    npx tauri icon src-tauri/icons/source.png  # regenerate all app/tray icons

Input:  art/glitch-raccoon-source.webp - 16 poses in a rough 4x4 layout on a
        transparent background (not an exact grid, so poses are found by the
        empty gaps between them).
Output: public/sprites/glitch.png      - 4x4 sheet, every frame the same size,
                                         feet on a common baseline
        src-tauri/icons/source.png     - 1024x1024 icon from the front pose

Pose order (left-to-right, top-to-bottom) must match FRAMES in
src/sprites/raccoon.ts.
"""

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "art" / "glitch-raccoon-source.webp"
SHEET = ROOT / "public" / "sprites" / "glitch.png"
ICON = ROOT / "src-tauri" / "icons" / "source.png"

FRAME_W = 276  # 2x the on-screen size (138x90 logical) for sharp high-DPI displays
ALPHA_MIN = 40  # anything fainter is treated as background


def gaps(projection, min_len=3):
    out, start = [], None
    for i, v in enumerate(projection):
        if v == 0 and start is None:
            start = i
        elif v != 0 and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(projection)))
    return out


def find_poses(img):
    mask = np.array(img)[:, :, 3] > ALPHA_MIN
    h, w = mask.shape
    # Column boundaries: middle of the widest empty vertical band near each quarter.
    col_gaps = gaps(mask.sum(0))
    xs = [0]
    for q in (1, 2, 3):
        target = w * q / 4
        g = min(col_gaps, key=lambda g: abs((g[0] + g[1]) / 2 - target))
        xs.append((g[0] + g[1]) // 2)
    xs.append(w)
    poses = []
    for c in range(4):
        band = mask[:, xs[c] : xs[c + 1]]
        row_gaps = gaps(band.sum(1))
        ys = [0]
        for q in (1, 2, 3):
            target = h * q / 4
            near = [g for g in row_gaps if abs((g[0] + g[1]) / 2 - target) < h / 8]
            g = max(near, key=lambda g: g[1] - g[0])
            ys.append((g[0] + g[1]) // 2)
        ys.append(h)
        for r in range(4):
            cell = img.crop((xs[c], ys[r], xs[c + 1], ys[r + 1]))
            bbox = cell.getchannel("A").point(lambda v: 255 if v > ALPHA_MIN else 0).getbbox()
            poses.append((r * 4 + c, cell.crop(bbox)))
    return [p for _, p in sorted(poses, key=lambda p: p[0])]


def main():
    img = Image.open(SRC).convert("RGBA")
    poses = find_poses(img)
    cw = max(p.width for p in poses)
    ch = max(p.height for p in poses)
    scale = FRAME_W / cw
    fw, fh = FRAME_W, round(ch * scale)

    sheet = Image.new("RGBA", (fw * 4, fh * 4), (0, 0, 0, 0))
    for i, pose in enumerate(poses):
        # Same canvas for every pose, centred, feet on the bottom edge, so
        # Glitch doesn't jump around when the animation changes.
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        canvas.alpha_composite(pose, ((cw - pose.width) // 2, ch - pose.height))
        frame = canvas.resize((fw, fh), Image.Resampling.LANCZOS)
        sheet.alpha_composite(frame, ((i % 4) * fw, (i // 4) * fh))
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET, optimize=True)
    print(f"wrote {SHEET.relative_to(ROOT)}: 16 frames of {fw}x{fh}")

    front = poses[0]
    side = max(front.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(front, ((side - front.width) // 2, (side - front.height) // 2))
    icon = square.resize((920, 920), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    out.alpha_composite(icon, (52, 52))
    out.save(ICON)
    print(f"wrote {ICON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
