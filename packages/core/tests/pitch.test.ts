import { RIG_PARAM_DEFAULTS } from "../src/model/params";
import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { emptyRig, type OarManifest, type Vec2 } from "../src/model/types";
import { makeModel, makeLayer, makeSpine } from "./helpers";
import { solveSkeleton } from "../src/skeleton/solve";
import { apply as matApply, type Mat2D } from "../src/geometry/mat2d";
import { headTurnX, headPitchY, isMonotonic, pitchSurface, safePitchDepth } from "../src/headturn/warp";
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

/** Yaw moves x; the nod moves y, sampled on the face surface at the point's
 *  already-yawed x — so a turned face nods along its turned front. */
const warpX = (x: number, yawAngle: number) =>
  headTurnX(clamp((x - 450) / 150, -3, 3), yawAngle, 450, 150, RIG_PARAM_DEFAULTS.headTurnDepth);
const warpY = (x: number, y: number, pitchAngle: number) =>
  headPitchY(
    clamp((x - 450) / 150, -3, 3),
    clamp((y - 300) / 200, -3, 3),
    pitchAngle, 300, 200, RIG_PARAM_DEFAULTS.headPitchDepth,
  );

/** Exact expected mapping for a head-bound layer at any yaw/pitch/roll pose:
 *  pre·post cancel across the two stages, so final =
 *  post(warpX(x), warpY(warpX(x), y)). Hair additionally takes the
 *  order-delta x parallax after the warp. */
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
      const wx = warpX(rv[0]!, yawAngle);
      const [ex, ey] = matApply(headMat, wx, warpY(wx, rv[1]!, pitchAngle));
      expect(layer.positions[i]![0]).toBeCloseTo(ex + parallaxDx, 1);
      expect(layer.positions[i]![1]).toBeCloseTo(ey, 1);
    });
  }
}

const headMatAt = (model: OarManifest, headBoneId: string, roll: number): Mat2D =>
  solveSkeleton(model.bones, (roll * ROLL_DEG * Math.PI) / 180).get(headBoneId)!.mat;

describe("head pitch (face-surface nod)", () => {
  it("monotonic at pitch warp angles (no fold-back on the chin/crown)", () => {
    for (const deg of [-20, -10, 10, 20]) {
      expect(isMonotonic(degToRad(deg)), `pitch ${deg}°`).toBe(true);
    }
  });

  it("pitch=+1: features drop, head keeps its height, bangs do not overtake the eyes", () => {
    const { model, headBoneId } = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_pitch: 1 }, ctx);
    const a = degToRad(PITCH_DEG);
    expectExact(model, solved, ctx, ["l_head", "l_eye", "l_hair"], headMatAt(model, headBoneId, 0), 0, a);

    // No squash: crown and chin (the centre column) travel alike, so the
    // outline keeps its height — only the interior foreshortens.
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    const nearest = Math.min(...headMesh.vertices.map((v) => Math.abs(v[0] - 450)));
    const centreCol = headMesh.vertices
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => Math.abs(Math.abs(v[0] - 450) - nearest) < 1e-6 && v[0] >= 450);
    expect(centreCol.length).toBeGreaterThan(2);
    const ys = (pick: (i: number) => number) => centreCol.map(({ i }) => pick(i));
    const restH = Math.max(...ys((i) => headMesh.vertices[i]![1])) - Math.min(...ys((i) => headMesh.vertices[i]![1]));
    const solvedH = Math.max(...ys((i) => head.positions[i]![1])) - Math.min(...ys((i) => head.positions[i]![1]));
    expect(solvedH).toBeCloseTo(restH, 1);
    // ...while the features really did slide down.
    const eye = solved.layers.find((l) => l.id === "l_eye")!;
    const eyeRestTop = Math.min(...ctx.meshCache.get("l_eye")!.vertices.map((v) => v[1]));
    expect(Math.min(...eye.positions.map((p) => p[1]))).toBeGreaterThan(eyeRestTop + 5);

    // Anti-swallow: a bang tip at the brow line (v≈0) and an eye just below
    // it must travel together — the differential is what covers the eyes.
    const slide = (y: number) => warpY(450, y, a) - y;
    expect(Math.abs(slide(300) - slide(345))).toBeLessThan(4);
  });

  it("the face front travels further than the silhouette (the nod foreshortens)", () => {
    const a = degToRad(PITCH_DEG);
    const slide = (x: number, y: number) => warpY(x, y, a) - y;
    const front = slide(450, 300); // face centre
    expect(front).toBeGreaterThan(20);
    expect(slide(450, 500)).toBeLessThan(front * 0.5); // chin
    expect(slide(450, 100)).toBeLessThan(front * 0.5); // crown
    expect(slide(600, 300)).toBeLessThan(front * 0.5); // cheek outline
    // Nodding down compresses the lower face; tilting up stretches it.
    const lowerFace = (p: number) => warpY(450, 500, p) - warpY(450, 300, p);
    expect(lowerFace(a)).toBeLessThan(200);
    expect(lowerFace(-a)).toBeGreaterThan(200);
  });

  it("never folds along v, at any depth or angle", () => {
    for (const deg of [-45, -20, -10, 10, 20, 45]) {
      for (const depth of [0.5, 1.5, 5]) {
        const ang = degToRad(deg);
        for (const u of [0, 0.5, 1]) {
          let prev = -Infinity;
          for (let i = 0; i <= 600; i++) {
            const y = headPitchY(u, -3 + (6 * i) / 600, ang, 0, 100, depth);
            expect(y, `deg ${deg} depth ${depth} u ${u}`).toBeGreaterThan(prev);
            prev = y;
          }
        }
      }
    }
    expect(safePitchDepth(degToRad(45), 5)).toBeLessThan(5);
    expect(pitchSurface(0, 0)).toBe(1);
  });

  it("ears counter-move: nodding down, they drop less than the face front", () => {
    const { model, headBoneId } = build();
    model.layers.push(
      makeLayer({ id: "l_ear", name: "ear", slot: "ear", x: 590, y: 280, width: 30, height: 60, boneId: headBoneId, order: 4 }),
    );
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_pitch: 1 }, ctx);
    const mean = (id: string) => {
      const l = solved.layers.find((x) => x.id === id)!;
      return l.positions.reduce((s, p) => s + p[1], 0) / l.positions.length;
    };
    const restMean = (id: string) => {
      const v = ctx.meshCache.get(id)!.vertices;
      return v.reduce((s, p) => s + p[1], 0) / v.length;
    };
    expect(mean("l_ear") - restMean("l_ear")).toBeLessThan(mean("l_eye") - restMean("l_eye") - 10);
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

  it("diagonal: yaw then a nod along the turned face, exactly", () => {
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
