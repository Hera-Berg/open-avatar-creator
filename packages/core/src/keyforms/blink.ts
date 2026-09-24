// Blink as keyforms — the Live2D eye setup, generated as ordinary editable
// data rather than hidden runtime code:
//
//   upper lash  closed key: bends down onto the lid contour traced from the
//               eye white's lower edge, keeping its thickness (so the ends
//               barely move and the middle drops — the lid arc).
//   eye white   closed key: every vertex folds down onto that same curve, so
//               the white's top edge rides just under the descending lash.
//   iris/shine  no keyform: they keep their size and are stencil-clipped to
//               the white, so the lid COVERS them instead of shrinking them.
//   lower lash  closed key: rises a little to meet the lid.
//   closed art  (optional) cross-fades in over the last quarter of the close.
//
// Between keys the runtime interpolates linearly; the artist refines any key
// (or adds a half-blink key) with the same vertex tools as any mesh.

import type { OarKeyform, OarKeyformKey, OarLayer, OarMesh, OarRigEye, Vec2 } from "../model/types";
import { newId } from "../model/ids";
import { lerp } from "../geometry/util";
import { sampleContour } from "../geometry/contour";
import { interpolatedKey } from "./index";

export interface BlinkInput {
  eye: OarRigEye;
  /** driver parameter that opens this eye: "eye_l_open" / "eye_r_open" */
  param: string;
  layers: Map<string, OarLayer>;
  meshes: Map<string, OarMesh>;
  /** per-column lower edge of the top lash (canvas rest space), if traced */
  lashLower: Vec2[] | null;
  /** 0 = closed lash band covers the eye, 1 = band hangs below the curve */
  invert: number;
}

/** Share of the close over which drawn closed-eye art cross-fades in. */
const CLOSED_XFADE = 0.25;
/** How much of the white's lower-edge curvature the closed line keeps. The
 *  traced edge is a deep U; a closed anime eye is a gentle arc. */
const CLOSED_CURVE = 0.5;
/** Closed lash band thickness as a share of the open lash's. */
const CLOSED_THICKNESS = 0.6;
/** The lash's in-between key: the lid is (1 − LID_MID) of the way down with
 *  the lash still full-thickness and upright. Without it the two-key blend
 *  flips the band through zero thickness mid-blink — a hairline lash over a
 *  half-covered iris. With it the flip happens only in the last stretch. */
const LID_MID = 0.35;

type OffsetFn = (v: Vec2) => Vec2 | null;

function offsetsFor(mesh: OarMesh, fn: OffsetFn): Record<string, Vec2> {
  const out: Record<string, Vec2> = {};
  mesh.vertices.forEach((v, i) => {
    const o = fn(v);
    if (o && (Math.abs(o[0]) > 1e-4 || Math.abs(o[1]) > 1e-4)) out[String(i)] = o;
  });
  return out;
}

/** Keys for a deforming eye part: fully deformed at 0, optional in-between
 *  shape at LID_MID, open at 1. With drawn closed art the part also fades out
 *  over the last CLOSED_XFADE (its key starts from the interpolated shape). */
function partKeys(
  closed: Record<string, Vec2>,
  mid: Record<string, Vec2> | null,
  hasClosedArt: boolean,
): OarKeyformKey[] {
  const keys: OarKeyformKey[] = [{ value: 0, offsets: closed, opacity: 1 }];
  if (mid) keys.push({ value: LID_MID, offsets: mid, opacity: 1 });
  keys.push({ value: 1, offsets: {}, opacity: 1 });
  if (!hasClosedArt) return keys;
  const kf = { id: "", name: "", layerId: "", meshId: "", param: "", keys };
  const fade = interpolatedKey(kf, CLOSED_XFADE);
  keys[0] = { ...keys[0]!, opacity: 0 };
  return [...keys, { ...fade, opacity: 1 }].sort((a, b) => a.value - b.value);
}

export function buildBlinkKeyforms(input: BlinkInput): OarKeyform[] {
  const { eye, param, layers, meshes, invert } = input;
  const meshed = (id: string | null) => {
    const layer = id ? layers.get(id) : undefined;
    const mesh = layer?.mesh ? meshes.get(layer.mesh) : undefined;
    return layer && mesh ? { layer, mesh } : null;
  };
  const white = eye.white ? layers.get(eye.white) ?? null : null;
  const lash = meshed(eye.lashTop);
  const contour = eye.lidContour.length >= 2 ? eye.lidContour : null;
  const lashLower =
    input.lashLower && input.lashLower.length >= 2 ? input.lashLower : null;

  // Where the lid line lands when shut, per column: the traced lower edge,
  // flattened toward the straight line between its corners.
  const lidAt = (x: number): number => {
    if (contour) {
      const [x0, y0] = contour[0]!;
      const [x1, y1] = contour[contour.length - 1]!;
      const t = x1 === x0 ? 0 : Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
      const chord = y0 + (y1 - y0) * t;
      return chord + (sampleContour(contour, x)! - chord) * CLOSED_CURVE;
    }
    if (white) return white.y + white.height * 0.85;
    const l = lash?.layer;
    return l ? l.y + l.height * 1.8 : 0;
  };
  // The lash's lower edge at rest, per column.
  const lashLowerAt = (x: number): number => {
    if (lashLower) return sampleContour(lashLower, x)!;
    const l = lash?.layer;
    return l ? l.y + l.height : 0;
  };

  // Callers mesh every eye layer first (ensureEyeMeshes in the creator); a
  // closed-art layer without a mesh cannot carry its fade key.
  const hasClosedArt = !!meshed(eye.closed);
  const out: OarKeyform[] = [];
  const push = (layer: OarLayer, mesh: OarMesh, keys: OarKeyformKey[]) => {
    out.push({ id: newId("k"), name: `${layer.name} blink`, layerId: layer.id, meshId: mesh.id, param, keys });
  };

  // Upper lash: land the lower edge on the lid line as a thinner band — above
  // it (invert 0, a heavy lid) or flipped below it (invert 1, the default:
  // lashes hang down like drawn closed eyes).
  if (lash) {
    const closed = offsetsFor(lash.mesh, ([x, y]) => {
      const target = lidAt(x);
      const thickness = Math.max(0, lashLowerAt(x) - y) * CLOSED_THICKNESS;
      const goal = lerp(target - thickness, target + thickness, invert);
      return [0, goal - y];
    });
    // In-between: the whole band slides (1 − LID_MID) of the way down,
    // shape and thickness unchanged — a lid mid-descent.
    const mid = offsetsFor(lash.mesh, ([x]) => [0, (1 - LID_MID) * (lidAt(x) - lashLowerAt(x))]);
    push(lash.layer, lash.mesh, partKeys(closed, mid, hasClosedArt));
  }

  // Eye white: the whole mesh folds onto the lid line — rows above it come
  // down, the transparent margin below it comes up. Collapsing only the rows
  // above would leave the row straddling the line stretching opaque white
  // (and the iris clipped to it) into a sliver under the closed lash. Every
  // vertex moves monotonically toward the same line, so rows never cross.
  const whiteM = meshed(eye.white);
  if (whiteM) {
    const closed = offsetsFor(whiteM.mesh, ([x, y]) => [0, lidAt(x) - y]);
    push(whiteM.layer, whiteM.mesh, partKeys(closed, null, hasClosedArt));
  }

  // Lower lash: a small rise to meet the lid.
  const lower = meshed(eye.lashBottom);
  if (lower) {
    const rise = -lower.layer.height * 0.15;
    const closed = offsetsFor(lower.mesh, () => [0, rise]);
    push(lower.layer, lower.mesh, partKeys(closed, null, hasClosedArt));
  }

  // Drawn closed-eye art: invisible until the last quarter, then fades in.
  const closedArt = meshed(eye.closed);
  if (closedArt) {
    push(closedArt.layer, closedArt.mesh, [
      { value: 0, offsets: {}, opacity: 1 },
      { value: CLOSED_XFADE, offsets: {}, opacity: 0 },
    ]);
  }
  return out;
}

/** Layer ids a blink keyform set for this eye may target. */
export function blinkLayerIds(eye: OarRigEye): string[] {
  return [eye.white, eye.lashTop, eye.lashBottom, eye.closed, eye.iris, eye.shine].filter(
    (x): x is string => !!x,
  );
}
