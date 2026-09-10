// Head turn: warp head layers on a cylinder about the head's vertical axis.
// A parabolic depth profile (z = max(0, 1 − u²)) avoids the true cylinder's
// infinite slope at the silhouette — past ~26° a circular profile folds the
// far edge back over itself and the texture reverses. The `safe` clamp keeps
// the mapping monotonic at any angle.

export function headTurnX(
  u: number,
  angle: number,
  centreX: number,
  radius: number,
  bulge = 1,
): number {
  const z = Math.max(0, 1 - u * u);
  const sin = Math.sin(angle);
  const safe =
    Math.abs(sin) < 1e-6
      ? bulge
      : Math.min(bulge, (0.45 * Math.cos(angle)) / Math.abs(sin));
  return centreX + (u * Math.cos(angle) + z * sin * Math.max(0, safe)) * radius;
}

/** Test helper: the mapping must strictly increase across u at any angle. */
export function isMonotonic(
  angle: number,
  radius = 100,
  bulge = 1,
  from = -3,
  to = 3,
  steps = 600,
): boolean {
  let prev = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const u = from + ((to - from) * i) / steps;
    const x = headTurnX(u, angle, 0, radius, bulge);
    if (x <= prev) return false;
    prev = x;
  }
  return true;
}
