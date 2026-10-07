# Glitch's animations

Glitch is drawn from the 4x4 sheet `public/sprites/glitch.png` (frames 276x180,
shown at 138x90 CSS px inside the 160x110 mascot window). Every animation is a
list of **keyframes** (`src/mascot/animations.ts`):

```ts
{ frame: "walk1", ms: 67, dx, dy, sx, sy, rot, pivot, flip, glitch, dissolve, fx, props }
```

- `dx/dy` CSS px (+dx = the way Glitch faces), `sx/sy` squash & stretch around
  the feet (or `pivot`: 0 feet, 1 top of head), `rot` degrees (+ = lean forward).
- `glitch` 0..1 turns on the procedural glitch (`render.ts` + `glitchfx.ts`):
  slice displacement, cyan/magenta RGB split, corrupted pixel blocks, scanlines,
  one-frame flicker, purple sparks out of the glitch eye.
- `dissolve` 0..1 punches the sprite into flying pixels (teleport).
- `fx`: `trail` (dust + purple pixels behind a walk), `sparkle`, `zzz`, `eye`,
  `dust`, `dizzy`.
- `props`: code-drawn pixel props (`src/mascot/props.ts`): `cursor`, `window`
  (mini browser tab), `tether` (rope). Everything mirrors when Glitch faces left.

The `Animator` keeps one timer at most, merges identical keys into one wait,
skips repaints that change nothing and never goes above 20 fps. Measured with a
fake clock over 60 s (40 random seeds for idle): idle 0.8 repaints/s on average
(worst seed 1.1, glitch bursts included), sleep 0.43/s, ask 0.75/s, think 3.2/s,
walk 15/s (only while the window walks).

Preview everything: run `npx vite`, open <http://localhost:1420/dev/gallery.html>
(`?left=1` faces left, `?fallback=1` uses the code-drawn fallback creature,
`?strip=walk,dangle&frames=8&skip=0` for frame strips). Screenshots:
`node dev/gallery-shots.mjs <dir>` and `node dev/mascot-shots.mjs <dir>`.

## Triggering

- Moods from Rust (`mood` event) and the window logic in `src/mascot/main.ts`.
- Any animation by name: the `mascot-action` Tauri event (payload: the name,
  e.g. `"grabCursor"`), or `playAction(name)` exported from `main.ts`. Unknown
  names are ignored. One-shots return to what was playing; looping actions stop
  by themselves after 8 s. In dev builds, also `window.__glitch.play(name)`,
  `.mood(m)`, `.burst(ms)`, `.face(left)`.

## Every animation

| Name | Triggered by | Frames (sheet index) / props | Loop? | New art that would help most |
|---|---|---|---|---|
| `idle` | default | 0 front; fidgets: 3 tail swap, 1 glance (both ways), 8 sit, hop, stretch, eye twitch; a glitch burst every 8–25 s (sometimes a 1-frame swap to 7 / 15) | loop | **blink** (front, eyes closed), **ear twitch**, **yawn**, **scratching ear** |
| `walk` | wandering | 4 / 5 with bob, squash on contact, lean, dust + purple pixel trail | loop | a real **4-frame walk cycle** (contact, down, passing, up) side view, plus a **back-view walk** for walking up the screen |
| `think` | mood `thinking` (starts with a burst) | 14 "?" bobbing, eye flickers | loop | **"?" pose with paw on chin**, a second "?" frame with the question mark shifted (so it blinks) |
| `ask` | mood `asking` | 14 with a curious head tilt | loop | **head-tilt** pose |
| `happy` | mood `happy` | 6 / 10 wave + hop + sparkles; or `laugh` | once | **jump for joy** (both arms up, feet off the ground) |
| `sleep` | 10 min without activity | 9 breathing, drifting "z" | loop | a second **sleep breath** frame (belly up/down), **waking up stretch** |
| `startled` | click | 0 tiny jump + eye glitch | once | **startled** pose (fur up, eyes wide) |
| `dangle` | dragging the mascot window (ends 250 ms after the window stops moving, or on the next mouse event) | 7 swinging like a pendulum around the head | loop | **dangling by the scruff** (limp body, legs hanging, tail down) — the most-wanted pose; currently the crouch pose is reused |
| `fall` → `land` | end of a drag | 0 stretched falling, then squash + dust | once | **falling** (arms up, stretched) and **landing crouch** |
| `laugh` | action, or 35 % of `happy` | 11 shaking with sparkles | once | — (pose 11 works well) |
| `grabCursor` | action | 4 crouch/wiggle, 5 pounce, land on the `cursor` prop, 6 holding it up | once | **pounce mid-air** (stretched, paws forward), **holding an object overhead** |
| `carryCursor` | action | 4 / 5 walk with the `cursor` prop at the snout | loop | **walking while carrying something in the mouth** or **in both paws** |
| `dragWindow` | action | small 4 / 5 leaning hard, `window` prop on a `tether` bumping behind | loop | **pulling a rope** (leaning back, rope over shoulder), 2–3 frames |
| `pushWindow` | action | small 4 / 5 leaning into the `window` prop, strain shakes, shove | loop | **pushing** (both paws flat forward, legs braced), 2 frames |
| `peek` | action (notifications) | 0 pops up from the bottom edge, 1 looks both ways, ducks, glitches back in | once → `glitchIn` | **peeking over an edge** (only head + paws visible) |
| `glitchOut` → `gone` → `glitchIn` | action (teleport: move the window during `gone`, 1.5 s) | 0 (+1 frame of 15) with glitch ramp, dissolve and a squash to a line | once | — (procedural); optionally a **"pixel-scattered" Glitch** frame |
| `chaosSpin` | action (chaos mode) | 15 spinning with heavy glitch, then 14 dizzy wobble with orbiting stars | once | **dizzy** pose (spiral eyes) |
| `napRock` | action | 13 breathing | loop | — |

### Asking an artist (or ChatGPT) for more poses

Keep the exact style of `art/glitch-raccoon-source.webp`: chunky pixel art,
dark outline, grey/beige raccoon with a striped tail, one glowing purple square
"glitch" eye on the right side of the face, purple pixel debris; **4x4 grid on a
transparent background, every pose facing right, feet on the same baseline,
same scale as the current sheet**. Then run `scripts/make-sprites.py` on it and
map the new indices in `src/sprites/raccoon.ts`.

Most valuable next sheet, in order:

1. dangling by the scruff (limp, legs and tail hanging)
2. falling (stretched, arms up)
3. landing crouch
4. blink (front pose 0 with eyes closed)
5. walk cycle frame: contact (side view)
6. walk cycle frame: passing (side view)
7. pounce mid-air (stretched, paws forward)
8. holding an object overhead with both paws
9. carrying something in the mouth while walking
10. pulling a rope over the shoulder, leaning back
11. pushing with both paws, legs braced
12. peeking over an edge (head and paws only)
13. dizzy (spiral eyes, wobbly)
14. startled (fur up, eyes wide)
15. jump for joy (arms up, feet off the ground)
16. back view walking (for walking up the screen)
