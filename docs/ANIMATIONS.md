# Glitch's animations

Glitch is drawn from the 4x4 sheet `public/sprites/glitch.png` (frames 276x180,
shown at 138x90 CSS px inside the 160x160 mascot window). Every animation is a
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
  `dust`, `dizzy`, `eq` (pixel equalizer by his head while listening).
- `props`: code-drawn pixel props (`src/mascot/props.ts`): `cursor`, `window`
  (mini browser tab), `tether` (rope). Everything mirrors when Glitch faces left.

Keys are drawn relative to the surface he stands on: the renderer's
`placement` (feet point + body angle, from the physics) turns the whole pose
onto a wall (90 / -90), the ceiling (180) or into a spin, and `facingLeft`
mirrors in the body's own frame, so facing is right in every orientation.
On top of the keys the physics adds `motion` (stretch with speed, a lean
into acceleration, legs lagging behind a swing, a cyan/magenta ghost trail
when flying fast) and his glitch `platform`.

The `Animator` keeps one timer at most, merges identical keys into one wait,
skips repaints that change nothing and never goes above 20 fps. Measured with a
fake clock over 60 s (40 random seeds for idle): idle 0.8 repaints/s on average
(worst seed 1.1, glitch bursts included), sleep 0.43/s, ask 0.75/s, think 3.2/s,
walk 15/s, listen 10/s.

## Living on the desktop

`src/mascot/creature.ts` runs Glitch's life; it has no DOM or Tauri in it
(`main.ts` plugs in the real window, `dev/stage.html` a fake desktop, the
tests a fake clock):

- **World** (`physics.ts`): the work area of his monitor and the visible tops
  of other apps' windows (`api.world()`, polled at most every 1.5 s, before
  each new activity and every 2.5 s while standing on a window top; never
  while asleep). Surfaces: floor, left/right screen edge, ceiling, window
  tops ("ledges"), and his own glitch platform. The body is tracked by its
  centre in physical px; the window is placed so the feet sit 4 px from the
  window edge they point at (centred while flying, so a spin never clips).
- **Physics**: gravity 2600 CSS px/s², air drag on throws, bounces off the
  screen edges and ceiling with damping, small bounces on hard landings,
  one-way landings on window tops (swept per substep, so nothing tunnels),
  spin with a cat-righting reflex. Thrown into a wall he sometimes grabs on.
- **Brain** (`brain.ts`): after resting (5-14 s on the floor or a window top,
  and at least 3x as long as the last activity; 1-3.5 s on walls) it picks a
  weighted behaviour with a cooldown: stroll, run, climb (up a screen edge,
  along the ceiling upside down, then let go / climb back / the grand tour),
  jump onto a window top (crouch, ballistic arc, squash), sit on a window's
  edge, peek over its end, hop down, glitch-teleport (onto a window, the
  ceiling, the far side), build a glitch platform (as a stepping stone to a
  window too high to jump to, or just to stand on until it breaks), chaos
  spin (likelier when excited), a malfunction, look around (and turn his
  back to stare at your screen). Walks lag now and then (freeze, glitch,
  skip ahead).
- **Reactions**: `thinking` / `asking` / `listening` stop him in place
  (landing first if airborne); `happy` = celebrate (a backflip if he may
  move and the chat is closed); chat open = stays put facing the bubble;
  movement off = only idle animations (and he gets down from walls first);
  hover = stops and looks at the cursor, wakes him; the window under him
  moving = he rides along, closing/moving it far = he falls; 10 minutes
  without interaction = yawns and sleeps (only standing).
- **Drag & throw**: press on his body (the click-through hitbox opens to the
  whole window), past 4 px he's picked up: the window follows the global
  cursor at ~55 Hz, he hangs on a damped pendulum from the grab point (legs
  kick when you move fast), and on release flies with the cursor's velocity
  over the last 80 ms (least squares) plus the swing. A hard landing splats
  him flat (glitching, then dizzy). A plain click still opens the chat.
  You can also catch him in mid-air.

Budgets (fake clock, `creature.test.ts`): resting 0.7-1.0 repaints and
wakeups per second (1.1 wakeups/s on a window top with the ledge watch); no
window moves and no movement timer while still; walking/climbing about 29
window moves and 14 repaints per second; flying / carried at most ~56 moves
and 59 repaints per second; over an hour awake he moves 6-9 % of the time.

Watch it all: `npx vite`, open <http://localhost:1420/dev/stage.html?debug=1>
(drag him, throw him, drag the fake windows by their title bars).
`node dev/stage-shots.mjs <dir> [scenarios]` films contact sheets (climb,
jump, throw, splat, teleport, build, sit, ride...).

Preview everything: run `npx vite`, open <http://localhost:1420/dev/gallery.html>
(`?left=1` faces left, `?fallback=1` uses the code-drawn fallback creature,
`?strip=walk,dangle&frames=8&skip=0` for frame strips). Screenshots:
`node dev/gallery-shots.mjs <dir>` and `node dev/mascot-shots.mjs <dir>`.

## Triggering

- Moods from Rust (`mood` event) and the window logic in `src/mascot/main.ts`.
- Any animation or behaviour by name: the `mascot-action` Tauri event
  (payload: the name, e.g. `"grabCursor"`, `"climb"`, `"teleport"`), or
  `playAction(name)` exported from `main.ts`. Behaviours (`brain.ts`) win when
  they fit where he is (`"climb"` climbs; on a wall it plays the climbing
  animation instead). Unknown names are ignored. One-shots return to the rest
  pose; looping actions stop by themselves after 8 s. In dev builds, also
  `window.__glitch.play(name)`, `.mood(m)`, `.burst(ms)`, `.face(left)`,
  `.creature`.

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
| `dangle` | action (the old keyframed swing) | 7 swinging like a pendulum around the head | loop | **dangling by the scruff** (limp body, legs hanging, tail down) |
| `held` / `heldKick` | carried by the mouse (the swing is physics) | 0 stretched by his weight, glances; moving fast: 4 / 5 legs running in the air | loop | **dangling by the scruff** — the most-wanted pose |
| `fall` → `land` | action | 0 stretched falling, then squash + dust | once | **falling** (arms up, stretched) and **landing crouch** |
| `cling` | resting on a wall / the ceiling | 4 pressed flat, breathing, 1 glance over the shoulder, grip shifts, a burst | loop | **clinging to a wall** (all four paws flat) |
| `climb` | climbing walls, crawling the ceiling (rotated by the placement) | 4 / 5 slower, flatter gait | loop | **climbing cycle** seen from the side |
| `run` | running | 4 / 5 at 18 fps, deep lean, big bob, trail | loop | **run cycle** with all legs off the ground |
| `crouch` | before a jump | 4 squashing down, spark in the eye | once | **crouch / coil** |
| `airUp` / `airDown` | jumping, falling | 5 stretched / 0 stretched (stretch grows with speed) | still | **jump** (stretched up) and **falling** poses |
| `tumble` | thrown spinning | 15 / 7 crackling with glitch | loop | — |
| `flail` | letting go, the window under him vanished | 4 / 5 legs going, flipping to look both ways | loop | **panic flail** |
| `splat` → `dizzy` | landing far too hard | 7 flattened to a pancake with a heavy glitch, pops up; then 14 wobbling with stars | once | **flattened** pose, **dizzy** pose |
| `sitEdge` | on a window top | 8 sitting low, legs over the window's edge, swinging, looking down | loop | **sitting on an edge, legs dangling** |
| `peekEdge` | at the end of a window top | 1 leaning far over the edge, eye flicker | once | **peeking down over an edge** |
| `lookAround` | idle behaviour | 1 both ways, then 2 (back view) staring at your screen | once | — |
| `lookBack` | pausing on a wall | 1 looking back down | once → `cling` | — |
| `build` | conjuring his platform | 6 / 10 with sparkles and glitch | once | **casting** pose (paws forward) |
| `malfunction` | behaviour, any time | the picture skips around, tears, freezes, half-dissolves, reboots | once | — (procedural) |
| `yawn` | falling asleep | 0 big stretch, 8 sits, 9 curls up | once → `sleep` | **yawn** |
| `listen` | mood `listening` (push-to-talk) | 0 leaning in, bobbing in time, `eq` equalizer by his head | loop | **ear-perk** / listening pose |
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
