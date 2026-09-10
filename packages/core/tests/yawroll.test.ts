import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { emptyRig, type OarManifest } from "../src/model/types";
import { makeModel, makeLayer, makeBone, makeSpine } from "./helpers";

/** The cylinder warp must happen in the head bone's LOCAL frame: at yaw=−1
 *  AND roll=−1 together, the face must not shear — features at the same rest
 *  position stay welded to the head. */
describe("yaw + roll composition", () => {
  function build(): OarManifest {
    const headBone = makeBone("head", 500, 1.0, null, 450);
    const rig = emptyRig();
    rig.head = { centre: [450, 300], radius: [150, 200] };
    return makeModel({
      bones: [headBone],
      layers: [
        makeLayer({ id: "l_head", name: "head", slot: "head", x: 300, y: 100, width: 300, height: 400, boneId: headBone.id, order: 5 }),
        makeLayer({ id: "l_eye", name: "eye-white-left", slot: "eye_white", side: "left", x: 400, y: 250, width: 60, height: 30, boneId: headBone.id, order: 8 }),
        makeLayer({ id: "l_lip", name: "top-lip", slot: "lip_upper", x: 410, y: 350, width: 60, height: 20, boneId: headBone.id, order: 9 }),
      ],
      rig,
    });
  }

  it("features weld to the head at yaw=−1 AND roll=−1 (no shear)", async () => {
    const model = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_yaw: -1, head_roll: -1 }, ctx);
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const eye = solved.layers.find((l) => l.id === "l_eye")!;
    const lip = solved.layers.find((l) => l.id === "l_lip")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    const eyeMesh = ctx.meshCache.get("l_eye")!;
    const lipMesh = ctx.meshCache.get("l_lip")!;

    // Every vert finite.
    for (const l of [head, eye, lip]) {
      for (const [x, y] of l.positions) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      }
    }
    // Exact expectation: rotate rest verts into the head's local frame about
    // the bone pivot, warp there, rotate back. The solver must reproduce it.
    const { rotationAbout, apply: matApply } = await import("../src/geometry/mat2d");
    const { headTurnX } = await import("../src/headturn/warp");
    const rollAngle = (-1 * 12 * Math.PI) / 180;
    const yawAngle = (-1 * 30 * Math.PI) / 180;
    const pivot: [number, number] = [450, 500];
    const postRot = rotationAbout(pivot, rollAngle);
    // The solver's local frame is exactly the rest frame (preRot inverts the
    // bone transform), so: solved = boneTransform(warp_x(rest), rest.y).
    const expected = (p: [number, number]): [number, number] => {
      const u = Math.max(-3, Math.min(3, (p[0] - 450) / 150));
      const wx = headTurnX(u, yawAngle, 450, 150, 1);
      return matApply(postRot, wx, p[1]);
    };
    const checkExact = (
      mesh: { vertices: [number, number][] },
      layer: { positions: [number, number][] },
    ) => {
      mesh.vertices.forEach((rv, i) => {
        const [ex, ey] = expected(rv);
        expect(layer.positions[i]![0]).toBeCloseTo(ex, 1);
        expect(layer.positions[i]![1]).toBeCloseTo(ey, 1);
      });
    };
    checkExact(headMesh, head);
    checkExact(eyeMesh, eye);
    checkExact(lipMesh, lip);
  });

  it("roll alone still rotates about the head pivot", () => {
    const model = build();
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_roll: -1 }, ctx);
    const head = solved.layers.find((l) => l.id === "l_head")!;
    const headMesh = ctx.meshCache.get("l_head")!;
    // Displacement is a pure rotation about the bone head (450,500):
    // distances to the pivot are preserved.
    headMesh.vertices.forEach((rv, i) => {
      const restD = Math.hypot(rv[0] - 450, rv[1] - 500);
      const solvedD = Math.hypot(head.positions[i]![0] - 450, head.positions[i]![1] - 500);
      expect(solvedD).toBeCloseTo(restD, 3);
    });
  });

  it("full spine: no shear at any yaw/roll corner combination", async () => {
    const spine = makeSpine();
    const headBone = spine[spine.length - 1]!;
    const rig = emptyRig();
    rig.head = { centre: [450, 300], radius: [150, 200] };
    const model = makeModel({
      bones: spine,
      layers: [
        makeLayer({ id: "l_head", name: "head", slot: "head", x: 300, y: 100, width: 300, height: 400, boneId: headBone.id, order: 5 }),
        makeLayer({ id: "l_eye", name: "eye-white-left", slot: "eye_white", side: "left", x: 400, y: 250, width: 60, height: 30, boneId: headBone.id, order: 8 }),
        makeLayer({ id: "l_lip", name: "top-lip", slot: "lip_upper", x: 410, y: 350, width: 60, height: 20, boneId: headBone.id, order: 9 }),
      ],
      rig,
    });
    const { solveSkeleton } = await import("../src/skeleton/solve");
    const { apply: matApply } = await import("../src/geometry/mat2d");
    const { headTurnX } = await import("../src/headturn/warp");

    const cases: [number, number][] = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (const [yaw, roll] of cases) {
      const ctx = createSolveContext();
      const solved = solveModel(model, { head_yaw: yaw, head_roll: roll }, ctx);
      const driverAngle = (roll * 12 * Math.PI) / 180;
      const yawAngle = (yaw * 30 * Math.PI) / 180;
      const world = solveSkeleton(model.bones, driverAngle);
      const headWorld = world.get(headBone.id)!;
      const expected = (rx: number, ry: number): [number, number] => {
        const u = Math.max(-3, Math.min(3, (rx - 450) / 150));
        const wx = headTurnX(u, yawAngle, 450, 150, 1);
        return matApply(headWorld.mat, wx, ry);
      };
      for (const layerId of ["l_head", "l_eye", "l_lip"]) {
        const layer = solved.layers.find((l) => l.id === layerId)!;
        const mesh = ctx.meshCache.get(layerId)!;
        mesh.vertices.forEach((rv, i) => {
          const [ex, ey] = expected(rv[0]!, rv[1]!);
          expect(layer.positions[i]![0]).toBeCloseTo(ex, 1);
          expect(layer.positions[i]![1]).toBeCloseTo(ey, 1);
        });
      }
    }
  });
});
