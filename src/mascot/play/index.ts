// Games, play and growth: wiring games.ts to Tauri (events from Rust, the
// ball window, the pet state). main.ts calls `initPlay` once.

import { listen } from "@tauri-apps/api/event";
import { type FeedResult, type LevelUp, playApi, type PetView, type Settings } from "../../shared/ipc";
import { Accessories, type AccessoryLayer } from "../accessories";
import type { Creature } from "../creature";
import type { Vec } from "../physics";
import { Play, playSettings } from "./games";

export async function initPlay(
  c: Creature,
  renderer: { accessories: AccessoryLayer | null },
  cursor: () => Promise<Vec>,
  settings: Settings | null,
): Promise<{ play: Play; acc: Accessories }> {
  const acc = new Accessories(() => c.repaint());
  renderer.accessories = acc;
  void acc.load().then(() => c.repaint());
  let current = playSettings(settings);
  const play = new Play({
    creature: c,
    acc,
    clock: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
    rand: Math.random,
    cursor,
    ballOpen: (x, y) => playApi.ballOpen(x, y).catch(() => null),
    ballMove: (x, y) => void playApi.ballMove(x, y).catch(() => {}),
    ballClose: () => void playApi.ballClose().catch(() => {}),
    petEvent: (kind) =>
      void playApi.event(kind).then(
        (v) => play.mood.apply(v),
        () => {},
      ),
    settings: () => current,
  });
  await listen<Settings>("settings-changed", (e) => {
    current = playSettings(e.payload);
    play.check(false, current);
  });
  await listen<PetView>("pet-changed", (e) => play.mood.apply(e.payload));
  await listen<LevelUp>("pet-levelup", () => play.mood.levelUp());
  await listen<string>("mascot-action", (e) => void play.action(String(e.payload)));
  await listen<boolean>("panel-visibility", (e) => play.check(!!e.payload));
  await listen<boolean>("mascot-hover", (e) => play.hover(!!e.payload));
  // The ball window (ball.html).
  await listen("ball-grab", () => play.fetch.grab());
  await listen("ball-release", () => play.fetch.release());
  await listen("ball-quit", () => play.fetch.end());
  // Files dragged onto him (only Rust reads the paths; see play.rs watch_drops).
  await listen<boolean>("feed-drag", (e) => play.feeding.drag(!!e.payload));
  await listen<FeedResult>("feed-result", (e) => play.feeding.result(e.payload));
  void playApi.pet().then((v) => play.mood.apply(v), () => {});
  return { play, acc };
}
