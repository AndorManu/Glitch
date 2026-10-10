"""The rigs: which recovered pose each one is cut from, the part polygons,
pivots and the hidden areas to fill. Coordinates are art px in the pose
images art/puppet/src/pose-NN.png (see `python scripts/recover-grid.py`)."""

from __future__ import annotations

from pathlib import Path

from . import pixels as px
from .rig import Rig, cut, fill_under

SRC = Path(__file__).resolve().parents[2] / "art" / "puppet" / "src"


def pose(n: int):
    return px.load(SRC / f"pose-{n:02d}.png")


def front() -> Rig:
    """Pose 0: standing, facing you, tail on the left."""
    base = pose(0)
    rig = cut(
        "front",
        base,
        [
            ("bits", [((65, 18), (69, 32))], (66, 25), 90),
            ("ear_l", [[(18, 0), (37, 0), (37, 9), (34, 12), (31, 17), (25, 21), (18, 21)]], (29, 18), 40),
            ("ear_r", [[(48, 0), (68, 0), (68, 22), (61, 22), (55, 17), (51, 13), (48, 9)]], (56, 17), 40),
            ("head", [[(17, 0), (68, 0), (68, 37), (57, 38), (55, 39), (30, 39), (26, 38), (21, 35), (18, 31), (17, 21)]], (42, 37), 50),
            ("arm_l", [[(27, 39), (36, 39), (35, 43), (35, 50), (27, 50)]], (31, 41), 60),
            ("arm_r", [[(48, 39), (57, 39), (57, 50), (49, 50), (48, 43)]], (52, 41), 60),
            ("foot_l", [((29, 50), (39, 55))], (34, 50), 30),
            ("foot_r", [((44, 50), (54, 55))], (49, 50), 30),
            ("body", [((26, 36), (58, 53))], (42, 50), 20),
            ("tail", [((0, 0), (69, 55))], (25, 46), 10),
        ],
        feet=(42, 55),
    )
    # Hidden areas: body under the head, arms and feet; head under the ear
    # roots; tail under the body.
    fill_under(rig, "body", [((27, 35), (57, 40))])
    fill_under(rig, "body", [[(27, 39), (36, 39), (35, 50), (27, 50)], [(48, 39), (57, 39), (57, 50), (48, 50)]])
    fill_under(rig, "body", [((29, 49), (39, 51)), ((44, 49), (54, 51))])
    fill_under(rig, "head", [[(20, 14), (37, 8), (37, 22), (20, 22)], [(48, 8), (66, 14), (66, 22), (48, 22)]], steps=4)
    fill_under(rig, "tail", [((18, 20), (34, 54))], steps=6, outline=False)
    return rig


def arm_up():
    """The raised paw (pink pads) from pose 10, as a separate piece. Pivot = shoulder."""
    base = pose(10)
    m = px.poly_mask(base.shape, [[(0, 29), (9, 28), (13, 30), (16, 36), (18, 40), (18, 44), (16, 47), (11, 46), (6, 42), (0, 39)]])
    img = px.masked(base, m)
    return img, (15, 43)


def side() -> Rig:
    """Pose 4: walking pose, three-quarter view facing right, glitch eye showing."""
    base = pose(4)
    rig = cut(
        "side",
        base,
        [
            ("bits", [((65, 13), (72, 20))], (67, 16), 90),
            ("ear_n", [[(26, 0), (45, 0), (45, 9), (42, 14), (40, 19), (34, 21), (26, 20)]], (37, 19), 40),
            ("ear_f", [[(50, 0), (64, 0), (64, 12), (60, 13), (54, 13), (50, 11)]], (57, 12), 35),
            ("head", [[(25, 0), (72, 0), (72, 36), (62, 39), (39, 39), (33, 36), (29, 30), (26, 18)]], (50, 38), 50),
            ("arm", [[(35, 40), (45, 40), (44, 47), (39, 48), (35, 46)]], (40, 41), 60),
            ("foot_b", [((31, 49), (42, 54))], (36, 50), 30),
            ("foot_f", [((50, 46), (61, 54))], (56, 47), 30),
            ("body", [((28, 34), (64, 54))], (48, 50), 20),
            ("tail", [((0, 0), (72, 54))], (31, 44), 10),
        ],
        feet=(47, 54),
    )
    fill_under(rig, "body", [((31, 35), (63, 40))])
    fill_under(rig, "body", [[(35, 40), (45, 40), (44, 47), (39, 48), (35, 46)]])
    fill_under(rig, "body", [((31, 48), (42, 50)), ((50, 45), (61, 49))])
    fill_under(rig, "head", [[(27, 12), (45, 6), (45, 22), (27, 22)], [(50, 8), (64, 8), (64, 15), (50, 15)]], steps=4)
    fill_under(rig, "tail", [((24, 16), (40, 54))], steps=6, outline=False)
    return rig


RIGS = {"front": front, "side": side}
