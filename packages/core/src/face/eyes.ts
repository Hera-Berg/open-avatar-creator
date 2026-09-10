// Eyes: iris tracking, runtime clipping contract, and the lid-contour blink.
//
// The classic closed-eye look: the lash line morphs down onto a curve traced
// from the eye white's own alpha at import — the natural lower boundary of
// that eye — keeping its natural thickness. The eye interior squashes toward
// a point 68% down the eye (real lids come down from the top) and fades out.
// Lashes stay fully opaque throughout: they *become* the closed lid.

import type { OarLayer, OarRigEye, Vec2 } from "../model/types";
import { clamp, lerp, smoothstep01 } from "../geometry/util";
import { sampleContour, traceLowerEdge, douglasPeucker } from "../geometry/contour";
import type { PixelImage } from "../geometry/pixels";
import type { Mat2D } from "../geometry/mat2d";
import { apply as matApply } from "../geometry/mat2d";
import type { DriverParam } from "../model/params";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function layerRect(l: OarLayer): Rect {
  return { x: l.x, y: l.y, width: l.width, height: l.height };
}

/** Median-of-3 over a per-column trace's y values: a single-column spike
 *  (tear duct, ragged art) must not survive into the morph target. */
function smoothEdgeY(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const ys = [pts[i - 1]![1], pts[i]![1], pts[i + 1]![1]].sort((a, b) => a - b);
    out.push([pts[i]![0], ys[1]!]);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Derive the lid contour from the eye white's alpha: for each column, the
 *  lowest opaque pixel, median-smoothed and simplified to a polyline. Stored
 *  on the rig at import so the studio never needs the full-resolution
 *  artwork. */
export function deriveLidContour(
  whiteImg: PixelImage,
  offsetX: number,
  offsetY: number,
): Vec2[] {
  const edge = smoothEdgeY(traceLowerEdge(whiteImg, 8));
  const simplified = douglasPeucker(edge, 1.5);
  return simplified.map(([x, y]) => [x + offsetX, y + offsetY]);
}

/** Per-column lower edge of the top lash at rest (canvas space). Computed
 *  from the lash artwork at load; used to preserve lash thickness during the
 *  morph so the lash lands on the curve as a band, not a line. */
export function deriveLashLowerEdge(
  lashImg: PixelImage,
  offsetX: number,
  offsetY: number,
): Vec2[] {
  return smoothEdgeY(traceLowerEdge(lashImg, 8)).map(([x, y]) => [x + offsetX, y + offsetY]);
}

export interface WorkingLayer {
  layer: OarLayer;
  restVerts: Vec2[];
  positions: Vec2[];
  alpha: number;
}

export interface EyeRuntime {
  /** per-column lower edge of the top lash, canvas rest space */
  lashLower: Vec2[] | null;
}

function bbox(positions: Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of positions) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface SolveEyeOpts {
  /** 0..1 how far the closed-lash band flips past the lid contour: 0 = the
   *  lash covers the eye (top edge lands above the contour, thickness kept
   *  upward), 1 = fully inverted (band hangs below the contour). */
  invert?: number;
  /** Head local frame (pre = inverse head world matrix, post = head world
   *  matrix). When set, the lash morph is solved in the head's rest frame so
   *  the closed lash stays welded to the contour under head rotation. */
  frame?: { pre: Mat2D; post: Mat2D } | null;
}

/**
 * Solve one eye for the current frame. Mutates positions/alpha of the
 * working layers referenced by the rig.
 */
export function solveEye(
  rigEye: OarRigEye,
  runtime: EyeRuntime,
  working: Map<string, WorkingLayer>,
  open: number, // effective open 0..1 (blink floor already applied)
  gazeX: number,
  gazeY: number,
  opts: SolveEyeOpts = {},
): void {
  const invertAmt = opts.invert ?? 0;
  const frame = opts.frame ?? null;
  const shut = 1 - clamp(open);
  const white = rigEye.white ? working.get(rigEye.white) : undefined;
  const iris = rigEye.iris ? working.get(rigEye.iris) : undefined;
  const shine = rigEye.shine ? working.get(rigEye.shine) : undefined;
  const lash = rigEye.lashTop ? working.get(rigEye.lashTop) : undefined;
  const lashBottom = rigEye.lashBottom ? working.get(rigEye.lashBottom) : undefined;
  const closed = rigEye.closed ? working.get(rigEye.closed) : undefined;

  const whiteRest = rigEye.white
    ? (working.get(rigEye.white)?.layer ?? null)
    : null;

  // 1. Interior: squash toward a point 68% down the eye, fading out as the
  //    lid descends — fully visible above open≈0.75, gone below open≈0.3 so
  //    the iris never shows through under the landed lash.
  const interiorAlpha = clamp((open - 0.3) / 0.45);
  const squash = (wl: WorkingLayer) => {
    if (shut <= 0) return;
    const box = bbox(wl.positions);
    const py = box.y + box.height * 0.68;
    const scale = 1 - shut;
    for (const p of wl.positions) {
      p[1] = py + (p[1] - py) * scale;
    }
  };
  for (const wl of [white, iris, shine]) {
    if (!wl) continue;
    squash(wl);
    wl.alpha *= interiorAlpha;
  }

  // 2. Iris tracking: gaze × range, clamped to the room inside the white.
  //    The runtime stencil clip is the real out-of-bounds defence; this is
  //    belt-and-braces that keeps the iris off the lid line by 2px.
  if (iris && whiteRest) {
    const roomX = Math.max(0, (whiteRest.width - iris.layer.width) / 2 - 2);
    const roomY = Math.max(0, (whiteRest.height - iris.layer.height) / 2 - 2);
    // irisRange (traced/set at rig time) wins; the bbox room is the fallback.
    const rangeX = rigEye.irisRange[0] > 0 ? rigEye.irisRange[0] : roomX;
    const rangeY = rigEye.irisRange[1] > 0 ? rigEye.irisRange[1] : roomY;
    const dx = clamp(gazeX, -1, 1) * rangeX;
    const dy = clamp(gazeY, -1, 1) * -rangeY; // gaze up = canvas up
    for (const p of iris.positions) {
      p[0] += dx;
      p[1] += dy;
    }
    // Eye shine rides at ~62% of iris travel — the wet-eye look.
    if (shine) {
      for (const p of shine.positions) {
        p[0] += dx * 0.62;
        p[1] += dy * 0.62;
      }
    }
  }

  // 3. Upper lash morphs onto the lid contour.
  if (lash) {
    const k = smoothstep01(shut);
    if (k > 0) {
      const restBox = bbox(lash.restVerts);
      if (rigEye.lidContour.length >= 2 && runtime.lashLower && runtime.lashLower.length >= 2) {
        for (let i = 0; i < lash.positions.length; i++) {
          const [rx, ry] = lash.restVerts[i]!;
          const target = sampleContour(rigEye.lidContour, rx);
          const lower = sampleContour(runtime.lashLower, rx);
          if (target === null || lower === null) continue;
          const thickness = Math.max(0, lower - ry);
          const goalY = lerp(target - thickness, target + thickness, invertAmt);
          const dy = lerp(0, goalY - ry, k);
          if (frame) {
            // Solve in the head's rest frame so the closed lash stays welded
            // to the contour even when the head is rotated.
            const local = matApply(frame.pre, lash.positions[i]![0], lash.positions[i]![1]);
            const back = matApply(frame.post, local[0], local[1] + dy);
            lash.positions[i]![0] = back[0];
            lash.positions[i]![1] = back[1];
          } else {
            lash.positions[i]![1] += dy;
          }
        }
      } else {
        // Fallback: flatten toward the lash's own lower edge and travel down.
        const eyeH = whiteRest ? whiteRest.height : restBox.height;
        for (let i = 0; i < lash.positions.length; i++) {
          const [rx, ry] = lash.restVerts[i]!;
          const lower = runtime.lashLower ? sampleContour(runtime.lashLower, rx) : null;
          const lowerY = lower ?? restBox.y + restBox.height;
          const scaled = lowerY + (ry - lowerY) * (1 - shut * 0.82);
          lash.positions[i]![1] += scaled - ry + shut * eyeH * 0.55;
        }
      }
    }
    // Lashes stay fully opaque — they become the closed lid.
  }

  // Lower lid barely moves.
  if (lashBottom && shut > 0) {
    const box = bbox(lashBottom.positions);
    for (const p of lashBottom.positions) {
      p[1] -= shut * box.height * 0.15;
    }
  }

  // 4. Drawn closed artwork wins over any procedural approximation;
  //    cross-fade over the last 25% of the close so the swap is not a pop.
  if (closed) {
    const xfade = clamp((shut - 0.75) / 0.25);
    closed.alpha *= xfade;
    const remain = 1 - xfade;
    for (const wl of [white, iris, shine, lash, lashBottom]) {
      if (wl) wl.alpha *= remain;
    }
  }
}

/** Brow raise: simple vertical translation, up positive. */
export function solveBrow(
  layer: WorkingLayer,
  brow: number,
  rangePx: number,
): void {
  if (brow === 0) return;
  const dy = -clamp(brow, -1, 1) * rangePx;
  for (const p of layer.positions) p[1] += dy;
}

export type { DriverParam };
