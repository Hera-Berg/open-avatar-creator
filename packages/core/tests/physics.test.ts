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

describe("custom physics pivot", () => {
  it("rides the layer: a rest-space pivot moves with its nearest vertex", async () => {
    const { pivotOf } = await import("../src/solve");
    const layer = {
      id: "h", name: "h", path: [], src: "", x: 0, y: 0, width: 100, height: 100, opacity: 1,
      visible: true, order: 0, slot: "hair_back", side: null, boneId: null, mesh: null, clipTo: null,
      physics: {
        enabled: true, stiffness: 6, damping: 0.85, maxAngle: 12, inertia: 1, gravity: 0.5,
        pivot: "custom" as const, customPivot: [40, 10] as [number, number],
      },
    };
    const rest: [number, number][] = [[0, 0], [100, 0], [0, 100], [100, 100]];
    // The whole layer has moved 30px right and 12px down (head roll/turn).
    const moved = rest.map(([x, y]) => [x + 30, y + 12] as [number, number]);
    expect(pivotOf(layer, moved, rest)).toEqual({ x: 70, y: 22 });
    // At rest it is exactly where it was authored.
    expect(pivotOf(layer, rest, rest)).toEqual({ x: 40, y: 10 });
  });
});

describe("root-pinned sway", () => {
  const hairLayer = (pivot: "top" | "bottom" = "top") => ({
    id: "h", name: "h", path: [], src: "", x: 0, y: 0, width: 100, height: 200, opacity: 1,
    visible: true, order: 0, slot: "hair_back", side: null, boneId: null, mesh: null, clipTo: null,
    physics: {
      enabled: true, stiffness: 6, damping: 0.85, maxAngle: 16, inertia: 1, gravity: 0.5,
      pivot, customPivot: null,
    },
  });

  it("weights are 0 at the pinned end and 1 at the free end, and pin 0 is the rigid swing", async () => {
    const { swayWeights } = await import("../src/solve");
    const rest: [number, number][] = [[50, 0], [50, 100], [50, 200]];
    const top = swayWeights(hairLayer("top"), rest);
    expect(top[0]).toBe(0);
    expect(top[1]).toBeCloseTo(0.5, 6);
    expect(top[2]).toBe(1);
    const bottom = swayWeights(hairLayer("bottom"), rest);
    expect(bottom[2]).toBe(0);
    expect(bottom[0]).toBe(1);
    expect(swayWeights(hairLayer("top"), rest, 0)).toEqual([1, 1, 1]);
  });

  it("a sharp head move never swings the hair's roots off the scalp; the tips still sway", async () => {
    const { makeModel, makeLayer, makeSpine } = await import("./helpers");
    const { solveModel, createSolveContext } = await import("../src/solve");
    const spine = makeSpine();
    const headBone = spine[spine.length - 1]!;
    const run = (inertia: number) => {
      const layer = makeLayer({
        id: "hair", name: "hair-back", slot: "hair_back", x: 380, y: 100, width: 140, height: 400,
        boneId: headBone.id, order: 1,
        physics: { ...hairLayer().physics, inertia },
      });
      const model = makeModel({ bones: spine, layers: [layer] });
      const ctx = createSolveContext();
      const frames = [];
      for (let f = 0; f < 30; f++) {
        ctx.dt = 1 / 60;
        const k = Math.min(1, f / 3);
        frames.push(solveModel(model, { head_x: k, head_roll: k }, ctx).layers[0]!.positions.map((p) => [...p]));
      }
      return { frames, rest: ctx.meshCache.get("hair")!.vertices };
    };
    const live = run(1);
    const still = run(0); // same pose, no swing: where the head alone puts the hair
    let rootDrift = 0;
    let tipSway = 0;
    live.rest.forEach((v, i) => {
      for (let f = 0; f < live.frames.length; f++) {
        const d = Math.hypot(live.frames[f]![i]![0]! - still.frames[f]![i]![0]!, live.frames[f]![i]![1]! - still.frames[f]![i]![1]!);
        if (v[1] <= 100 + 1e-6) rootDrift = Math.max(rootDrift, d);
        if (v[1] >= 500 - 1e-6) tipSway = Math.max(tipSway, d);
      }
    });
    expect(rootDrift).toBeLessThan(0.5);
    expect(tipSway).toBeGreaterThan(5);
  });
});
