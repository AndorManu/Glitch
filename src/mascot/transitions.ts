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

import { type Family, familyOf } from "../sprites/families";

export { type Family, familyOf };

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
  // Off a wall onto the floor: the landing crouch (side-on), then on through
  // side>front. Onto a wall from facing you: turn side-on first.
  add("wall>side", "off_wall", 1, () => [key("jump7", 120), key("jump7", 80)], ["jump"]);
  add("side>wall", "onto_wall", 1, () => [key("jump1", 90)], ["jump"]);
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
 * convention faces right) and is never mirrored (families.ts): played
 * forwards to end facing left, backwards to end facing right. Without it:
 * through the front view (side -> front in the old facing, front -> side in
 * the new one), else a glitch cut. Facing you there is nothing to turn:
 * front-facing frames are never mirrored.
 */
export function turnKeys(fam: Family, toLeft: boolean, next: string): Keyframe[] {
  if (fam === "front") return [];
  if (fam === "wall") {
    // On a wall or the ceiling there is no drawn turn: he swings round on the
    // spot (a quick rotation through the wall's normal), never a mirror flip.
    const frame = next.startsWith("climb") ? next : "climb0";
    return [
      key(frame, 60, { flip: true, rot: 40, pivot: 0.45 }),
      key(frame, 60, { flip: true, rot: 85, pivot: 0.45 }),
      key(frame, 60, { rot: -85, pivot: 0.45 }),
      key(frame, 60, { rot: -40, pivot: 0.45 }),
      key(frame, 70, { rot: -10, pivot: 0.45 }),
    ];
  }
  if (fam === "side") {
    if (has("turn_around")) {
      const ks = clip("turn_around", 75, { ease: 1 });
      return toLeft ? ks : [...ks].reverse();
    }
    if (has("turn_side_to_front") && has("turn_front_to_side")) {
      const toFront = clip("turn_side_to_front", 75, { ease: 1 });
      const toSide = clip("turn_front_to_side", 75, { ease: 1 });
      return [...toFront.map((k) => ({ ...k, flip: true })), ...toSide];
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
