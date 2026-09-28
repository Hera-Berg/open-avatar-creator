import { RIG_PARAM_DEFAULTS } from "../src/model/params";
import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { faceInterior, headTurnX } from "../src/headturn/warp";
import { emptyRig, type OarManifest } from "../src/model/types";
import { makeModel, makeLayer } from "./helpers";

/** Hair is attached to the head and takes the same cylinder warp as the
 *  eyes (hairWarpFollow = 1 by default); the blend below 1 exists only for
 *  rigs that want more volume, and parallax stays tightly clamped — and only
 *  over the face: at the silhouette hair moves with the skull. */
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
  /** Parallax at a (warped) point: the order step, scaled by how far inside
   *  the face the point lies — zero at the silhouette. */
  const parallaxFor = (order: number, x: number, ry: number) =>
    Math.max(-4, Math.min(4, order - 5)) * Math.sin(angle) * 3 *
    faceInterior((x - 450) / 150, (ry - 300) / 200);

  it("by default hair takes the FULL warp, exactly like the face", () => {
    const model = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1 }, ctx);
    const hair = solved.layers.find((l) => l.id === "l_hair")!;
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const hairMesh = ctx.meshCache.get("l_hair")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    hairMesh.vertices.forEach(([rx, ry], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      const warped = headTurnX(u, angle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth);
      expect(hair.positions[i]![0]).toBeCloseTo(warped + parallaxFor(1, warped, ry), 1);
    });
    // Same rest x → same warped x as the head (the weld, parallax aside).
    headMesh.vertices.forEach(([rx], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      expect(head.positions[i]![0]).toBeCloseTo(headTurnX(u, angle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth), 1);
    });
  });

  it("hairWarpFollow below 1 blends toward rest for rigs that want volume", () => {
    const model = build({ hairWarpFollow: 0.6 });
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1 }, ctx);
    const hair = solved.layers.find((l) => l.id === "l_hair")!;
    const hairMesh = ctx.meshCache.get("l_hair")!;
    hairMesh.vertices.forEach(([rx, ry], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      const full = headTurnX(u, angle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth) - rx;
      const blended = rx + full * 0.6;
      expect(hair.positions[i]![0]).toBeCloseTo(blended + parallaxFor(1, blended, ry), 1);
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
    // The vertex nearest the face centre, where the parallax is (near) full.
    let i = 0;
    hairMesh.vertices.forEach(([x, y], k) => {
      const [bx, by] = hairMesh.vertices[i]!;
      if (Math.hypot(x - 450, y - 300) < Math.hypot(bx - 450, by - 300)) i = k;
    });
    const [rx, ry] = hairMesh.vertices[i]!;
    const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
    const warped = headTurnX(u, angle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth);
    const expected = warped + 4 * Math.sin(angle) * 3 * faceInterior((warped - 450) / 150, (ry - 300) / 200);
    expect(hair.positions[i]![0]).toBeCloseTo(expected, 1);
  });

  it("at the silhouette hair takes NO parallax: the outline never separates on a turn", () => {
    // A whole-layer slide pushed back hair out past the outline on the far
    // side (a hidden panel poking out) and pulled side locks off the near side.
    for (const yaw of [-1, 1]) {
      const model = build();
      const ctx = createSolveContext();
      const solved = solveModel(model, { head_yaw: yaw }, ctx);
      const hair = solved.layers.find((l) => l.id === "l_hair")!;
      const hairMesh = ctx.meshCache.get("l_hair")!;
      let outer = 0;
      hairMesh.vertices.forEach(([rx, ry], i) => {
        const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
        const warped = headTurnX(u, yaw * angle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth);
        if (Math.hypot((warped - 450) / 150, (ry - 300) / 200) < 1.3) return;
        outer++;
        expect(hair.positions[i]![0]).toBeCloseTo(warped, 6);
      });
      expect(outer).toBeGreaterThan(4);
    }
  });
});
