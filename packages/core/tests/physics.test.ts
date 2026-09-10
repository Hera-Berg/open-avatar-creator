import { describe, it, expect } from "vitest";
import {
  createLayerPhysicsState,
  stepLayerPhysics,
  MAX_DT,
} from "../src/physics/spring";
import type { OarPhysics } from "../src/model/types";

const CFG: OarPhysics = {
  enabled: true,
  stiffness: 6,
  damping: 0.86,
  maxAngle: 16,
  inertia: 1,
  gravity: 0,
  pivot: "top",
  customPivot: null,
};

const GLOBALS = { bounce: 1, softness: 1, swayX: 1, swayY: 1, jiggle: 1 };

describe("physics", () => {
  it("clamps dt — a backgrounded tab does not detonate the model", () => {
    const state = createLayerPhysicsState();
    stepLayerPhysics(state, CFG, GLOBALS, 0, 0, 0, 1 / 60);
    // Simulate a 5-second backgrounded tab.
    const step = stepLayerPhysics(state, CFG, GLOBALS, 300, 0, 0, 5);
    expect(Number.isFinite(step.angle)).toBe(true);
    expect(Math.abs(step.angle)).toBeLessThanOrEqual(CFG.maxAngle * GLOBALS.bounce + 1e-6);
    expect(MAX_DT).toBeLessThanOrEqual(0.05);
  });

  it("flick-and-release: swings then settles, no explosion", () => {
    const state = createLayerPhysicsState();
    let pivotX = 0;
    const dt = 1 / 60;
    stepLayerPhysics(state, CFG, GLOBALS, pivotX, 0, 0, dt);
    // Flick: pivot moves fast for 6 frames.
    for (let i = 0; i < 6; i++) {
      pivotX += 40;
      stepLayerPhysics(state, CFG, GLOBALS, pivotX, 0, 0, dt);
    }
    // Release: pivot stops; the spring should swing then settle.
    let maxAfterRelease = 0;
    for (let i = 0; i < 60 * 5; i++) {
      const s = stepLayerPhysics(state, CFG, GLOBALS, pivotX, 0, 0, dt);
      maxAfterRelease = Math.max(maxAfterRelease, Math.abs(s.angle));
      expect(Number.isFinite(s.angle)).toBe(true);
    }
    expect(maxAfterRelease).toBeGreaterThan(0.5); // it actually swung
    const final = stepLayerPhysics(state, CFG, GLOBALS, pivotX, 0, 0, dt);
    expect(Math.abs(final.angle)).toBeLessThan(1); // and settled
  });

  it("jiggle scales energy retention: low jiggle dies fast", () => {
    const dead = createLayerPhysicsState();
    const lively = createLayerPhysicsState();
    const flick = (state: ReturnType<typeof createLayerPhysicsState>, jiggle: number) => {
      const g = { ...GLOBALS, jiggle };
      stepLayerPhysics(state, CFG, CFG, 0, 0, 0, 1 / 60);
      let px = 0;
      stepLayerPhysics(state, CFG, g, px, 0, 0, 1 / 60);
      for (let i = 0; i < 6; i++) {
        px += 40;
        stepLayerPhysics(state, CFG, g, px, 0, 0, 1 / 60);
      }
      return { g, px };
    };
    const d = flick(dead, 0.4);
    const l = flick(lively, 3.0);
    let energyDead = 0;
    let energyLively = 0;
    for (let i = 0; i < 90; i++) {
      energyDead += Math.abs(stepLayerPhysics(dead, CFG, d.g, d.px, 0, 0, 1 / 60).angle);
      energyLively += Math.abs(stepLayerPhysics(lively, CFG, l.g, l.px, 0, 0, 1 / 60).angle);
    }
    expect(energyLively).toBeGreaterThan(energyDead * 2);
  });
});
