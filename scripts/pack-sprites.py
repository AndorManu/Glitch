"""Pack Glitch's animation frames into one sprite sheet for the app.

    python scripts/recover-grid.py      # original 16 poses -> art/puppet/src
    python scripts/slice-generated.py   # generated sheets  -> art/frames
    python scripts/pack-sprites.py      # -> public/sprites/glitch-anim.png + src/sprites/anim.ts

Every frame is CANVAS_W x CANVAS_H art px (feet on the bottom row, body
centred) and drawn by the app at a whole art-pixel grid (no smoothing).
The original 16 poses are included at the same scale under their old names
(idle0, walk0, sleep0...), so everything that used the old sheet still works.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("sg", ROOT / "scripts" / "slice-generated.py")
sg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sg)
# Per-frame art fixes from the visual QA (scripts/frame-fixes.py).
_fx_spec = importlib.util.spec_from_file_location("frame_fixes", Path(__file__).with_name("frame-fixes.py"))
fx = importlib.util.module_from_spec(_fx_spec)
_fx_spec.loader.exec_module(fx)

FRAMES = ROOT / "art" / "frames"
POSES = ROOT / "art" / "puppet" / "src"
SHEET = ROOT / "public" / "sprites" / "glitch-anim.png"
INDEX = ROOT / "src" / "sprites" / "anim.ts"
COLS = 16

#: The original sheet's poses (index in the 4x4 sheet) -> their frame name here.
LEGACY = {
    "pose_front": 0,
    "pose_side": 1,
    "pose_back": 2,
    "pose_front_alt": 3,
    "pose_walk0": 4,
    "pose_walk1": 5,
    "pose_wave": 6,
    "pose_glitch": 7,
    "pose_sit": 8,
    "pose_sleep": 9,
    "pose_happy": 10,
    "pose_laugh": 11,
    "pose_notify": 12,
    "pose_push": 13,
    "pose_think": 14,
    "pose_chaos": 15,
}


def drop_ground_lines(a: np.ndarray) -> np.ndarray:
    """The original art draws a thin shadow line under some poses: drop
    opaque rows at the bottom that are separated from the body by a gap."""
    op = a[:, :, 3] > 0
    rows = np.where(op.any(1))[0]
    if len(rows) < 3:
        return a
    out = a.copy()
    # Walk up from the bottom: a run of <= 2 rows followed by an empty row is a ground line.
    y = rows.max()
    run = 0
    while y >= 0 and op[y].any():
        run += 1
        y -= 1
    if run <= 2 and y >= 0 and not op[y].any():
        out[y + 1 :] = 0
    return out


def legacy_frame(i: int) -> np.ndarray:
    a = np.array(Image.open(POSES / f"pose-{i:02d}.png").convert("RGBA"))
    a[:, :, 3] = np.where(a[:, :, 3] > 127, 255, 0)
    a = sg.trim(drop_ground_lines(a))
    return sg.place(a, sg.body_x(a, "left"))


#: Frames with no glitch eye to glitch: seen from behind, or (pose_laugh) only loose sparks.
EYELESS = {"turn_to_back3", "turn_to_back4", "turn_to_back5", "pose_back", "pose_laugh", "happy_spin3"}


def has_eye(a: np.ndarray) -> bool:
    """A drawn magenta eye (its square ring is at least ~8 px), not just a couple of sparks."""
    r, g, b = (a[:, :, i].astype(int) for i in range(3))
    return int(((a[:, :, 3] > 0) & (r > 150) & (b > 180) & (g < 110)).sum()) >= 8


def eye_of(a: np.ndarray) -> tuple[int, int]:
    """Centre of the glitch eye: the densest 5x5 patch of magenta (the eye's
    square ring, not the loose bits around it), else the head's right side."""
    r, g, b = (a[:, :, i].astype(int) for i in range(3))
    m = ((a[:, :, 3] > 0) & (r > 150) & (b > 180) & (g < 110)).astype(int)
    if m.sum() >= 3:
        k = 5
        p = np.pad(m, k)
        c = np.cumsum(np.cumsum(p, 0), 1)
        win = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
        y, x = np.unravel_index(int(np.argmax(win)), win.shape)
        return int(x - k / 2), int(y - k / 2)
    ys, xs = np.where(a[:, :, 3] > 0)
    return int(xs.max() - 8), int(ys.min() + 22)


#: Clips that join other animations: (frame their first frame must line up
#: with, frame their last frame must line up with); ":m" = that frame mirrored.
#: Each clip is shifted sideways so both ends sit exactly on those frames
#: (best silhouette overlap), the frames in between eased from one shift to
#: the other, so nothing jumps at a junction.
STAND = "idle0"
ALIGN = {
    "sit_down": (STAND, "sit0"),
    "stand_up_paws": ("sit0", STAND),
    "stand_up_hop": ("sit0", STAND),
    "stand_up_glitch": ("sit0", STAND),
    "sit_idle_look": ("sit0", "sit0"),
    "turn_front_to_side": (STAND, "walk0"),
    "turn_side_to_front": ("walk0", STAND),
    "turn_around": ("walk0", "walk0:m"),
    "turn_to_back": (STAND, None),
    "stretch": ("walk0", "walk0"),
    "walk_start": (STAND, "walk0"),
    "walk_stop": ("walk7", "walk0"),
    "lie_down": (STAND, "sleep0"),
    "get_up": ("sleep0", STAND),
    "wake": ("sleep0", STAND),
    **{s: (STAND, STAND) for s in ["scratch", "groom", "shake_off", "hop_idle", "look_back", "tail_chase", "sneeze"]},
    # Round 4: the living idle loops and the fun fidgets.
    # (idle_tail* / idle_tail_sit*: drawn on idle0..6 / sit0..1 themselves, nothing to align.)
    **{s: (STAND, STAND) for s in ["dance_beat", "celebrate_focus", "sweat_fan", "worried_battery", "hold_sign", "knock_screen", "streamer", "chubby_idle", "hats"]},
    **{s: ("sit0", "sit0") for s in ["glasses_type", "watch_tv"]},
    "fetch_ball": ("walk0", None),
    "look_dirs": (STAND, None),  # a set of held gazes, not a sequence: one shift for all
    **{s: (STAND, STAND) for s in ["petted", "high_five", "happy_spin", "jump_scare"]},
    **{s: (STAND, None) for s in ["wave", "talk", "think", "laugh", "celebrate", "sad", "angry", "scared", "eat", "dance", "typing", "point", "dizzy", "listen", "surprised"]},
}


def body_mask(a: np.ndarray) -> np.ndarray:
    v = a[:, :, :3].astype(int)
    glitchy = ((v[..., 0] > 120) & (v[..., 2] > 140) & (v[..., 1] < 120)) | ((v[..., 2] > 150) & (v[..., 1] > 150) & (v[..., 0] < 120))
    return (a[:, :, 3] > 0) & ~glitchy


def shift_x(a: np.ndarray, dx: int) -> np.ndarray:
    if dx == 0:
        return a
    out = np.zeros_like(a)
    if dx > 0:
        out[:, dx:] = a[:, :-dx]
    else:
        out[:, :dx] = a[:, -dx:]
    return out


def shift_y(a: np.ndarray, dy: int) -> np.ndarray:
    """Shift down by dy rows (up if negative), filling with transparent: no wrap-around
    (np.roll moved the feet onto the top row: the dash over his head, visual QA S2-1)."""
    if dy == 0:
        return a
    out = np.zeros_like(a)
    if dy > 0:
        out[dy:] = a[:-dy]
    else:
        out[:dy] = a[-dy:]
    return out


def best_shift(a: np.ndarray, ref: np.ndarray, span: int = 14) -> int:
    ma, mr = body_mask(a), body_mask(ref)
    best, best_iou = 0, -1.0
    for dx in range(-span, span + 1):
        m = shift_x(ma[:, :, None].astype(np.uint8), dx)[:, :, 0] > 0
        u = (m | mr).sum()
        iou = (m & mr).sum() / u if u else 0
        if iou > best_iou + 1e-9 or (abs(iou - best_iou) < 1e-9 and abs(dx) < abs(best)):
            best, best_iou = dx, iou
    return best


#: Loops drawn with the body wandering from frame to frame: every frame is
#: shifted to overlap the first one best (sideways, and vertically for the
#: airborne ones), so the loop holds still where the art didn't.
STEADY = {"climb": False, "dangle": True, "dizzy": False, "spin": True, "hop_idle": False, "tail_copter": True, "glide": True, "fall_flail": True, "hang_ledge": False,
          # Round 4 fidgets: redrawn every frame, the body wanders sideways.
          **{s: False for s in ["look_dirs", "petted", "hats", "sweat_fan", "worried_battery", "hold_sign", "streamer", "chubby_idle", "glasses_type", "watch_tv", "knock_screen"]}}


def steady(sheet: str, frames: list[np.ndarray]) -> list[np.ndarray]:
    if sheet not in STEADY or not frames:
        return frames
    vertical = STEADY[sheet]
    ref = frames[0]
    out = [ref]
    for f in frames[1:]:
        dx = best_shift(f, ref, 16)
        g = shift_x(f, dx)
        dy = 0
        if vertical:
            best = -1.0
            mr = body_mask(ref)
            for d in range(-8, 9):
                m = shift_y(body_mask(g), d)
                u = (m | mr).sum()
                iou = (m & mr).sum() / u if u else 0
                if iou > best + 1e-9:
                    best, dy = iou, d
            g = shift_y(g, dy)
        out.append(g)
    print(f"  steady {sheet}")
    return out


def align(sheet: str, frames: list[np.ndarray], lookup) -> list[np.ndarray]:
    frames = steady(sheet, frames)
    refs = ALIGN.get(sheet)
    if not refs or not frames:
        return frames

    def ref(name):
        if not name:
            return None
        mirror = name.endswith(":m")
        a = lookup(name.removesuffix(":m"))
        return None if a is None else (a[:, ::-1] if mirror else a)

    r0, r1 = ref(refs[0]), ref(refs[1])
    s0 = best_shift(frames[0], r0) if r0 is not None else 0
    s1 = best_shift(frames[-1], r1) if r1 is not None else s0
    n = len(frames)
    shifts = [round(s0 + (s1 - s0) * i / max(1, n - 1)) for i in range(n)]
    print(f"  align {sheet}: start {s0:+d}, end {s1:+d} px")
    return [shift_x(f, s) for f, s in zip(frames, shifts)]


#: Crown height above the glitch eye (art px): typically 17, at most 24 (the frames' spread).
CROWN_TYPICAL, CROWN_MAX = 17, 24


def head_top(a: np.ndarray) -> tuple[int, int]:
    """Where a hat sits (art px): the top of the head between the ears.

    Found from the glitch eye when it shows (it is on the head): the head
    centre is the middle of the forehead (the body run through the eye's
    column, 5-12 rows above it), the crown the top of the head straight up
    from there (walking up the solid column, so a tail or a sign held above
    the head is not taken for it). Without the eye (back views): the middle
    of the top third of the character and the highest pixel there.
    """
    m = body_mask(a)
    ys = np.where(m.any(1))[0]
    if not len(ys):
        return (a.shape[1] // 2, a.shape[0] // 2)
    r, g, b = (a[:, :, i].astype(int) for i in range(3))
    magenta = (a[:, :, 3] > 0) & (r > 150) & (b > 180) & (g < 110)
    if magenta.sum() >= 8:
        ex, ey = eye_of(a)
        mids = []
        for y in range(max(0, ey - 12), max(0, ey - 4)):
            row = m[y]
            xs = np.where(row)[0]
            if not len(xs):
                continue
            x0 = int(xs[np.argmin(np.abs(xs - ex))])
            lo = x0
            while lo > 0 and row[lo - 1]:
                lo -= 1
            hi = x0
            while hi < len(row) - 1 and row[hi + 1]:
                hi += 1
            mids.append((lo + hi) / 2)
        if mids:
            hx = int(round(float(np.median(mids))))
            y = ey
            gap = 0
            top = ey
            while y > 0:
                y -= 1
                if m[y, max(0, hx - 1) : hx + 2].any():
                    top, gap = y, 0
                else:
                    gap += 1
                    if gap > 1:
                        break
            # Something solid goes on up from the head (a tail overhead, raised
            # paws, a sign): the crown is where it usually is above the eye.
            if top < ey - CROWN_MAX:
                top = ey - CROWN_TYPICAL
            return (hx, top)
    top, bottom = int(ys.min()), int(ys.max())
    band = m[top : top + max(1, (bottom - top) // 3)]
    hx = int(round(float(np.where(band)[1].mean())))
    cols = m[:, max(0, hx - 2) : hx + 3]
    rows = np.where(cols.any(1))[0]
    return (hx, int(rows.min()) if len(rows) else top)


def grip_lines(sheets: tuple[str, ...]) -> list[str]:
    """Grip points saved by slice-generated.py (art/frames/<sheet>-grips.json)."""
    import json

    lines = []
    for p in sorted(FRAMES.glob("*-grips.json")):
        if p.name.removesuffix("-grips.json") not in sheets:
            continue
        sheet = p.name.removesuffix("-grips.json")
        for i, (x, y) in enumerate(json.loads(p.read_text())):
            lines.append(f"  {sheet}{i}: [{x}, {y}],")
    return lines


def main():
    names: list[str] = []
    imgs: list[np.ndarray] = []
    by_name: dict[str, np.ndarray] = {}
    # Loops first, then the clips that line up with them.
    order = sorted(sg.SHEETS, key=lambda s: s in ALIGN)
    for sheet in order:
        frames = []
        i = 0
        while (FRAMES / f"{sheet}-{i}.png").exists():
            frames.append(np.array(Image.open(FRAMES / f"{sheet}-{i}.png").convert("RGBA")))
            i += 1
        frames = fx.apply(sheet, frames, by_name.get)
        frames = align(sheet, frames, by_name.get)
        for i, f in enumerate(frames):
            names.append(f"{sheet}{i}")
            imgs.append(f)
            by_name[f"{sheet}{i}"] = f
    for name, i in LEGACY.items():
        names.append(name)
        imgs.append(legacy_frame(i))
    rows = (len(imgs) + COLS - 1) // COLS
    out = np.zeros((rows * sg.CANVAS_H, COLS * sg.CANVAS_W, 4), np.uint8)
    eyes = []
    heads = []
    for k, a in enumerate(imgs):
        x, y = (k % COLS) * sg.CANVAS_W, (k // COLS) * sg.CANVAS_H
        out[y : y + sg.CANVAS_H, x : x + sg.CANVAS_W] = a
        eyes.append(None if names[k] in EYELESS or not has_eye(a) else eye_of(a))
        heads.append(head_top(a))
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out, "RGBA").save(SHEET, optimize=True)
    lines = [
        "// GENERATED by scripts/pack-sprites.py - do not edit by hand.",
        "// Frame name -> index in public/sprites/glitch-anim.png, and the glitch eye per frame (art px).",
        "",
        "export const ANIM_FRAME_W = %d;" % sg.CANVAS_W,
        "export const ANIM_FRAME_H = %d;" % sg.CANVAS_H,
        "export const ANIM_INDEX: Record<string, number> = {",
        *[f"  {n}: {k}," for k, n in enumerate(names)],
        "};",
        "export const ANIM_EYES: Record<string, [number, number]> = {",
        *[f"  {n}: [{e[0]}, {e[1]}]," for n, e in zip(names, eyes) if e is not None],
        "};",
        "// Where a hat sits (art px in the frame): the top of the head between the ears, every frame",
        "// (upright head; upside-down or tumbling frames get a point on the head but no tilt).",
        "export const ANIM_HEADS: Record<string, [number, number]> = {",
        *[f"  {n}: [{h[0]}, {h[1]}]," for n, h in zip(names, heads)],
        "};",
        "// Where the cursor tip is held (art px in the frame), for frames drawn holding on to the cursor.",
        "export const ANIM_GRIPS: Record<string, [number, number]> = {",
        *grip_lines(("cling_cursor",)),
        "};",
        "// Where his mouth bites the cursor tip (art px in the frame), per bite_cursor frame.",
        "export const ANIM_BITES: Record<string, [number, number]> = {",
        *grip_lines(("bite_cursor",)),
        "};",
        "",
    ]
    INDEX.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {SHEET.relative_to(ROOT)} ({len(imgs)} frames) and {INDEX.relative_to(ROOT)}")
    # Strip the white-background halo and close the dark outline (see clean-edges.py).
    import importlib.util

    spec = importlib.util.spec_from_file_location("clean_edges", Path(__file__).with_name("clean-edges.py"))
    ce = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ce)
    ce.clean(SHEET, (sg.CANVAS_W, sg.CANVAS_H))
    display_sheets()


#: Display sheets: the art grid rendered at the exact device size, so the app
#: never scales pixel art by a non-integer factor at runtime (1.5 CSS px per
#: art px would make art pixels alternately 1 and 2 device px wide on a 1x
#: screen). @2x: 3 device px per art px, nearest neighbour (crisp). @1x: 1.5
#: device px per art px: nearest x3 then an area downsample by 2 (premultiplied
#: alpha), smooth like the original high-res sheet.
DISPLAY = {"@1x": (3, 2), "@2x": (3, 1)}


def display_sheets():
    art = Image.open(SHEET).convert("RGBA")
    for suffix, (up, down) in DISPLAY.items():
        big = art.resize((art.width * up, art.height * up), Image.NEAREST)
        if down > 1:
            big = big.convert("RGBa").resize((big.width // down, big.height // down), Image.BOX).convert("RGBA")
        path = SHEET.with_name(f"{SHEET.stem}{suffix}.png")
        big.save(path, optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({up / down:g} px per art px)")


if __name__ == "__main__":
    main()
