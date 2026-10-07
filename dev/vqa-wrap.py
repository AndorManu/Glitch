"""Wrap a long strip PNG into rows (for viewing): python dev/vqa-wrap.py in.png [out.png] [--w=1960]"""
import sys
from PIL import Image
args = [a for a in sys.argv[1:] if not a.startswith("--")]
w = int(next((a[4:] for a in sys.argv if a.startswith("--w=")), 1960))
im = Image.open(args[0])
# cut on tile borders: find columns that are background-coloured separators
rows = (im.width + w - 1) // w
out = Image.new("RGB", (min(w, im.width), rows * im.height), (0, 0, 0))
for r in range(rows):
    out.paste(im.crop((r * w, 0, min(im.width, (r + 1) * w), im.height)), (0, r * im.height))
out.save(args[1] if len(args) > 1 else args[0].replace(".png", "-wrap.png"))
