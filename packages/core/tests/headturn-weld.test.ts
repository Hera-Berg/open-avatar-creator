import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { headTurnX } from "../src/headturn/warp";
import { emptyRig, type OarManifest } from "../src/model/types";
import { makeModel, makeLayer } from "./helpers";

/** Face features sit ON the face: at full yaw the cylinder warp moves the
 *  head layer and the feature layers by the same position-only map, so they
 *  stay welded. Parallax applies to hair only. */
describe("head-turn welding", () => {
  function build(): OarManifest {
    const rig = emptyRig();
    rig.head = { centre: [450, 300], radius: [150, 200] };
    return makeModel({
      layers: [
        makeLayer({ id: "l_head", name: "head", slot: "head", x: 300, y: 100, width: 300, height: 400, order: 5 }),
        makeLayer({ id: "l_eye", name: "eye-white-left", slot: "eye_white", side: "left", x: 400, y: 250, width: 60, height: 30, order: 8 }),
        makeLayer({ id: "l_lip", name: "top-lip", slot: "lip_upper", x: 410, y: 350, width: 60, height: 20, order: 9 }),
        makeLayer({ id: "l_bangs", name: "hair-front-middle", slot: "hair_front", side: "middle", x: 320, y: 90, width: 280, height: 180, order: 12 }),
      ],
      rig,
    });
  }

  function solvedAt(yaw: number) {
    const model = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: yaw }, ctx);
    return { model, solved, ctx };
  }

  it("features weld to the head: same rest x → same solved x at full yaw", () => {
    const { solved, ctx } = solvedAt(1);
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const eye = solved.layers.find((l) => l.id === "l_eye")!;
    const lip = solved.layers.find((l) => l.id === "l_lip")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    const eyeMesh = ctx.meshCache.get("l_eye")!;
    const lipMesh = ctx.meshCache.get("l_lip")!;

    // The weld: head layer and feature layers must satisfy the SAME
    // position-only warp map. yaw = 1 × 30° = 0.5236 rad.
    const angle = (30 * Math.PI) / 180;
    const expected = (rx: number) => headTurnX((rx - 450) / 150, angle, 450, 150, 1);
    const checkLayer = (
      mesh: { vertices: [number, number][] },
      solvedLayer: { positions: [number, number][] },
    ) => {
      mesh.vertices.forEach(([rx], i) => {
        expect(solvedLayer.positions[i]![0]).toBeCloseTo(expected(rx), 1);
      });
    };
    checkLayer(headMesh, head);
    checkLayer(eyeMesh, eye);
    checkLayer(lipMesh, lip);
  });

  it("hair gets the cylinder warp PLUS bounded parallax", () => {
    const { solved, ctx } = solvedAt(1);
    const bangs = solved.layers.find((l) => l.id === "l_bangs")!;
    const bangsMesh = ctx.meshCache.get("l_bangs")!;

    // Hair displacement = full warp (attached like the eyes) + clamped
    // parallax (±4 steps).
    const angle = (30 * Math.PI) / 180;
    const parallax = Math.min(4, 12 - 5) * Math.sin(angle) * 3;
    bangsMesh.vertices.forEach(([rx], i) => {
      const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
      const expected = headTurnX(u, angle, 450, 150, 1) + parallax;
      expect(bangs.positions[i]![0]).toBeCloseTo(expected, 1);
    });
    // And it is not zero — parallax still exists for depth.
    expect(Math.abs(parallax)).toBeGreaterThan(0.01);
  });

  it("no parallax on face features (order delta ignored for eyes)", () => {
    // Two eye layers stacked at different orders must warp identically.
    const model = build();
    model.layers.push(
      makeLayer({ id: "l_eye2", name: "eye-white-right", slot: "eye_white", side: "right", x: 400, y: 250, width: 60, height: 30, order: 30 }),
    );
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1 }, ctx);
    const a = solved.layers.find((l) => l.id === "l_eye")!;
    const b = solved.layers.find((l) => l.id === "l_eye2")!;
    // Identical rest rects, different orders → identical solved positions.
    for (let i = 0; i < a.positions.length; i++) {
      expect(b.positions[i]![0]).toBeCloseTo(a.positions[i]![0], 4);
    }
  });
});
