// Head turn: the Live2D face-turn warp, applied along one axis (x for yaw,
// y for pitch) in the head's local frame.
//
// A true cylinder/parabola projection is the wrong model for 2D art: it
// narrows the whole head by cos θ and scales the near side ~1.6× against the
// far side ~0.3× (the far eye crushes, the near eye balloons, the chin slides
// into the hair). A Live2D face turn keeps the head's size and instead slides
// the features toward the turn with a gentle, nearly linear change in scale
// across the face. That is this warp:
//
//   x' = centre + (u + depth · sin θ · g(u)) · radius
//   g(u) = (1 − (u/W)²)²   for |u| < W, else 0        (W = 3 face radii)
//
// g is a smooth, WIDE bump: across the face and the hair framing it the
// displacement is nearly uniform, so eyes, face outline and side locks move
// together (a narrower bump slides the far eye into the cheek line and under
// the side hair). Its slope is gentle and nearly linear inside the face (near
// side widens, far side narrows by the same small amount), and it reaches
// zero with zero slope at 3 radii — hair bends smoothly, never kinks. The
// depth is clamped so the local scale never drops below MIN_SCALE: the
// mapping is always monotonic and the texture never folds, at any angle.

/** Support half-width of the bump, in face radii. */
export const TURN_SUPPORT = 3;
/** max |g'(u)|: 8 / (3√3 · W). */
const G_SLOPE_MAX = 8 / (3 * Math.sqrt(3) * TURN_SUPPORT);
/** The far side is never compressed below this share of its rest size. */
const MIN_SCALE = 0.35;

export function turnBump(u: number): number {
  const t = u / TURN_SUPPORT;
  if (t <= -1 || t >= 1) return 0;
  const s = 1 - t * t;
  return s * s;
}

/** The depth actually applied: `depth`, capped so the warp stays monotonic. */
export function safeTurnDepth(angle: number, depth: number): number {
  const sin = Math.abs(Math.sin(angle));
  if (sin < 1e-9) return depth;
  return Math.max(0, Math.min(depth, (1 - MIN_SCALE) / (sin * G_SLOPE_MAX)));
}

export function headTurnX(
  u: number,
  angle: number,
  centreX: number,
  radius: number,
  depth = 0.8,
): number {
  const d = safeTurnDepth(angle, depth);
  return centreX + (u + d * Math.sin(angle) * turnBump(u)) * radius;
}

// Head pitch: the nod. A near-uniform vertical slide (the yaw bump applied to
// y) reads as the face pasted on and dragged up and down — nothing
// foreshortens. A head nodding forward is a sphere rotating: the front of the
// face (eyes, nose, mouth) travels furthest, the silhouette (crown, chin,
// cheek outline) barely moves. So the pitch displacement is sampled from a
// face SURFACE over both axes, on top of a rigid skull:
//
//   y' = centre + (v + depth · sin φ · s(u, v)) · radius
//   s(u, v) = F + (1 − F) · (1 − r²/P²)²   r² = u² + v² < P², else F
//
// F is the SKULL: everything attached to the head — hair, ears, crown,
// outline — travels by the same F share, so hair moves as one piece with the
// head (a surface that decays to zero leaves hair tips and crown behind while
// the face moves, stretching every strand). The face front travels further
// on top of that: nodding down, the features drop past the outline, the
// lower face compresses and more crown shows — the Live2D look-down. The
// bump reaches the floor with zero slope, so nothing kinks at the outline.
// Bang tips at eye level travel with the eyes (no swallowing); the head keeps
// its height (s is symmetric in v). The depth is capped exactly like the yaw
// warp so the map never folds along v.

/** Radius (face radii) where the face bump has settled onto the skull. */
export const PITCH_SUPPORT = 1.3;
/** Skull share of the face-front travel — hair, ears and outline. */
export const PITCH_SKULL = 0.4;
/** max |∂s/∂v|: (1 − F) · 8 / (3√3 · P), reached on the u = 0 column. */
const S_SLOPE_MAX = ((1 - PITCH_SKULL) * 8) / (3 * Math.sqrt(3) * PITCH_SUPPORT);

/** The face interior: 1 at the head centre, easing to 0 (zero slope) by
 *  PITCH_SUPPORT radii — just past the outline. Motion scaled by it happens
 *  over the face and never at the silhouette. */
export function faceInterior(u: number, v: number): number {
  const r2 = (u * u + v * v) / (PITCH_SUPPORT * PITCH_SUPPORT);
  if (r2 >= 1) return 0;
  const s = 1 - r2;
  return s * s;
}

export function pitchSurface(u: number, v: number): number {
  return PITCH_SKULL + (1 - PITCH_SKULL) * faceInterior(u, v);
}

/** The pitch depth actually applied: `depth`, capped so the nod stays
 *  monotonic along v at every u. */
export function safePitchDepth(angle: number, depth: number): number {
  const sin = Math.abs(Math.sin(angle));
  if (sin < 1e-9) return depth;
  return Math.max(0, Math.min(depth, (1 - MIN_SCALE) / (sin * S_SLOPE_MAX)));
}

/** Vertical nod of the point (u, v) (face radii from the head centre). */
export function headPitchY(
  u: number,
  v: number,
  angle: number,
  centreY: number,
  radius: number,
  depth = 1.5,
): number {
  const d = safePitchDepth(angle, depth);
  return centreY + (v + d * Math.sin(angle) * pitchSurface(u, v)) * radius;
}

/** Test helper: the mapping must strictly increase across u at any angle. */
export function isMonotonic(
  angle: number,
  radius = 100,
  depth = 0.8,
  from = -3,
  to = 3,
  steps = 600,
): boolean {
  let prev = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const u = from + ((to - from) * i) / steps;
    const x = headTurnX(u, angle, 0, radius, depth);
    if (x <= prev) return false;
    prev = x;
  }
  return true;
}
