// Minimal 2D affine matrices: [a, b, c, d, e, f] mapping
// x' = a*x + c*y + e ; y' = b*x + d*y + f.

import type { Vec2 } from "../model/types";

export type Mat2D = [number, number, number, number, number, number];

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function rotationAbout(pivot: Vec2, angle: number): Mat2D {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [px, py] = pivot;
  return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
}

export function translation(tx: number, ty: number): Mat2D {
  return [1, 0, 0, 1, tx, ty];
}

export function apply(m: Mat2D, x: number, y: number): Vec2 {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function rotationOf(m: Mat2D): number {
  return Math.atan2(m[1], m[0]);
}

/** Inverse of a rigid (rotation + translation) transform. */
export function invert(m: Mat2D): Mat2D {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const id = det === 0 ? 1 : 1 / det;
  return [
    (d * id),
    (-b * id),
    (-c * id),
    (a * id),
    (c * f - d * e) * id,
    (b * e - a * f) * id,
  ];
}
