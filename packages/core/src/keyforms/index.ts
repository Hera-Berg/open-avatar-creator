// Keyforms: Live2D-style parameter deformation. A layer's mesh is authored
// at a few key values of one parameter (eye closed at 0, open at 1, …) and
// the runtime interpolates linearly between the two keys either side of the
// current value — exactly what an artist sees when scrubbing the slider.
// Offsets live in REST space and apply before skinning, so a keyformed eye
// still rides the head bone, the turn warp and physics like any other layer.
// Several keyforms on one layer (different parameters) add their offsets and
// multiply their opacities.

import type { OarKeyform, OarKeyformKey, Vec2 } from "../model/types";
import { clamp } from "../geometry/util";

/** The two keys bracketing `value` and the blend between them. Outside the
 *  key range the nearest end key holds — a parameter never extrapolates. */
export function bracketKeys(
  keys: OarKeyformKey[],
  value: number,
): { a: OarKeyformKey; b: OarKeyformKey; t: number } | null {
  if (keys.length === 0) return null;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (keys.length === 1 || value <= first.value) return { a: first, b: first, t: 0 };
  if (value >= last.value) return { a: last, b: last, t: 0 };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (value <= b.value) {
      const span = b.value - a.value;
      return { a, b, t: span <= 0 ? 0 : (value - a.value) / span };
    }
  }
  return { a: last, b: last, t: 0 };
}

/** The keyform's full state at `value` — used to seed a new key so adding
 *  one mid-slider never pops the shape. */
export function interpolatedKey(kf: OarKeyform, value: number): OarKeyformKey {
  const br = bracketKeys(kf.keys, value);
  if (!br) return { value, offsets: {}, opacity: 1 };
  const offsets: Record<string, Vec2> = {};
  const idx = new Set([...Object.keys(br.a.offsets), ...Object.keys(br.b.offsets)]);
  for (const i of idx) {
    const oa = br.a.offsets[i] ?? [0, 0];
    const ob = br.b.offsets[i] ?? [0, 0];
    const o: Vec2 = [oa[0] + (ob[0] - oa[0]) * br.t, oa[1] + (ob[1] - oa[1]) * br.t];
    if (o[0] !== 0 || o[1] !== 0) offsets[i] = o;
  }
  return { value, offsets, opacity: br.a.opacity + (br.b.opacity - br.a.opacity) * br.t };
}

/** Insert or replace the key at `key.value`, keeping keys sorted. */
export function upsertKey(keys: OarKeyformKey[], key: OarKeyformKey): OarKeyformKey[] {
  const out = keys.filter((k) => Math.abs(k.value - key.value) > 1e-6);
  out.push(key);
  out.sort((x, y) => x.value - y.value);
  return out;
}

/** The key sitting at `value` (within slider precision), if any. */
export function keyIndexAt(kf: OarKeyform, value: number, eps = 0.005): number {
  return kf.keys.findIndex((k) => Math.abs(k.value - value) <= eps);
}

export interface KeyformResult {
  /** deformed rest vertices, or null when no keyform touched this layer */
  vertices: Vec2[] | null;
  opacity: number;
}

/** Apply every keyform targeting this layer to its rest vertices. */
export function applyKeyforms(
  keyforms: OarKeyform[],
  layerId: string,
  meshId: string | null,
  rest: Vec2[],
  params: Record<string, number>,
): KeyformResult {
  let vertices: Vec2[] | null = null;
  let opacity = 1;
  for (const kf of keyforms) {
    if (kf.layerId !== layerId || kf.meshId !== meshId) continue;
    const br = bracketKeys(kf.keys, params[kf.param] ?? 0);
    if (!br) continue;
    opacity *= clamp(br.a.opacity + (br.b.opacity - br.a.opacity) * br.t);
    const idx = new Set([...Object.keys(br.a.offsets), ...Object.keys(br.b.offsets)]);
    if (idx.size === 0) continue;
    if (!vertices) vertices = rest.map((v) => [v[0], v[1]] as Vec2);
    for (const i of idx) {
      const v = vertices[Number(i)];
      if (!v) continue;
      const oa = br.a.offsets[i] ?? [0, 0];
      const ob = br.b.offsets[i] ?? [0, 0];
      v[0] += oa[0] + (ob[0] - oa[0]) * br.t;
      v[1] += oa[1] + (ob[1] - oa[1]) * br.t;
    }
  }
  return { vertices, opacity };
}
