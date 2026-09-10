// Per-layer physics: a spring that chases a target derived from how fast the
// pivot is moving — stable at any frame rate and safe on dropped frames.
// Sway (how far it throws) and jiggle (how long it rings) are separate.
// dt is clamped to 50ms so a backgrounded tab does not detonate the model.

import type { OarPhysics } from "../model/types";
import { clamp } from "../geometry/util";

export const MAX_DT = 0.05;

export interface PhysicsGlobals {
  bounce: number;
  softness: number;
  swayX: number; // family axis scale
  swayY: number;
  jiggle: number; // energy retention multiplier
}

export class Spring {
  value = 0;
  velocity = 0;

  /**
   * @param target    where the spring wants to be, degrees (or px for vertical)
   * @param cfg       layer physics config
   * @param globals   resolved family globals
   * @param dt        seconds (already clamped)
   * @param maxValue  clamp, degrees or px
   */
  update(
    target: number,
    cfg: OarPhysics,
    globals: PhysicsGlobals,
    dt: number,
    maxValue: number,
  ): number {
    const stiffness = cfg.stiffness / Math.max(0.05, globals.softness);
    this.velocity += (target - this.value) * stiffness * dt;
    // damping ^ (dt × 60): jiggle scales energy retention
    const damping = clamp(cfg.damping * globals.jiggle, 0, 0.995);
    this.velocity *= Math.pow(damping, dt * 60);
    this.value += this.velocity * dt;
    this.value = clamp(this.value, -maxValue, maxValue);
    return this.value;
  }
}

export interface LayerPhysicsState {
  rotation: Spring; // degrees
  vertical: Spring; // px — follow-through on a bounce
  lastPivotX: number;
  lastPivotY: number;
  initialised: boolean;
}

export function createLayerPhysicsState(): LayerPhysicsState {
  return {
    rotation: new Spring(),
    vertical: new Spring(),
    lastPivotX: 0,
    lastPivotY: 0,
    initialised: false,
  };
}

export interface PhysicsStep {
  angle: number; // degrees
  offsetY: number; // px
}

/**
 * Advance a layer's physics by one frame.
 * @param pivotX/pivotY current pivot position in canvas space (post-skinning,
 *                      pre-physics) — its velocity is the drive.
 */
export function stepLayerPhysics(
  state: LayerPhysicsState,
  cfg: OarPhysics,
  globals: PhysicsGlobals,
  pivotX: number,
  pivotY: number,
  leanDeg: number,
  dtRaw: number,
): PhysicsStep {
  const dt = Math.min(MAX_DT, Math.max(1e-4, dtRaw));
  if (!state.initialised) {
    state.lastPivotX = pivotX;
    state.lastPivotY = pivotY;
    state.initialised = true;
    return { angle: 0, offsetY: 0 };
  }
  // Pivot velocity in px/s, normalised so ~500px/s is a hard shake.
  const vx = (pivotX - state.lastPivotX) / dt;
  const vy = (pivotY - state.lastPivotY) / dt;
  state.lastPivotX = pivotX;
  state.lastPivotY = pivotY;
  const driveX = clamp(vx / 500, -1.5, 1.5);
  const driveY = clamp(vy / 500, -1.5, 1.5);

  // target = (−drive × inertia × 90 + lean × gravity × 40) × bounce × axisScale
  const targetAngle =
    (-driveX * cfg.inertia * 90 + leanDeg * cfg.gravity * 0.4) *
    globals.bounce *
    globals.swayX;
  const targetY =
    (-driveY * cfg.inertia * 90 * 0.5 + leanDeg * cfg.gravity * 0.4) *
    globals.bounce *
    globals.swayY;

  const maxAngle = cfg.maxAngle * globals.bounce;
  const angle = state.rotation.update(targetAngle, cfg, globals, dt, maxAngle);
  const offsetY = state.vertical.update(
    targetY * 0.5,
    cfg,
    globals,
    dt,
    Math.max(4, maxAngle * 0.75),
  );
  return { angle, offsetY };
}
