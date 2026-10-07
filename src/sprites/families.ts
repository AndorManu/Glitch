// Pose families of Glitch's frames (by name), and which frames may be
// mirrored when he faces left.
//
// The glitch eye is on one particular eye (as in the original front pose),
// so a frame that shows him facing you must never be mirrored: that would
// move the magenta eye to the other side. Only side-on frames mirror with
// his facing.

export type Family = "front" | "side" | "sit" | "curled" | "back" | "wall" | "any";

/** Frame-name prefix -> family. Longest prefix wins. */
const FAMILY_PREFIX: [string, Family][] = [
  // standing, facing you
  ...["idle", "talk", "wave", "think", "laugh", "celebrate", "sad", "angry", "scared", "eat", "dance", "typing", "point", "dizzy", "sneeze", "listen", "surprised"].map((p) => [p, "front"] as [string, Family]),
  ...["scratch", "groom", "shake_off", "hop_idle", "tail_chase", "look_back"].map((p) => [p, "front"] as [string, Family]),
  ...["pose_front", "pose_happy", "pose_think", "pose_laugh", "pose_wave"].map((p) => [p, "front"] as [string, Family]),
  // side view (walking, running, jumping, pushing, stretching)
  ...["walk", "run", "jump", "push", "grab_tab", "stretch", "pose_side", "pose_walk", "pose_notify", "pose_push"].map((p) => [p, "side"] as [string, Family]),
  ["sit", "sit"],
  ["sit_idle_look", "sit"],
  ["pose_sit", "sit"],
  ["sleep", "curled"],
  ["pose_sleep", "curled"],
  ["pose_back", "back"],
  ["climb", "wall"],
];

/**
 * Transition clips: the family they start in and the one they end in. A
 * frame of a clip counts as the start family in the first half and the end
 * family in the second, so a clip cut short still bridges correctly.
 */
const CLIPS: Record<string, [Family, Family, number]> = {
  sit_down: ["front", "sit", 8],
  stand_up_paws: ["sit", "front", 8],
  stand_up_hop: ["sit", "front", 6],
  stand_up_glitch: ["sit", "front", 6],
  turn_front_to_side: ["front", "side", 6],
  turn_side_to_front: ["side", "front", 6],
  turn_to_back: ["front", "back", 6],
  walk_start: ["front", "side", 6],
  walk_stop: ["side", "side", 6],
  lie_down: ["front", "curled", 8],
  get_up: ["curled", "front", 8],
  wake: ["curled", "front", 8],
};

/** Frames that belong to no family (effects, being held): never bridged from or to. */
const NEUTRAL = ["turn_around", "dangle", "spin", "teleport", "land", "peek", "pose_glitch", "pose_chaos"];

const cache = new Map<string, Family>();

/** The frame name without its number: "walk_start3" -> ["walk_start", 3]. */
export function splitName(frame: string): [string, number] {
  const m = /^(.*?)(\d+)$/.exec(frame);
  return m ? [m[1], Number(m[2])] : [frame, -1];
}

export function familyOf(frame: string): Family {
  let f = cache.get(frame);
  if (f) return f;
  f = "any";
  const [base, i] = splitName(frame);
  const clip = CLIPS[base];
  if (clip) f = i < clip[2] / 2 ? clip[0] : clip[1];
  else if (!NEUTRAL.some((p) => frame.startsWith(p))) {
    let best = 0;
    for (const [p, fam] of FAMILY_PREFIX) {
      if (frame.startsWith(p) && p.length > best && /^\d*$/.test(frame.slice(p.length))) {
        best = p.length;
        f = fam;
      }
    }
    // Old sheet aliases.
    if (best === 0) f = ({ side: "side", sit: "sit", back: "back", blink: "front", happy: "front", laugh: "front", notify: "side" } as Record<string, Family>)[frame] ?? "any";
  }
  cache.set(frame, f);
  return f;
}

/**
 * Clip and effect sheets that show him facing you (or his back): never
 * mirrored. `true` = every frame, a list = only those frames (the rest are
 * side-on and mirror with his facing).
 */
const FRONTAL: Record<string, true | number[]> = {
  sit_down: true,
  stand_up_paws: true,
  stand_up_hop: true,
  stand_up_glitch: true,
  wake: true,
  dangle: true,
  spin: true,
  teleport: true,
  peek: true,
  land: true,
  // Drawn turning from facing right to facing left: always shown as drawn
  // (the turn's direction is chosen by playing it forwards or backwards).
  turn_around: true,
  turn_to_back: true,
  turn_front_to_side: [0, 1],
  turn_side_to_front: [4, 5],
  walk_start: [0, 1],
  lie_down: [0, 1, 2, 3],
  get_up: [6, 7],
};

/** May this frame be mirrored when he faces left? Only side-on frames. */
export function mirrorable(frame: string): boolean {
  const fam = familyOf(frame);
  if (fam === "front" || fam === "sit" || fam === "back") return false;
  const [base, i] = splitName(frame);
  const fr = FRONTAL[base];
  if (fr === true) return false;
  if (fr && fr.includes(i)) return false;
  // Old 16-pose names: the front-facing ones.
  if (/^pose_(front|front_alt|happy|laugh|think|wave|glitch|chaos|sit|back)$/.test(frame)) return false;
  return true;
}
