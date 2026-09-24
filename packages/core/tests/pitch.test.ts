import { RIG_PARAM_DEFAULTS } from "../src/model/params";
import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { emptyRig, type OarManifest, type Vec2 } from "../src/model/types";
import { makeModel, makeLayer, makeSpine } from "./helpers";
import { solveSkeleton } from "../src/skeleton/solve";
import { apply as matApply, type Mat2D } from "../src/geometry/mat2d";
import { headTurnX, isMonotonic } from "../src/headturn/warp";
import { clamp, degToRad } from "../src/geometry/util";

const PITCH_DEG = 10; // RIG_PARAM_DEFAULTS.headPitchDeg
const YAW_DEG = 30; // RIG_PARAM_DEFAULTS.headTurnDeg
const ROLL_DEG = 12; // RIG_PARAM_DEFAULTS.bodyRollDeg

// Head geometry shared by all tests: rig centre (450,300), radius (150,200).
function build(): { model: OarManifest; headBoneId: string } {
  const spine = makeSpine();
  const headBone = spine[spine.length - 1]!;
  const rig = emptyRig();
  rig.head = { centre: [450, 300], radius: [150, 200] };
  const model = makeModel({
    bones: spine,
    layers: [
      makeLayer({ id: "l_head", name: "head", slot: "head", x: 300, y: 100, width: 300, height: 400, boneId: headBone.id, order: 5 }),
      makeLayer({ id: "l_eye", name: "eye-white-left", slot: "eye_white", side: "left", x: 400, y: 250, width: 60, height: 30, boneId: headBone.id, order: 8 }),
      makeLayer({ id: "l_hair", name: "hair-back", slot: "hair_back", x: 280, y: 80, width: 340, height: 440, boneId: headBone.id, order: 1 }),
    ],
    rig,
  });
  return { model, headBoneId: headBone.id };
}

/** The separable cylinder warps: yaw moves x, pitch moves y. */
const warpX = (x: number, yawAngle: number) =>
  headTurnX(clamp((x - 450) / 150, -3, 3), yawAngle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth);
const warpY = (y: number, pitchAngle: number) =>
  headTurnX(clamp((y - 300) / 200, -3, 3), pitchAngle, 300, 200, RIG_PARAM_DEFAULTS.headTurnDepth);

/** Exact expected mapping for a head-bound layer at any yaw/pitch/roll pose:
 *  pre·post cancel across the two stages, so final = post(warpX, warpY).
 *  Hair additionally takes the order-delta x parallax after the warp. */
function expectExact(
  model: OarManifest,
  solved: ReturnType<typeof solveModel>,
  ctx: ReturnType<typeof createSolveContext>,
  layerIds: string[],
  headMat: Mat2D,
  yawAngle: number,
  pitchAngle: number,
) {
  const headOrder = model.layers.find((l) => l.slot === "head")!.order;
  for (const layerId of layerIds) {
    const ml = model.layers.find((l) => l.id === layerId)!;
    const parallaxDx = ml.slot?.startsWith("hair")
      ? clamp(ml.order - headOrder, -4, 4) * Math.sin(yawAngle) * 3 // headParallaxPx default
      : 0;
    const layer = solved.layers.find((l) => l.id === layerId)!;
    const mesh = ctx.meshCache.get(layerId)!;
    mesh.vertices.forEach((rv: Vec2, i: number) => {
      const [ex, ey] = matApply(headMat, warpX(rv[0]!, yawAngle), warpY(rv[1]!, pitchAngle));
      expect(layer.positions[i]![0]).toBeCloseTo(ex + parallaxDx, 1);
      expect(layer.positions[i]![1]).toBeCloseTo(ey, 1);
    });
  }
}

const headMatAt = (model: OarManifest, headBoneId: string, roll: number): Mat2D =>
  solveSkeleton(model.bones, (roll * ROLL_DEG * Math.PI) / 180).get(headBoneId)!.mat;

describe("head pitch (vertical cylinder warp)", () => {
  it("monotonic at pitch warp angles (no fold-back on the chin/crown)", () => {
    for (const deg of [-20, -10, 10, 20]) {
      expect(isMonotonic(degToRad(deg)), `pitch ${deg}°`).toBe(true);
    }
  });

  it("pitch=+1: features slide down, head keeps its size, bangs do not overtake the eyes", () => {
    const { model, headBoneId } = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_pitch: 1 }, ctx);
    const a = degToRad(PITCH_DEG);
    expectExact(model, solved, ctx, ["l_head", "l_eye", "l_hair"], headMatAt(model, headBoneId, 0), 0, a);

    // No squash: the outline keeps its height (a Live2D nod slides the
    // features; shrinking the whole face is what made pitch look wrong).
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    const restH = Math.max(...headMesh.vertices.map((v) => v[1])) - Math.min(...headMesh.vertices.map((v) => v[1]));
    const solvedH = Math.max(...head.positions.map((p) => p[1])) - Math.min(...head.positions.map((p) => p[1]));
    expect(solvedH).toBeCloseTo(restH, 1);
    // ...while the features really did slide down.
    const eye = solved.layers.find((l) => l.id === "l_eye")!;
    const eyeRestTop = Math.min(...ctx.meshCache.get("l_eye")!.vertices.map((v) => v[1]));
    expect(Math.min(...eye.positions.map((p) => p[1]))).toBeGreaterThan(eyeRestTop + 5);

    // Anti-swallow: a bang tip at the brow line (v≈0) and an eye just below
    // it must travel together — the differential is what covers the eyes.
    const slide = (y: number) => warpY(y, a) - y;
    expect(Math.abs(slide(300) - slide(345))).toBeLessThan(4);
  });

  it("back hair takes the SAME warp as the face (helmet rule, like yaw)", () => {
    const { model, headBoneId } = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_pitch: 1 }, ctx);
    const a = degToRad(PITCH_DEG);
    expectExact(model, solved, ctx, ["l_hair"], headMatAt(model, headBoneId, 0), 0, a);
  });

  it("pitch+roll composes exactly (warp in the head frame, no shear)", () => {
    const { model, headBoneId } = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_pitch: 1, head_roll: 1 }, ctx);
    const a = degToRad(PITCH_DEG);
    expectExact(model, solved, ctx, ["l_head", "l_eye"], headMatAt(model, headBoneId, 1), 0, a);
  });

  it("diagonal: yaw+pitch is exactly the separable composition", () => {
    const { model, headBoneId } = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: 1, head_pitch: 1 }, ctx);
          expectExact(
            model, solved, ctx, ["l_head", "l_eye", "l_hair"],
            headMatAt(model, headBoneId, 0), degToRad(YAW_DEG), degToRad(PITCH_DEG),
          );
  });

  it("diagonal + roll: every yaw/pitch corner at roll ±1 is exact and finite", () => {
    const { model, headBoneId } = build();
    for (const roll of [-1, 0, 1]) {
      for (const yaw of [-1, 1]) {
        for (const pitch of [-1, 1]) {
          const ctx = createSolveContext();
          const solved = solveModel(model, { head_yaw: yaw, head_pitch: pitch, head_roll: roll }, ctx);
          for (const l of solved.layers) {
            for (const [x, y] of l.positions) {
              expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
            }
          }
          expectExact(
            model, solved, ctx, ["l_head", "l_eye", "l_hair"],
            headMatAt(model, headBoneId, roll), yaw * degToRad(YAW_DEG), pitch * degToRad(PITCH_DEG),
          );
        }
      }
    }
  });

  it("pitch=0 is the identity", () => {
    const { model } = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_pitch: 0 }, ctx);
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    headMesh.vertices.forEach((rv, i) => {
      expect(head.positions[i]![1]).toBeCloseTo(rv[1]!, 6);
    });
  });
});
