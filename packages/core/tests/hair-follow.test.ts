import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { headTurnX } from "../src/headturn/warp";
import { emptyRig, type OarManifest } from "../src/model/types";
import { makeModel, makeLayer } from "./helpers";

/** Hair is attached to the head and takes the same cylinder warp as the
 *  eyes (hairWarpFollow = 1 by default); the blend below 1 exists only for
 *  rigs that want more volume, and parallax stays tightly clamped. */
describe("hair warp follow", () => {
  function build(params: Record<string, number> = {}): OarManifest {
    const rig = emptyRig();
    rig.head = { centre: [450, 300], radius: [150, 200] };
    const model = makeModel({
      layers: [
        makeLayer({ id: "l_head", name: "head", slot: "head", x: 300, y: 100, width: 300, height: 400, order: 5 }),
        makeLayer({ id: "l_hair", name: "hair-back-middle", slot: "hair_back", side: "middle", x: 250, y: 60, width: 400, height: 500, order: 1 }),
      ],
      rig,
    });
    model.params = params;
    return model;
  }

  const angle = (30 * Math.PI) / 180;
  const parallaxFor = (order: number) =>
    Math.max(-4, Math.min(4, order - 5)) * Math.sin(angle) * 3;

  it("by default hair takes the FULL warp, exactly like the face", () => {
    const model = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1 }, ctx);
    const hair = solved.layers.find((l) => l.id === "l_hair")!;
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const hairMesh = ctx.meshCache.get("l_hair")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    hairMesh.vertices.forEach(([rx], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      const expected = headTurnX(u, angle, 450, 150, 1) + parallaxFor(1);
      expect(hair.positions[i]![0]).toBeCloseTo(expected, 1);
    });
    // Same rest x → same warped x as the head (the weld, parallax aside).
    headMesh.vertices.forEach(([rx], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      expect(head.positions[i]![0]).toBeCloseTo(headTurnX(u, angle, 450, 150, 1), 1);
    });
  });

  it("hairWarpFollow below 1 blends toward rest for rigs that want volume", () => {
    const model = build({ hairWarpFollow: 0.6 });
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1 }, ctx);
    const hair = solved.layers.find((l) => l.id === "l_hair")!;
    const hairMesh = ctx.meshCache.get("l_hair")!;
    hairMesh.vertices.forEach(([rx], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      const full = headTurnX(u, angle, 450, 150, 1) - rx;
      expect(hair.positions[i]![0]).toBeCloseTo(rx + full * 0.6 + parallaxFor(1), 1);
    });
  });

  it("parallax is clamped to ±4 steps", () => {
    const model = build();
    // Give the hair an absurd order so the clamp is what matters.
    model.layers.find((l) => l.id === "l_hair")!.order = 100;
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1 }, ctx);
    const hair = solved.layers.find((l) => l.id === "l_hair")!;
    const hairMesh = ctx.meshCache.get("l_hair")!;
    const rx = hairMesh.vertices[0]![0];
    const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
    const expected = headTurnX(u, angle, 450, 150, 1) + 4 * Math.sin(angle) * 3;
    expect(hair.positions[0]![0]).toBeCloseTo(expected, 1);
  });
});
