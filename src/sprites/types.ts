// The contract between the art and the rest of the app.
//
// Anything that can produce named frames (code-drawn grids today, a PNG
// sprite sheet later) works, as long as it provides the frame names that
// the animations in `src/mascot/animations.ts` use:
//   idle0 idle1 blink think0 think1 happy wave walk0 walk1 sleep0 sleep1

/** Pixel-art drawn as text: one character per pixel. */
export interface GridSpriteSource {
  kind: "grid";
  palette: Record<string, string>;
  frames: Record<string, string[]>;
}

/** A PNG sprite sheet: frames laid out left-to-right, top-to-bottom. */
export interface SheetSpriteSource {
  kind: "sheet";
  /** URL of the PNG, e.g. "/sprites/glitch.png" (put the file in /public/sprites). */
  url: string;
  frameWidth: number;
  frameHeight: number;
  /** Frame name -> index in the sheet (0 = top-left). */
  frames: Record<string, number>;
  /** Hard-edged pixel art: drawn without smoothing. */
  pixelated?: boolean;
  /** CSS px per sheet px (default: the 2x sheet drawn at half size). */
  scale?: number;
  /** Glitch eye per frame, in sheet px inside the frame (for eye sparks). */
  eyes?: Record<string, [number, number]>;
}

export type SpriteSource = GridSpriteSource | SheetSpriteSource;

/** A frame ready to draw with `drawImage`. */
export type FrameImage = CanvasImageSource & { width: number; height: number };

export interface SpriteSet {
  /** Native size of one frame in art pixels. */
  width: number;
  height: number;
  /** True for hard-edged pixel grids (scale by whole numbers, no smoothing). */
  pixelated: boolean;
  /** CSS px per frame px, if the art has a fixed on-screen size. */
  scale?: number;
  frame(name: string): FrameImage;
  /** The glitch eye in frame `name` as fractions of the frame size, if known. */
  eye?(name: string): [number, number] | null;
  /** Whether `name` is a real frame (not the fallback). */
  has?(name: string): boolean;
}
