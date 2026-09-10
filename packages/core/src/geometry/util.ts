export function clamp(v: number, min = 0, max = 1): number {
  return v < min ? min : v > max ? max : v;
}

export function signedClamp(v: number): number {
  return clamp(v, -1, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ken Perlin's smoothstep on 0..1 input. */
export function smoothstep01(t: number): number {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
