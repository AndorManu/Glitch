"""Turn a folder of screenshots (f0000.png ...) into a GIF, optionally cropped.

    python dev/frames-to-gif.py <dir> <out.gif> [x y w h] [--scale 0.5] [--fps 6]
"""
import sys
from pathlib import Path

from PIL import Image

args = [a for a in sys.argv[1:]]
scale, fps = 0.5, 6.0
if "--scale" in args:
    i = args.index("--scale"); scale = float(args[i + 1]); del args[i : i + 2]
if "--fps" in args:
    i = args.index("--fps"); fps = float(args[i + 1]); del args[i : i + 2]
src, out = Path(args[0]), Path(args[1])
box = tuple(int(v) for v in args[2:6]) if len(args) >= 6 else None
frames = []
for f in sorted(src.glob("f*.png")):
    im = Image.open(f).convert("RGB")
    if box:
        im = im.crop((box[0], box[1], box[0] + box[2], box[1] + box[3]))
    if scale != 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    frames.append(im)
frames[0].save(out, save_all=True, append_images=frames[1:], duration=int(1000 / fps), loop=0, optimize=True)
print(f"{len(frames)} frames -> {out}")
