import { describe, it, expect } from "vitest";
import {
  solveEye,
  deriveLidContour,
  deriveLashLowerEdge,
  type WorkingLayer,
  type EyeRuntime,
} from "../src/face/eyes";
import { applyBlinkFloor } from "../src/tracking/adapter";
import { sampleContour } from "../src/geometry/contour";
import { rectImage } from "./helpers";
import { makeLayer } from "./helpers";
import { apply as matApply, invert, rotationAbout } from "../src/geometry/mat2d";
import type { OarRigEye, Vec2 } from "../src/model/types";

// Synthetic eye: white 40x20 opaque rect at (100,100); iris 16x12 at (112,104);
// lash a 40x8 band sitting just above the white, at (100,92).
function makeEye() {
  const whiteImg = rectImage(40, 20, { x: 0, y: 0, width: 40, height: 20 });
  const lashImg = rectImage(40, 8, { x: 0, y: 0, width: 40, height: 8 });
  const lidContour = deriveLidContour(whiteImg, 100, 100);
  const lashLower = deriveLashLowerEdge(lashImg, 100, 92);

  const whiteLayer = makeLayer({ id: "l_white", x: 100, y: 100, width: 40, height: 20 });
  const irisLayer = makeLayer({ id: "l_iris", x: 112, y: 104, width: 16, height: 12 });
  const lashLayer = makeLayer({ id: "l_lash", x: 100, y: 92, width: 40, height: 8 });

  const grid = (x: number, y: number, w: number, h: number, nx: number, ny: number): Vec2[] => {
    const pts: Vec2[] = [];
    for (let r = 0; r <= ny; r++)
      for (let c = 0; c <= nx; c++) pts.push([x + (w * c) / nx, y + (h * r) / ny]);
    return pts;
  };
  const working = new Map<string, WorkingLayer>();
  const mk = (layer: typeof whiteLayer, nx: number, ny: number) => {
    const rest = grid(layer.x, layer.y, layer.width, layer.height, nx, ny);
    working.set(layer.id, {
      layer,
      restVerts: rest,
      positions: rest.map((v) => [...v] as Vec2),
      alpha: 1,
    });
  };
  mk(whiteLayer, 8, 4);
  mk(irisLayer, 4, 3);
  mk(lashLayer, 12, 2);

  const rigEye: OarRigEye = {
    white: "l_white",
    iris: "l_iris",
    shine: null,
    lashTop: "l_lash",
    lashBottom: null,
    closed: null,
    lidContour,
    irisRange: [10, 3],
  };
  const runtime: EyeRuntime = { lashLower };
  return { working, rigEye, runtime, lidContour, lashLower };
}

describe("blink (lid-contour morph)", () => {
  it("at effective = 0 the interior alpha is exactly 0 and nothing shows through", () => {
    const { working, rigEye, runtime } = makeEye();
    solveEye(rigEye, runtime, working, 0, 0, 0);
    expect(working.get("l_white")!.alpha).toBe(0);
    expect(working.get("l_iris")!.alpha).toBe(0);
  });

  it("at effective = 0 the lash lower edge lies within 2px of the lid contour", () => {
    const { working, rigEye, runtime, lidContour, lashLower } = makeEye();
    solveEye(rigEye, runtime, working, 0, 0, 0);
    const lash = working.get("l_lash")!;
    // Lower-edge rest verts land exactly on the contour (thickness = 0).
    let checked = 0;
    for (let i = 0; i < lash.restVerts.length; i++) {
      const [rx, ry] = lash.restVerts[i]!;
      const lower = sampleContour(lashLower, rx);
      if (lower === null || Math.abs(ry - lower) > 1.5) continue; // only edge verts
      const target = sampleContour(lidContour, rx)!;
      expect(Math.abs(lash.positions[i]![1] - target)).toBeLessThan(2);
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("the lash stays fully opaque throughout the close", () => {
    const { working, rigEye, runtime } = makeEye();
    solveEye(rigEye, runtime, working, 0, 0, 0);
    expect(working.get("l_lash")!.alpha).toBe(1);
  });

  it("fully open is the identity", () => {
    const { working, rigEye, runtime } = makeEye();
    solveEye(rigEye, runtime, working, 1, 0, 0);
    const lash = working.get("l_lash")!;
    for (let i = 0; i < lash.positions.length; i++) {
      expect(lash.positions[i]![1]).toBeCloseTo(lash.restVerts[i]![1], 6);
    }
    expect(working.get("l_white")!.alpha).toBe(1);
  });

  it("blink floor: raw 0.32 openness reads as fully closed", () => {
    expect(applyBlinkFloor(0.32, 0.32)).toBe(0);
    expect(applyBlinkFloor(0.1, 0.32)).toBe(0);
    expect(applyBlinkFloor(1, 0.32)).toBe(1);
    expect(applyBlinkFloor(0.66, 0.32)).toBeCloseTo(0.5, 2);
  });

  it("iris travel is clamped to the room inside the white", () => {
    const { working, rigEye, runtime } = makeEye();
    solveEye(rigEye, runtime, working, 1, 1, 0); // hard right gaze
    const iris = working.get("l_iris")!;
    const whiteRight = 100 + 40;
    for (const p of iris.positions) {
      expect(p[0]).toBeLessThanOrEqual(whiteRight - 2 + 0.001);
    }
  });

  it("invert=0 keeps the lash band covering the eye (top edge above the contour)", () => {
    const { working, rigEye, runtime, lidContour } = makeEye();
    solveEye(rigEye, runtime, working, 0, 0, 0, { invert: 0 });
    const lash = working.get("l_lash")!;
    const topY = Math.min(...lash.restVerts.map((v) => v[1]!));
    let checked = 0;
    for (let i = 0; i < lash.restVerts.length; i++) {
      const [rx, ry] = lash.restVerts[i]!;
      if (Math.abs(ry - topY) > 0.5) continue; // only top-edge verts
      const target = sampleContour(lidContour, rx)!;
      const lower = sampleContour(runtime.lashLower!, rx)!;
      const thickness = Math.max(0, lower - ry);
      expect(lash.positions[i]![1]).toBeCloseTo(target - thickness, 0);
      expect(lash.positions[i]![1]).toBeLessThan(target); // covers the eye
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("invert=1 flips the band below the contour (top edge below target)", () => {
    const { working, rigEye, runtime, lidContour } = makeEye();
    solveEye(rigEye, runtime, working, 0, 0, 0, { invert: 1 });
    const lash = working.get("l_lash")!;
    const topY = Math.min(...lash.restVerts.map((v) => v[1]!));
    let checked = 0;
    for (let i = 0; i < lash.restVerts.length; i++) {
      const [rx, ry] = lash.restVerts[i]!;
      if (Math.abs(ry - topY) > 0.5) continue;
      const target = sampleContour(lidContour, rx)!;
      const lower = sampleContour(runtime.lashLower!, rx)!;
      const thickness = Math.max(0, lower - ry);
      expect(lash.positions[i]![1]).toBeCloseTo(target + thickness, 0);
      expect(lash.positions[i]![1]).toBeGreaterThan(target); // hangs below
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("closed lash stays welded to the contour when the head is rotated", () => {
    const { working, rigEye, runtime, lidContour } = makeEye();
    const pivot: [number, number] = [120, 110];
    const post = rotationAbout(pivot, (30 * Math.PI) / 180);
    const pre = invert(post);
    const lash = working.get("l_lash")!;
    // Simulate skinning: rotate the lash into world space first.
    lash.positions = lash.restVerts.map((v) => matApply(post, v[0]!, v[1]!));
    solveEye(rigEye, runtime, working, 0, 0, 0, { invert: 0, frame: { pre, post } });
    const topY = Math.min(...lash.restVerts.map((v) => v[1]!));
    const expected = (rx: number, ry: number): [number, number] => {
      const target = sampleContour(lidContour, rx)!;
      const lower = sampleContour(runtime.lashLower!, rx)!;
      const thickness = Math.max(0, lower - ry);
      return matApply(post, rx, target - thickness);
    };
    let checked = 0;
    for (let i = 0; i < lash.restVerts.length; i++) {
      const [rx, ry] = lash.restVerts[i]!;
      if (Math.abs(ry - topY) > 0.5) continue;
      const [ex, ey] = expected(rx, ry);
      expect(lash.positions[i]![0]).toBeCloseTo(ex, 1);
      expect(lash.positions[i]![1]).toBeCloseTo(ey, 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("the interior fades as the lid descends and is gone by open=0.25", () => {
    const mid = makeEye();
    solveEye(mid.rigEye, mid.runtime, mid.working, 0.6, 0, 0);
    expect(mid.working.get("l_white")!.alpha).toBeCloseTo(0.67, 1);
    expect(mid.working.get("l_iris")!.alpha).toBeCloseTo(0.67, 1);

    const low = makeEye();
    solveEye(low.rigEye, low.runtime, low.working, 0.25, 0, 0);
    expect(low.working.get("l_white")!.alpha).toBe(0);
    expect(low.working.get("l_iris")!.alpha).toBe(0);
  });

  it("a one-column spike in the white's edge is smoothed out of the lid contour", () => {
    const img = rectImage(40, 30, { x: 0, y: 0, width: 40, height: 20 });
    img.data[(25 * 40 + 20) * 4 + 3] = 255; // spike: column 20 dips to row 25
    const contour = deriveLidContour(img, 0, 0);
    const y = sampleContour(contour, 20)!;
    expect(y).toBeLessThan(23); // spike (25) smoothed back toward the edge (19)
  });

  it("eyelash layers get a dense render grid so the contour morph is smooth", async () => {
    const { solveModel, createSolveContext } = await import("../src/solve");
    const { emptyRig } = await import("../src/model/types");
    const { makeModel, makeBone } = await import("./helpers");
    const headBone = makeBone("head", 500, 1.0, null, 450);
    const model = makeModel({
      bones: [headBone],
      layers: [
        makeLayer({
          id: "l_lash_dense",
          name: "lash",
          slot: "eyelash_top",
          side: "left",
          x: 300,
          y: 200,
          width: 200,
          height: 60,
          boneId: headBone.id,
          order: 8,
        }),
      ],
      rig: emptyRig(),
    });
    const ctx = createSolveContext();
    solveModel(model, {}, ctx);
    const mesh = ctx.meshCache.get("l_lash_dense")!;
    // The old heuristic gave a 3×3 cell grid (16 verts); the eye grid must be
    // far finer for the per-column contour morph to render as a curve.
    expect(mesh.vertices.length).toBeGreaterThanOrEqual(64);
  });
});
