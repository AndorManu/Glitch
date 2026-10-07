// Transitions between pose families, so the animator never cuts from one
// kind of pose to an unrelated one (standing -> sitting, front -> side...).
//
// Every frame belongs to a family (by its name). When an animation starts in
// a different family than the frame on screen, the animator plays a bridge:
// the shortest path of transition clips through the family graph, each clip
// picked at random from its variants (weighted, never the same variant twice
// in a row). With no path, an intentional glitch cut (a short slice/RGB burst).
//
// Clips are only registered when their frames exist in the sprite sheet, so
// the graph grows as sheets are added (src/sprites/anim.ts).

import { ANIM_INDEX } from "../sprites/anim";
import type { Keyframe } from "./animations";

export type Family = "front" | "side" | "sit" | "curled" | "back" | "wall" | "any";

/** Frame-name prefix -> family. Longest prefix wins. */
const FAMILY_PREFIX: [string, Family][] = [
  // standing, facing you
  ...(["idle", "talk", "wave", "think", "laugh", "celebrate", "sad", "angry", "scared", "eat", "dance", "typing", "point", "dizzy", "sneeze", "listen", "surprised"] as const).map((p) => [p, "front"] as [string, Family]),
  ...(["scratch", "groom", "stretch", "shake_off", "hop_idle", "tail_chase", "look_back"] as const).map((p) => [p, "front"] as [string, Family]),
  ...(["pose_front", "pose_happy", "pose_think", "pose_laugh", "pose_wave"] as const).map((p) => [p, "front"] as [string, Family]),
  // side view (walking, running, jumping, pushing)
  ...(["walk", "run", "jump", "push", "grab_tab", "pose_side", "pose_walk", "pose_notify", "pose_push"] as const).map((p) => [p, "side"] as [string, Family]),
  ["sit", "sit"],
  ["sit_idle_look", "sit"],
  ["pose_sit", "sit"],
  ["sleep", "curled"],
  ["pose_sleep", "curled"],
  ["pose_back", "back"],
  ["climb", "wall"],
];

/** Frames that belong to no family (clips, effects, being held): never bridged from or to. */
const NEUTRAL = ["sit_down", "stand_up", "turn_", "walk_start", "walk_stop", "lie_down", "get_up", "wake", "dangle", "spin", "teleport", "land", "peek", "pose_glitch", "pose_chaos"];

const cache = new Map<string, Family>();

export function familyOf(frame: string): Family {
  let f = cache.get(frame);
  if (f) return f;
  f = "any";
  if (!NEUTRAL.some((p) => frame.startsWith(p))) {
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

/** Frames name0..name(n-1) that exist in the sheet. */
export function framesOf(name: string): string[] {
  const out: string[] = [];
  while (`${name}${out.length}` in ANIM_INDEX) out.push(`${name}${out.length}`);
  return out;
}

export const has = (name: string): boolean => framesOf(name).length > 0;

const key = (frame: string, ms: number, o: Partial<Keyframe> = {}): Keyframe => ({ frame, ms, ...o });

/**
 * A clip from a sheet: `ms` per frame, the first `ease` and last `ease`
 * frames held longer (slow in / slow out), optionally reversed.
 */
export function clip(name: string, ms = 90, o: { reverse?: boolean; ease?: number; hold?: number; pick?: number[] } = {}): Keyframe[] {
  let frames = framesOf(name);
  if (o.pick) frames = o.pick.map((i) => frames[i]).filter(Boolean);
  if (o.reverse) frames = [...frames].reverse();
  const ease = o.ease ?? 1;
  return frames.map((f, i) => {
    const edge = i < ease || i >= frames.length - ease;
    return key(f, i === frames.length - 1 && o.hold ? o.hold : edge ? Math.round(ms * 1.5) : ms);
  });
}

export interface Variant {
  id: string;
  weight: number;
  keys: (rand: () => number) => Keyframe[];
}

type Edge = `${Family}>${Family}`;

/** The transition graph: only clips whose frames exist. */
function buildEdges(): Partial<Record<Edge, Variant[]>> {
  const E: Partial<Record<Edge, Variant[]>> = {};
  const add = (edge: Edge, id: string, weight: number, keys: (rand: () => number) => Keyframe[], needs: string[]) => {
    if (!needs.every(has)) return;
    (E[edge] ??= []).push({ id, weight, keys });
  };
  // Sitting down / standing up.
  add("front>sit", "sit_down", 1, () => clip("sit_down", 95, { ease: 2 }), ["sit_down"]);
  add("sit>front", "stand_up_paws", 3, () => clip("stand_up_paws", 95, { ease: 2 }), ["stand_up_paws"]);
  add("sit>front", "stand_up_hop", 2, () => clip("stand_up_hop", 85, { ease: 1 }), ["stand_up_hop"]);
  add("sit>front", "stand_up_glitch", 1, () => clip("stand_up_glitch", 70, { ease: 1 }).map((k, i, a) => (i > 0 && i < a.length - 2 ? { ...k, glitch: 0.4, fx: "eye" as const } : k)), ["stand_up_glitch"]);
  // Turning between front and side view.
  add("front>side", "turn_front_to_side", 1, () => clip("turn_front_to_side", 80, { ease: 1 }), ["turn_front_to_side"]);
  add("side>front", "turn_side_to_front", 1, () => clip("turn_side_to_front", 80, { ease: 1 }), ["turn_side_to_front"]);
  add("front>back", "turn_to_back", 1, () => clip("turn_to_back", 85, { ease: 1 }), ["turn_to_back"]);
  add("back>front", "turn_from_back", 1, () => clip("turn_to_back", 85, { ease: 1, reverse: true }), ["turn_to_back"]);
  // Lying down to sleep / getting up.
  add("front>curled", "lie_down", 3, () => clip("lie_down", 120, { ease: 2 }), ["lie_down"]);
  add("front>curled", "yawn_down", 1, () => clip("wake", 130, { reverse: true, ease: 2 }), ["wake"]);
  add("curled>front", "get_up", 2, () => clip("get_up", 110, { ease: 2 }), ["get_up"]);
  add("curled>front", "wake", 2, () => clip("wake", 120, { ease: 2 }), ["wake"]);
  // Sitting <-> lying down, directly.
  add("sit>curled", "sit_to_sleep", 1, () => clip("lie_down", 120, { ease: 2, pick: [3, 4, 5, 6, 7] }), ["lie_down"]);
  return E;
}

let EDGES: Partial<Record<Edge, Variant[]>> | null = null;
export function edges(): Partial<Record<Edge, Variant[]>> {
  return (EDGES ??= buildEdges());
}

/** Shortest family path a -> b through the clip graph (BFS), or null. */
export function path(a: Family, b: Family): Edge[] | null {
  if (a === b) return [];
  const E = edges();
  const prev = new Map<Family, Edge>();
  const seen = new Set<Family>([a]);
  const q: Family[] = [a];
  while (q.length) {
    const f = q.shift()!;
    for (const e of Object.keys(E) as Edge[]) {
      const [from, to] = e.split(">") as [Family, Family];
      if (from !== f || seen.has(to)) continue;
      seen.add(to);
      prev.set(to, e);
      if (to === b) {
        const out: Edge[] = [];
        for (let cur: Family = b; cur !== a; cur = prev.get(cur)!.split(">")[0] as Family) out.unshift(prev.get(cur)!);
        return out;
      }
      q.push(to);
    }
  }
  return null;
}

/** Weighted pick, avoiding the variant used last time on this edge when there is a choice. */
export function pickVariant(vs: Variant[], rand: () => number, last?: string): Variant {
  const pool = vs.length > 1 && last ? vs.filter((v) => v.id !== last) : vs;
  const total = pool.reduce((t, v) => t + v.weight, 0);
  let r = rand() * total;
  for (const v of pool) if ((r -= v.weight) <= 0) return v;
  return pool[pool.length - 1];
}

/**
 * Turning around (facing left <-> right) from a pose of family `fam`. The
 * caller switches the renderer's facing at the same moment and plays these
 * keys first: keys with `flip` still show the old facing.
 *
 * turn_around is drawn turning from facing right to facing left (the art
 * convention faces right). With no turn sheet: through the front view
 * (side -> front in the old facing, front -> side in the new one), else a
 * glitch cut.
 */
export function turnKeys(fam: Family, toLeft: boolean, next: string): Keyframe[] {
  if (fam === "side" || fam === "front") {
    if (fam === "side" && has("turn_around")) {
      const ks = clip("turn_around", 75, { ease: 1 });
      // Facing left after: show the sheet as drawn (cancel the new mirror). Facing right: reversed.
      return toLeft ? ks.map((k) => ({ ...k, flip: true })) : [...ks].reverse();
    }
    if (has("turn_side_to_front") && has("turn_front_to_side")) {
      const toFront = clip("turn_side_to_front", 75, { ease: 1 });
      const toSide = clip("turn_front_to_side", 75, { ease: 1 });
      // Side: turn to face you (old facing), then to the new side. Front: a glance through the side view.
      return fam === "side"
        ? [...toFront.map((k) => ({ ...k, flip: true })), ...toSide]
        : [...toSide.map((k) => ({ ...k, flip: true })), ...toFront];
    }
  }
  return glitchCut(next);
}

/** An intentional glitch cut into `frame`: two quick slice/RGB-split keys. */
export function glitchCut(frame: string): Keyframe[] {
  return [key(frame, 50, { glitch: 0.75, fx: "eye" }), key(frame, 50, { glitch: 0.4, fx: "eye" })];
}

/**
 * Keys to get from the frame on screen to `next` (the first frame of what
 * plays next): transition clips, a glitch cut, or nothing (same family, or
 * either side is neutral). `mem.last` remembers the variant per edge.
 */
export function bridge(fromFrame: string | null, next: string, rand: () => number, mem: { lastClip?: Record<string, string> }): Keyframe[] {
  if (!fromFrame) return [];
  const a = familyOf(fromFrame);
  const b = familyOf(next);
  if (a === b || a === "any" || b === "any") return [];
  // Walls and the floor are switched by the physics (corners): no clip there.
  if (a === "wall" || b === "wall") return [];
  const p = path(a, b);
  if (!p) return glitchCut(next);
  const last = (mem.lastClip ??= {});
  const out: Keyframe[] = [];
  for (const e of p) {
    const v = pickVariant(edges()[e]!, rand, last[e]);
    last[e] = v.id;
    out.push(...v.keys(rand));
  }
  return out;
}
