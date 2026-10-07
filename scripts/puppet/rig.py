"""A cutout rig over one recovered pose: the pose split into layers (by
polygons, front-most first), hidden areas filled so parts can move, and a
renderer that composes the layers with per-layer offsets and RotSprite
rotations about each layer's pivot.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import pixels as px


@dataclass
class Layer:
    name: str
    img: np.ndarray
    pivot: tuple[float, float]
    z: int


@dataclass
class Xf:
    """A layer transform: offset (art px), rotation (deg, + = counter-clockwise) about the pivot, optional replacement image."""

    dx: int = 0
    dy: int = 0
    rot: float = 0.0
    img: np.ndarray | None = None
    hide: bool = False


@dataclass
class Rig:
    name: str
    base: np.ndarray
    layers: dict[str, Layer] = field(default_factory=dict)
    labels: np.ndarray | None = None
    #: The feet point in pose px (bottom centre between the feet).
    feet: tuple[int, int] = (0, 0)

    def render(self, xf: dict[str, Xf], extras: list[tuple[int, np.ndarray, int, int]] = (), pad: int = 0) -> np.ndarray:
        """Compose all layers (by z) plus `extras` [(z, img, dx, dy)] onto a
        canvas the size of the base pose grown by `pad` on every side."""
        h, w = self.base.shape[:2]
        out = px.blank(w + 2 * pad, h + 2 * pad)
        items = []
        for n, L in self.layers.items():
            t = xf.get(n, Xf())
            if t.hide:
                continue
            img = t.img if t.img is not None else L.img
            img = np.pad(img, ((pad, pad), (pad, pad), (0, 0)))
            if t.rot:
                img = px.rotsprite(img, t.rot, L.pivot[0] + pad, L.pivot[1] + pad)
            items.append((L.z, img, t.dx, t.dy))
        for z, img, dx, dy in extras:
            items.append((z, np.pad(img, ((pad, pad), (pad, pad), (0, 0))), dx, dy))
        for _, img, dx, dy in sorted(items, key=lambda it: it[0]):
            px.over(out, img, dx, dy)
        return out


def cut(name: str, base: np.ndarray, parts: list[tuple[str, list, tuple[float, float], int]], feet) -> Rig:
    """parts: (layer name, polygons, pivot, z) in PRIORITY order: a pixel goes to the
    first part whose polygons contain it. The last part should cover everything left."""
    h, w = base.shape[:2]
    op = px.opaque(base)
    labels = np.full((h, w), -1, int)
    for i, (_, polys, _, _) in enumerate(parts):
        m = px.poly_mask(base.shape, polys) & op & (labels < 0)
        labels[m] = i
    labels[op & (labels < 0)] = len(parts) - 1
    rig = Rig(name, base, labels=labels, feet=feet)
    for i, (n, _, pivot, z) in enumerate(parts):
        rig.layers[n] = Layer(n, px.masked(base, labels == i), pivot, z)
    return rig


def fill_under(rig: Rig, layer: str, polys, steps: int = 40, outline: bool = True, inside: bool = True) -> None:
    """Grow `layer` into the area `polys` (where other parts hide it), then
    re-outline the newly made silhouette edge. `inside`: only within the
    character's original silhouette."""
    L = rig.layers[layer]
    region = px.poly_mask(L.img.shape, polys)
    if inside:
        region &= px.opaque(rig.base)
    filled = px.underfill(L.img, region, steps)
    if outline:
        new = px.opaque(filled) & ~px.opaque(L.img)
        filled = px.reoutline(filled, new | (region & px.opaque(filled)))
    L.img = filled
