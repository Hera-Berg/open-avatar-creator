// Mouth: the inner mouth must be geometrically incapable of showing.
//
// An aperture mesh is built at import whose top boundary vertices ARE the
// upper lip's inner edge and whose bottom boundary vertices ARE the lower
// lip's inner edge. At rest the two edges coincide — zero area, nothing to
// draw, no threshold to tune. Lips deform (t² from the pinned outer edge),
// they do not slide. Real per-lip blendshapes drive the edges when present.

import type { OarMesh, OarLayer, Vec2 } from "../model/types";
import { clamp } from "../geometry/util";
// (clamp already imported above)
import { traceLowerEdge, traceUpperEdge, douglasPeucker, sampleContour } from "../geometry/contour";
import type { PixelImage } from "../geometry/pixels";
import type { Rect, WorkingLayer } from "./eyes";

export interface MouthShapes {
  jawOpen: number; // 0..1, mouth gain already applied
  upperUp: number; // 0..1 real upper-lip lift (blendshapes)
  lowerDown: number; // 0..1 real lower-lip drop
  pucker: number; // 0..1
  stretch: number; // 0..1
  smileL: number; // character's left = canvas right
  smileR: number;
  frown: number;
}

export function shapesFromBlendshapes(
  jawOpen: number,
  b: Record<string, number> | null,
  paramSmile: number,
  paramPucker: number,
): MouthShapes {
  const get = (k: string) => (b ? (b[k] ?? 0) : 0);
  const avg = (a: number, c: number) => (a + c) / 2;
  return {
    jawOpen,
    upperUp: avg(get("mouthUpperUpLeft"), get("mouthUpperUpRight")),
    lowerDown: avg(get("mouthLowerDownLeft"), get("mouthLowerDownRight")),
    pucker: Math.max(paramPucker, get("mouthPucker"), get("mouthFunnel")),
    stretch: avg(get("mouthStretchLeft"), get("mouthStretchRight")),
    smileL: Math.max(paramSmile, get("mouthSmileLeft")),
    smileR: Math.max(paramSmile, get("mouthSmileRight")),
    frown: avg(get("mouthFrownLeft"), get("mouthFrownRight")),
  };
}

/**
 * Build the aperture mesh from the traced inner edges of the two lips.
 * Top boundary = upper lip's inner edge; bottom = lower lip's inner edge;
 * the cavity texture maps across it. Returns null when either edge cannot be
 * traced (a lip drawn as a solid rectangle) — callers fall back to scaling.
 */
export function buildApertureMesh(
  id: string,
  upperImg: PixelImage,
  upperRect: Rect,
  lowerImg: PixelImage,
  lowerRect: Rect,
): OarMesh | null {
  // Trace at the VISIBLE outline (high alpha threshold): a threshold-8 trace
  // runs into faint lip tails and the aperture then reaches past the visible
  // lip outline — the corner needle. Geometry only; the artwork is untouched.
  const upperEdge = douglasPeucker(traceLowerEdge(upperImg, 96), 1.5).map(
    ([x, y]): Vec2 => [x + upperRect.x, y + upperRect.y],
  );
  const lowerEdge = douglasPeucker(traceUpperEdge(lowerImg, 96), 1.5).map(
    ([x, y]): Vec2 => [x + lowerRect.x, y + lowerRect.y],
  );
  if (upperEdge.length < 2 || lowerEdge.length < 2) {
    // Soft-edged lips (no solid outline): fall back to the permissive trace.
    const softUpper = douglasPeucker(traceLowerEdge(upperImg, 8), 1.5).map(
      ([x, y]): Vec2 => [x + upperRect.x, y + upperRect.y],
    );
    const softLower = douglasPeucker(traceUpperEdge(lowerImg, 8), 1.5).map(
      ([x, y]): Vec2 => [x + lowerRect.x, y + lowerRect.y],
    );
    if (softUpper.length < 2 || softLower.length < 2) return null;
    return buildFromEdges(id, softUpper, softLower);
  }
  return buildFromEdges(id, upperEdge, lowerEdge);
}

function buildFromEdges(
  id: string,
  upperEdge: Vec2[],
  lowerEdge: Vec2[],
): OarMesh | null {

  // Resample at a smooth density: the traced edges are simplified polylines,
  // so a handful of columns renders the mouth as chunky straight segments.
  // ~4px per column keeps the opening edge smooth.
  // Inset the span a touch inside the traced outline overlap.
  const minX = Math.max(upperEdge[0]![0], lowerEdge[0]![0]) + 1;
  const maxX = Math.min(upperEdge[upperEdge.length - 1]![0], lowerEdge[lowerEdge.length - 1]![0]) - 1;
  if (maxX - minX < 2) return null;
  const columns = clamp(Math.round((maxX - minX) / 4), 8, 32);
  const rows = 3; // top edge, mid, bottom edge

  const vertices: Vec2[] = [];
  const uvs: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    for (let c = 0; c < columns; c++) {
      const u = c / (columns - 1);
      const x = minX + u * (maxX - minX);
      let topY = sampleContour(upperEdge, x)!;
      let botY = sampleContour(lowerEdge, x)!;
      // Real lip artwork overlaps at rest (the upper lip is drawn over the
      // lower). A crossed boundary self-intersects the aperture and sheds
      // fragments — enforce per-column coincidence: the upper lip's edge
      // defines the closed mouth line.
      if (topY > botY) botY = topY;
      vertices.push([x, topY + (botY - topY) * v]);
      uvs.push([u, v]);
    }
  }
  const triangles: [number, number, number][] = [];
  const idx = (c: number, r: number) => r * columns + c;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = idx(c, r);
      const bq = idx(c + 1, r);
      const d = idx(c, r + 1);
      const e = idx(c + 1, r + 1);
      triangles.push([a, bq, d], [bq, e, d]);
    }
  }
  return { id, vertices, uvs, triangles, weights: vertices.map(() => ({})) };
}

export interface MouthDeformState {
  openUpper: number; // px travel at inner edge
  openLower: number;
  xScale: number; // horizontal narrowing/widening
  cornerLiftL: number; // px, character's left
  cornerLiftR: number;
  edgePucker: number; // 0..1 — multiplies opening by (1 − 0.75u²)
  shiftX: number; // mouth_x horizontal shift, px
  cx: number; // mouth horizontal centre
  widthScale: number; // >1 confines the opening to the middle of the lips
  cornerEnd: number; // corner step-down end (u) — opening fully closed by here
}

export function computeMouthDeform(
  shapes: MouthShapes,
  rangeUpper: number,
  rangeLower: number,
  cx: number,
  mouthX: number,
  widthScale = 1,
  cornerEnd = 0.75,
): MouthDeformState {
  const openUpper = Math.max(shapes.upperUp, shapes.jawOpen * 0.32) * rangeUpper;
  const openLower = Math.max(shapes.lowerDown, shapes.jawOpen * 0.68) * rangeLower;
  const xScale = 1 - shapes.pucker * 0.34 + shapes.stretch * 0.22;
  const cornerRange = (rangeUpper + rangeLower) / 2;
  return {
    openUpper,
    openLower,
    xScale,
    cornerLiftL: (shapes.smileL - shapes.frown) * cornerRange * 0.5,
    cornerLiftR: (shapes.smileR - shapes.frown) * cornerRange * 0.5,
    edgePucker: shapes.pucker,
    shiftX: clamp(mouthX, -1, 1) * cornerRange * 0.25,
    cx: cx + clamp(mouthX, -1, 1) * cornerRange * 0.25,
    widthScale,
    cornerEnd,
  };
}

/**
 * Deform one point of a lip (or of the aperture's boundary). `side` selects
 * which lip formula applies; `t` overrides the relative position for
 * aperture boundary verts (which sit exactly at t = 1).
 */
export function deformMouthPoint(
  x: number,
  y: number,
  rect: Rect,
  side: "upper" | "lower",
  state: MouthDeformState,
  tOverride?: number,
): Vec2 {
  const halfW = Math.max(1, rect.width / 2);
  const u = clamp((x - state.cx) / halfW, -1, 1);
  let t: number;
  if (tOverride !== undefined) {
    t = tOverride;
  } else if (side === "upper") {
    t = clamp((y - rect.y) / Math.max(1, rect.height)); // 0 outer, 1 inner
  } else {
    t = clamp((rect.y + rect.height - y) / Math.max(1, rect.height));
  }
  const t2 = t * t;
  const edgeMul = 1 - state.edgePucker * 0.75 * u * u;
  // A mouth opens elliptically: full at the centre, closed at the corners.
  // widthScale > 1 confines the opening to the middle of the lips instead
  // of letting it reach the lip frame edges at high openness.
  const uE = clamp(u * state.widthScale, -1, 1);
  const openShape = Math.sqrt(Math.max(0, 1 - uE * uE));
  const open = side === "upper" ? state.openUpper : state.openLower;
  const dir = side === "upper" ? -1 : 1;
  const cornerLift = u > 0 ? state.cornerLiftL : state.cornerLiftR;
  const nx = state.cx + (x - state.cx) * state.xScale;
  const ny = y + dir * t2 * open * edgeMul * openShape - cornerLift * u * u;
  return [nx, ny];
}

/** Apply mouth deformation to a lip layer's working positions. */
export function deformLipLayer(
  wl: WorkingLayer,
  side: "upper" | "lower",
  state: MouthDeformState,
): void {
  const rect: Rect = {
    x: wl.layer.x,
    y: wl.layer.y,
    width: wl.layer.width,
    height: wl.layer.height,
  };
  for (let i = 0; i < wl.positions.length; i++) {
    const [rx, ry] = wl.restVerts[i]!;
    const cur = wl.positions[i]!;
    const [nx, ny] = deformMouthPoint(rx, ry, rect, side, state);
    cur[0] += nx - rx;
    cur[1] += ny - ry;
  }
}

/**
 * Deform the aperture mesh. Boundary verts are treated as lip inner-edge
 * points (t = 1) so the aperture stays welded to the lips by construction;
 * interior rows blend. Row membership is structural: buildApertureMesh
 * emits a rows × columns grid in order, and UVs stay free for texturing.
 */
export const APERTURE_ROWS = 3;

export function deformAperture(
  positions: Vec2[],
  restVerts: Vec2[],
  rows: number,
  upperRect: Rect,
  lowerRect: Rect,
  state: MouthDeformState,
): void {
  const columns = Math.max(2, Math.round(positions.length / rows));
  // The cavity must open INSIDE the lip frame: an extra corner taper (total
  // corner falloff (1−u²) vs the lips' √(1−u²)) computed against the
  // aperture's own span, so it closes exactly at its ends and can never
  // streak past the visible lip outline.
  let spanMin = Infinity;
  let spanMax = -Infinity;
  for (const [x] of restVerts) {
    if (x < spanMin) spanMin = x;
    if (x > spanMax) spanMax = x;
  }
  const spanMid = (spanMin + spanMax) / 2;
  const spanHalf = Math.max(1, (spanMax - spanMin) / 2);
  const cornerPin = (x: number) => {
    const u = Math.abs(clamp((x - spanMid) / spanHalf, -1, 1));
    // Full opening through the middle, stepping down to fully closed by
    // state.cornerEnd (user-tunable "corner length").
    const start = Math.max(0, state.cornerEnd - 0.25);
    const t = clamp((u - start) / Math.max(0.05, state.cornerEnd - start));
    const s = t * t * (3 - 2 * t);
    return 1 - s;
  };
  for (let i = 0; i < positions.length; i++) {
    const [rx, ry] = restVerts[i]!;
    const row = Math.min(rows - 1, Math.floor(i / columns));
    const v = row / (rows - 1);
    const pin = cornerPin(rx);
    if (v <= 0.001) {
      const [nx, ny] = deformMouthPoint(rx, ry, upperRect, "upper", state, 1);
      positions[i]![0] += nx - rx;
      positions[i]![1] += (ny - ry) * pin;
    } else if (v >= 0.999) {
      const [nx, ny] = deformMouthPoint(rx, ry, lowerRect, "lower", state, 1);
      positions[i]![0] += nx - rx;
      positions[i]![1] += (ny - ry) * pin;
    } else {
      const [ux, uy] = deformMouthPoint(rx, ry, upperRect, "upper", state, 1);
      const [lx, ly] = deformMouthPoint(rx, ry, lowerRect, "lower", state, 1);
      positions[i]![0] += (ux + (lx - ux) * v) - rx;
      positions[i]![1] += ((uy + (ly - uy) * v) - ry) * pin;
    }
  }
}

/** Fallback when lip inner edges cannot be traced: scale the cavity about
 *  the point where the lips meet. */
export function scaleCavityFallback(
  wl: WorkingLayer,
  mouthCentreY: number,
  openness: number,
): void {
  const scale = Math.max(0.02, openness);
  for (const p of wl.positions) {
    p[1] = mouthCentreY + (p[1] - mouthCentreY) * scale;
  }
}

/** Polygon area of a closed boundary loop — the zero-area-at-rest check. */
export function apertureArea(positions: Vec2[], rows: number): number {
  const columns = Math.max(2, Math.round(positions.length / rows));
  const top = positions.slice(0, columns);
  const bottom = positions.slice((rows - 1) * columns, rows * columns).reverse();
  const loop = top.concat(bottom);
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]!;
    const [x2, y2] = loop[(i + 1) % loop.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function layerRectOf(l: OarLayer): Rect {
  return { x: l.x, y: l.y, width: l.width, height: l.height };
}
