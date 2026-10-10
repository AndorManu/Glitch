"""Pose specs for the rigs and the code that turns one into a frame.

A frame is the rig's layers moved/rotated per the spec, placed on a fixed
canvas (CANVAS_W x CANVAS_H art px) with the feet at the bottom centre.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

from . import faces
from . import pixels as px
from .rig import Xf
from .rigs import arm_up, front, side

CANVAS_W, CANVAS_H = 100, 76
PAD = 24


@lru_cache(maxsize=None)
def rigs():
    return {"front": front(), "side": side(), "arm_up": arm_up()}


def place(img: np.ndarray, feet: tuple[int, int]) -> tuple[np.ndarray, int, int]:
    """Put a PAD-padded rig render on the canvas with the feet at the bottom centre."""
    out = px.blank(CANVAS_W, CANVAS_H)
    ox = CANVAS_W // 2 - feet[0] - PAD
    oy = CANVAS_H - 1 - feet[1] - PAD
    px.over(out, img, ox, oy)
    return out, ox + PAD, oy + PAD


# ------------------------------------------------------------------ front

@dataclass
class Arm:
    kind: str = "down"  # "down": the arm as drawn, swung by `rot`; "up": the raised paw
    rot: float = 0.0
    dx: int = 0
    dy: int = 0


@dataclass
class Front:
    eyes: str = "open"
    glitch: str | None = None
    mouth: str = "neutral"
    blush: bool = False
    head: tuple[int, int] = (0, 0)
    head_rot: float = 0.0
    ear_l: float = 0.0
    ear_r: float = 0.0
    arm_l: Arm = field(default_factory=Arm)
    arm_r: Arm = field(default_factory=Arm)
    foot_l: tuple[int, int] = (0, 0)
    foot_r: tuple[int, int] = (0, 0)
    tail: float = 0.0
    #: Body rows added (+, breathing in / stretching) or removed (-, squashing).
    breath: int = 0
    #: Columns added to the body's width (squash).
    widen: int = 0
    #: Whole-body offset (art px).
    shift: tuple[int, int] = (0, 0)


BELLY_ROW = 46


def render_front(p: Front) -> tuple[np.ndarray, tuple[int, int]]:
    R = rigs()["front"]
    L = R.layers
    up = -p.breath
    body = px.stretch_rows(L["body"].img, BELLY_ROW, p.breath)
    if p.widen:
        body = px.stretch_cols(body, 42, p.widen)
    hx, hy = p.head[0], p.head[1] + up
    head = faces.face(L["head"].img, p.eyes, p.mouth, p.glitch, p.blush)
    xf = {
        "body": Xf(img=body),
        "head": Xf(dx=hx, dy=hy, rot=p.head_rot, img=head),
        "ear_l": Xf(dx=hx, dy=hy, rot=p.ear_l + p.head_rot),
        "ear_r": Xf(dx=hx, dy=hy, rot=p.ear_r + p.head_rot),
        "bits": Xf(dx=hx, dy=hy),
        "foot_l": Xf(dx=p.foot_l[0], dy=p.foot_l[1]),
        "foot_r": Xf(dx=p.foot_r[0], dy=p.foot_r[1]),
        "tail": Xf(rot=p.tail),
    }
    extras = []
    aimg, (apx, apy) = rigs()["arm_up"]
    for side_, arm, shoulder in (("arm_l", p.arm_l, (31, 41)), ("arm_r", p.arm_r, (52, 41))):
        if arm.kind == "down":
            xf[side_] = Xf(dx=arm.dx, dy=arm.dy + up, rot=arm.rot)
        else:
            xf[side_] = Xf(hide=True)
            img, pvx = (aimg, apx) if side_ == "arm_l" else (aimg[:, ::-1].copy(), aimg.shape[1] - 1 - apx)
            q = 16
            img = np.pad(img, ((q, q), (q, q), (0, 0)))
            img = px.rotsprite(img, arm.rot if side_ == "arm_l" else -arm.rot, pvx + q, apy + q)
            extras.append((70, img, shoulder[0] - pvx - q + arm.dx, shoulder[1] - apy - q + arm.dy + up))
    img = R.render(xf, extras, pad=PAD)
    img = px.shift(img, p.shift[0], p.shift[1])
    canvas, ox, oy = place(img, R.feet)
    eye = (51 + hx + ox + p.shift[0], 29 + hy + oy + p.shift[1])
    return canvas, eye


# ------------------------------------------------------------------- side

@dataclass
class Side:
    eyes: str = "open"
    mouth: str = "neutral"
    head: tuple[int, int] = (0, 0)
    head_rot: float = 0.0
    ear_n: float = 0.0
    ear_f: float = 0.0
    arm: float = 0.0
    arm_d: tuple[int, int] = (0, 0)
    foot_b: tuple[int, int] = (0, 0)
    foot_f: tuple[int, int] = (0, 0)
    tail: float = 0.0
    #: Body (and everything on it) up/down, art px; feet stay.
    bob: int = 0
    breath: int = 0
    shift: tuple[int, int] = (0, 0)


def render_side(p: Side) -> tuple[np.ndarray, tuple[int, int]]:
    R = rigs()["side"]
    L = R.layers
    up = -p.breath + p.bob
    body = px.stretch_rows(L["body"].img, 45, p.breath) if p.breath else L["body"].img
    hx, hy = p.head[0], p.head[1] + up
    xf = {
        "body": Xf(img=body, dy=p.bob),
        "head": Xf(dx=hx, dy=hy, rot=p.head_rot),
        "ear_n": Xf(dx=hx, dy=hy, rot=p.ear_n + p.head_rot),
        "ear_f": Xf(dx=hx, dy=hy, rot=p.ear_f + p.head_rot),
        "bits": Xf(dx=hx, dy=hy),
        "arm": Xf(dx=p.arm_d[0], dy=p.arm_d[1] + up, rot=p.arm),
        "foot_b": Xf(dx=p.foot_b[0], dy=p.foot_b[1]),
        "foot_f": Xf(dx=p.foot_f[0], dy=p.foot_f[1]),
        "tail": Xf(rot=p.tail, dy=p.bob),
    }
    img = R.render(xf, pad=PAD)
    img = px.shift(img, p.shift[0], p.shift[1])
    canvas, ox, oy = place(img, R.feet)
    eye = (63 + hx + ox + p.shift[0], 25 + hy + oy + p.shift[1])
    return canvas, eye


def render(spec) -> tuple[np.ndarray, tuple[int, int]]:
    if isinstance(spec, Front):
        return render_front(spec)
    if isinstance(spec, Side):
        return render_side(spec)
    raise TypeError(spec)
