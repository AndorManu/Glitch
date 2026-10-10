"""Small previews of generated source sheets: dev/out/src-<name>.png (a third of the size).

    python dev/src-preview.py look_dirs petted ...
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
for n in sys.argv[1:]:
    im = Image.open(ROOT / "art/generated" / f"{n}.png").convert("RGB")
    im.resize((im.width // 3, im.height // 3)).save(ROOT / "dev/out" / f"src-{n}.png")
