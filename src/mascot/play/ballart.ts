// The fetch ball's pixel art (code-drawn, in Glitch's palette): shared by
// the play overlay (src/playfield/draw.ts) and Glitch's mouth when he
// carries it (accessories.ts). `ballGrid` is unit-tested.

/** Art px across the ball. */
export const BALL_ART = 12;

export const OUTLINE = "#0c0a18";
export const BODY = "#c000f0";
export const SHADE = "#8a00d8";
export const LIGHT = "#ff5fe0";
export const GLINT = "#ffe6fb";
export const SEAM = "#29f1ff";
export const SEAM_DARK = "#0f9fc4";

/**
 * One roll frame as rows of colours ("" = empty), BALL_ART square: an
 * outlined orb, lit from the top left, with two cyan glitch seams that
 * travel across it as it turns (frame 0..7 = a full turn), so rolling reads
 * both ways. `glitch`: rows shoved sideways.
 */
export function ballGrid(frame: number, glitch = false): string[][] {
  const n = BALL_ART;
  const c = (n - 1) / 2;
  const R = n / 2;
  const phase = (frame / 8) * Math.PI * 2;
  const rows: string[][] = [];
  for (let y = 0; y < n; y++) {
    const row: string[] = [];
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      if (d > R - 0.15) {
        row.push("");
        continue;
      }
      if (d > R - 1.2) {
        row.push(OUTLINE);
        continue;
      }
      let col = dx + dy > 2.5 ? SHADE : BODY;
      if (dx + dy < -4) col = LIGHT;
      // Seams: meridians at phase and phase + pi, seen from the side.
      const half = Math.sqrt(Math.max(0, 1 - (dy / (R - 1)) ** 2)) * (R - 1.2);
      for (const p of [phase, phase + Math.PI]) {
        if (Math.cos(p) < -0.15) continue; // on the far side
        const sx = Math.sin(p) * half;
        if (Math.abs(dx - sx) < 0.62) col = Math.cos(p) > 0.55 ? SEAM : SEAM_DARK;
      }
      if (Math.round(dx) === -2 && Math.round(dy) === -2) col = GLINT;
      row.push(col);
    }
    rows.push(row);
  }
  if (glitch) {
    for (const y of [3, 4, 8]) rows[y] = y === 8 ? [...rows[y].slice(1), ""] : ["", ...rows[y].slice(0, -1)];
  }
  return rows;
}

export function toCanvas(rows: string[][]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = rows[0].length;
  c.height = rows.length;
  const ctx = c.getContext("2d")!;
  rows.forEach((row, y) => row.forEach((col, x) => {
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  }));
  return c;
}

