import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext, type SolveContext } from "../src/solve";
import { generateMesh } from "../src/geometry/triangulate";
import { blobImage } from "./helpers";
import { makeModel, makeLayer, makeSpine, testId } from "./helpers";
import { emptyRig, type OarMesh } from "../src/model/types";

/**
 * Studio parity: the creator and the studio solve through the same core code.
 * This test proves solveModel is deterministic and side-effect-safe across
 * contexts — the same model at the same parameters produces exactly the same
 * vertex positions.
 */
describe("studio parity", () => {
  function buildModel() {
    const bones = makeSpine();
    const headBone = bones.find((b) => b.name === "head")!;
    const chestBone = bones.find((b) => b.name === "chest")!;

    const headImg = blobImage(100, 100, 45);
    const mesh: OarMesh = generateMesh(testId("m"), headImg, 400, 200, "coarse");
    mesh.weights = mesh.vertices.map(() => ({ [headBone.id]: 1 }));

    const headLayer = makeLayer({
      id: "l_head",
      name: "head",
      slot: "head",
      x: 400,
      y: 200,
      width: 100,
      height: 100,
      mesh: mesh.id,
      boneId: headBone.id,
      order: 5,
    });
    const torsoLayer = makeLayer({
      id: "l_torso",
      name: "torso",
      slot: "torso",
      x: 350,
      y: 500,
      width: 200,
      height: 300,
      boneId: chestBone.id,
      order: 1,
      physics: {
        enabled: true,
        stiffness: 5,
        damping: 0.86,
        maxAngle: 16,
        inertia: 1,
        gravity: 0.5,
        pivot: "top",
        customPivot: null,
      },
    });
    const rig = emptyRig();
    rig.head = { centre: [450, 250] as [number, number], radius: [60, 80] as [number, number] };
    const model = makeModel({
      layers: [headLayer, torsoLayer],
      bones,
      meshes: [mesh],
      rig,
    });
    return model;
  }

  const PARAMS = {
    head_yaw: 0.4,
    head_roll: 0.3,
    head_x: 0.2,
    head_y: -0.1,
    eye_l_open: 0.9,
    mouth_open: 0.35,
  } as const;

  function solve(model: ReturnType<typeof buildModel>, ctx: SolveContext) {
    ctx.meshes = new Map(model.meshes.map((m) => [m.id, m]));
    return solveModel(model, { ...PARAMS }, ctx);
  }

  it("identical inputs produce byte-identical vertex positions", () => {
    const model = buildModel();
    const a = solve(model, createSolveContext());
    const b = solve(model, createSolveContext());
    expect(a.layers.length).toBe(b.layers.length);
    for (let i = 0; i < a.layers.length; i++) {
      expect(a.layers[i]!.positions).toEqual(b.layers[i]!.positions);
      expect(a.layers[i]!.alpha).toBe(b.layers[i]!.alpha);
    }
  });

  it("no NaN leaks into any vertex across a parameter sweep", () => {
    const model = buildModel();
    const ctx = createSolveContext();
    ctx.meshes = new Map(model.meshes.map((m) => [m.id, m]));
    for (let t = 0; t < 60; t++) {
      const solved = solveModel(
        model,
        {
          head_yaw: Math.sin(t / 10),
          head_roll: Math.cos(t / 7),
          head_x: Math.sin(t / 5) * 0.5,
          mouth_open: (Math.sin(t / 3) + 1) / 2,
        },
        ctx,
      );
      for (const layer of solved.layers) {
        for (const [x, y] of layer.positions) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        }
        expect(Number.isFinite(layer.alpha)).toBe(true);
      }
    }
  });

  it("unbound layers do not move (wrong-and-static, never wrong-and-moving)", () => {
    const model = buildModel();
    const free = makeLayer({ id: "l_free", name: "mystery", slot: null, x: 10, y: 10 });
    model.layers.push(free);
    const ctx = createSolveContext();
    const solved = solveModel(model, { head_roll: 1, head_yaw: 1, head_x: 0 }, ctx);
    const wl = solved.layers.find((l) => l.id === "l_free")!;
    for (const [x, y] of wl.positions) {
      expect(x).toBeGreaterThanOrEqual(9.9);
      expect(x).toBeLessThanOrEqual(110.1);
      expect(y).toBeGreaterThanOrEqual(9.9);
      expect(y).toBeLessThanOrEqual(110.1);
    }
  });
});
