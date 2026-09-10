// Pose-space deformation: vertex offsets keyed to a pose, blended in as the
// model approaches it. Applied after skinning, in canvas space. Correctives
// sum; a two-parameter corrective multiplies the weights.

import type { OarCorrective, Vec2 } from "../model/types";
import { clamp } from "../geometry/util";
import { DRIVER_DEFAULTS, type DriverParam } from "../model/params";

/** The parameter a paused mesh edit should key to: the one furthest from its
 *  REST value (not from zero — eyes rest open at 1, so a closed eye must win
 *  over one still sitting at 1). Deterministic: first max wins ties. */
export function dominantParam(params: Record<DriverParam, number>): DriverParam {
  let key: DriverParam = "head_roll";
  let best = -1;
  for (const k of Object.keys(DRIVER_DEFAULTS) as DriverParam[]) {
    const d = Math.abs((params[k] ?? DRIVER_DEFAULTS[k]) - DRIVER_DEFAULTS[k]);
    if (d > best) {
      best = d;
      key = k;
    }
  }
  return key;
}

export function correctiveWeight(
  driver: OarCorrective["driver"],
  params: Record<DriverParam, number>,
): number {
  const current = params[driver.param as DriverParam] ?? 0;
  let w = weight1(current, driver.value, driver.falloff);
  if (driver.param2) {
    const current2 = params[driver.param2 as DriverParam] ?? 0;
    w *= weight1(current2, driver.value2, driver.falloff2);
  }
  return w;
}

function weight1(current: number, value: number, falloff: number): number {
  const d = Math.abs(current - value);
  const w = clamp(1 - d / Math.max(1e-6, falloff));
  return w * w * (3 - 2 * w);
}

export function applyCorrectives(
  correctives: OarCorrective[],
  meshId: string,
  positions: Vec2[],
  params: Record<DriverParam, number>,
): void {
  for (const corr of correctives) {
    if (corr.meshId !== meshId) continue;
    const w = correctiveWeight(corr.driver, params);
    if (w <= 0) continue;
    for (const [idxStr, offset] of Object.entries(corr.offsets)) {
      const idx = Number(idxStr);
      const p = positions[idx];
      if (!p) continue;
      p[0] += w * offset[0];
      p[1] += w * offset[1];
    }
  }
}

/** Guard rail: warn when a corrective's driver never reaches its keyed value
 *  within the parameter's range. */
export function correctiveUnreachable(
  driver: OarCorrective["driver"],
  ranges: Record<string, { min: number; max: number }>,
): boolean {
  const check = (param: string, value: number) => {
    const r = ranges[param];
    return r ? value < r.min || value > r.max : false;
  };
  if (check(driver.param, driver.value)) return true;
  if (driver.param2 && check(driver.param2, driver.value2)) return true;
  return false;
}
