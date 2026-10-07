"""Face overlays for the front head (pose 0), painted in the art's own
palette at its own pixel size, matching the eyes/mouths the original poses
already have (closed happy "∩" eyes from the laugh/wave poses, the red open
mouth from the happy pose).

Each overlay is (x, y, rows): rows of chars painted at pose-0 coordinates.
'.' leaves the pixel as it is.
"""

from __future__ import annotations

import numpy as np

from . import pixels as px

# The art palette (art/puppet/src/palette.txt) plus a tongue colour.
PAL = {
    "0": px.hexrgb("#080711"),
    "1": px.hexrgb("#0c0a18"),
    "2": px.hexrgb("#1a1422"),
    "3": px.hexrgb("#282230"),
    "4": px.hexrgb("#37303f"),
    "6": px.hexrgb("#473d48"),
    "7": px.hexrgb("#534751"),
    "a": px.hexrgb("#756262"),
    "c": px.hexrgb("#927871"),
    "i": px.hexrgb("#a5a2a8"),
    "k": px.hexrgb("#dab49e"),
    "n": px.hexrgb("#eec6a9"),
    "o": px.hexrgb("#f8dabb"),
    "p": px.hexrgb("#fbe1c5"),
    "9": px.hexrgb("#c42b23"),
    "T": px.hexrgb("#e8706a"),
    "b": px.hexrgb("#9015ba"),
    "d": px.hexrgb("#9903ec"),
    "e": px.hexrgb("#bf0de8"),
    "g": px.hexrgb("#df10f3"),
    "q": px.hexrgb("#f9b7f7"),
    "r": px.hexrgb("#f2eff2"),
    "B": px.hexrgb("#f08aa8"),  # blush
}


def paint(img: np.ndarray, x: int, y: int, rows) -> np.ndarray:
    out = img.copy()
    for j, r in enumerate(rows):
        for i, ch in enumerate(r):
            if ch == ".":
                continue
            yy, xx = y + j, x + i
            if 0 <= yy < out.shape[0] and 0 <= xx < out.shape[1]:
                if ch == "_":
                    out[yy, xx] = 0
                else:
                    out[yy, xx] = PAL[ch]
    return out


# ------------------------------------------------------------- left eye
# The plain eye: a big dark eye, x 28-38, y 24-33 in pose 0.
EYE_L = {
    "open": None,
    "closed": (28, 25, [
        "poooooooooo",
        "ppppppppppp",
        "ppppppppppp",
        "ppppppppppp",
        "30ppppppp03",
        "p300000003p",
        "pp3000003pp",
        "ppppppppppp",
        "pppcpppppp.",
    ]),
    "happy": (28, 25, [
        "poooooooooo",
        "ppppppppppp",
        "pppp000pppp",
        "pp0000000pp",
        "p300ppp003p",
        "p00ppppp00p",
        "pppppppppp.",
        "ppppppppppp",
        "pppcpppppp.",
    ]),
    "half": (28, 25, [
        "paaaaaaa00a",
        "paaaaaaaaaa",
        "p300000003a",
        "p0000000000",
        "33323001114",
        "p33333311.",
    ]),
    "squeeze": (28, 25, [
        "poooooooooo",
        "p00pppppppp",
        "pp000pppppp",
        "pppp0000ppp",
        "pp000pppppp",
        "p00pppppppp",
        "ppppppppppp",
        "ppppppppppp",
        "pppcpppppp.",
    ]),
    "wide": (30, 26, [
        ".rr.",
        "rrr.",
    ]),
    "look_l": (28, 25, [
        "..11111017",
        "1111111113",
        "rr22300111",
        "rr323001114",
    ]),
    "dizzy": (28, 25, [
        "poooooooooo",
        "pp0000000pp",
        "p00ppppp00p",
        "p0pp000pp0p",
        "p0p0ppp0p0p",
        "p0p00p00p0p",
        "p00ppp00pp.",
        "pp00000pppp",
        "pppcpppppp.",
    ]),
}

# ------------------------------------------------------------ glitch eye
# The magenta square, ring x 48-53, y 26-31, in a black mask x 46-55.
EYE_G = {
    "open": None,
    "closed": (47, 25, [
        "11111111",
        "11111111",
        "11111111",
        "11111111",
        "1gggggg1",
        "1eggggge",
        "11111111",
    ]),
    "happy": (47, 25, [
        "11111111",
        "11eggg11",
        "1egggge1",
        "1gg11gg1",
        "1g1111g1",
        "11111111",
        "11111111",
    ]),
    "half": (47, 25, [
        "11111111",
        "11111111",
        "1eggggg1",
        ".gqbdrg.",
    ]),
    "squeeze": (47, 25, [
        "1111111g",
        "11111gg1",
        "111gg111",
        "1gg11111",
        "111gg111",
        "11111gg1",
        "1111111g",
    ]),
    "wide": (49, 27, [
        "rrrr",
        "rrrr",
        "rrrr",
        "rrrr",
    ]),
    "dizzy": (47, 25, [
        "1gggggg1",
        "1g1111g1",
        "1g1gg1g1",
        "1g1g11g1",
        "1g1ggggg",
        "1g111111",
        "1gggggg1",
    ]),
}

# ----------------------------------------------------------------- mouth
# Under the nose (nose x 41-43, y 31-32); rows 34-37, x 38-46.
MOUTH = {
    "neutral": None,
    "smile": (38, 33, [
        "ppppppppp",
        "pp0ppp0pp",
        "ppp000ppp",
        "ppppppppp",
    ]),
    "small": (38, 33, [
        "ppppppppp",
        "ppp000ppp",
        "pp09990pp",
        "ppp000ppp",
    ]),
    "open": (38, 33, [
        "ppppppppp",
        "pp00000pp",
        "p0999990p",
        "p099T990p",
        "pp0TTT0pp",
    ]),
    "o": (38, 33, [
        "ppppppppp",
        "ppp000ppp",
        "pp09990pp",
        "pp09990pp",
        "ppp000ppp",
    ]),
    "e": (38, 33, [
        "ppppppppp",
        "p0000000p",
        "p0999990p",
        "pp00000pp",
    ]),
    "laugh": (37, 33, [
        "ppppppppppp",
        "p000000000p",
        "p099999990p",
        "p09999TT90p",
        "pp0TTTTT0pp",
        "ppp00000ppp",
    ]),
    "frown": (38, 33, [
        "ppppppppp",
        "pppp0pppp",
        "ppp0p0ppp",
        "pp0ppp0pp",
    ]),
    "wavy": (38, 33, [
        "ppppppppp",
        "ppppppppp",
        "p0p000p0p",
        "pp0ppp0pp",
    ]),
    "grit": (38, 33, [
        "ppppppppp",
        "p0000000p",
        "p0rrrrr0p",
        "p0000000p",
    ]),
    "yawn": (38, 33, [
        "pp00000pp",
        "p0999990p",
        "p0999990p",
        "p09TTT90p",
        "pp00000pp",
    ]),
    "blep": (38, 33, [
        "ppppppppp",
        "pp0ppp0pp",
        "ppp000ppp",
        "pppTTpppp",
    ]),
    "smirk": (38, 33, [
        "ppppppppp",
        "ppppppp0p",
        "pp00000pp",
        "ppppppppp",
    ]),
}

BLUSH = [(26, 34, ["BB", "BB"]), (56, 34, ["BB", "BB"])]


def face(head: np.ndarray, eyes: str = "open", mouth: str = "neutral", glitch: str | None = None, blush: bool = False) -> np.ndarray:
    """The pose-0 head layer with an expression painted on (only over its own pixels)."""
    out = head
    op = px.opaque(head)
    for table, key in ((EYE_L, eyes), (EYE_G, glitch or eyes), (MOUTH, mouth)):
        ov = table.get(key)
        if ov:
            out = paint(out, *ov)
    if blush:
        for b in BLUSH:
            out = paint(out, *b)
    out[~op] = 0
    return out
