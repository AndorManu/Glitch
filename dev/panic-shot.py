"""Grab one small screen region to a PNG (QA of the panic button).

  python dev/panic-shot.py <out.png> <x> <y> <w> <h>

Only the region around Glitch is captured (physical pixels), never the whole
screen.
"""

import ctypes
import sys

from PIL import ImageGrab

ctypes.windll.user32.SetProcessDPIAware()
out, x, y, w, h = sys.argv[1], *map(int, sys.argv[2:6])
ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).save(out)
