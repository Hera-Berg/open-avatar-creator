import { describe, it, expect } from "vitest";
import { solveSkeleton, skinVertices, spineWeights } from "../src/skeleton/solve";
import { apply } from "../src/geometry/mat2d";
import type { OarMesh } from "../src/model/types";
import { makeSpine, makeBone } from "./helpers";

describe("skeleton", () => {
  it("accumulates driver rotation by follow, including negative hips", () => {
    const bones = makeSpine();
    const world = solveSkeleton(bones, 0.2);
    const byName = (n: string) => [...world.values()].find((w) => w.bone.name === n)!;
    expect(byName("root").angle).toBeCloseTo(0, 6);
    // The negative hips value is the whole S-curve: it must survive.
    expect(byName("hips").angle).toBeCloseTo(0.2 * -0.09, 6);
    expect(byName("chest").angle).toBeCloseTo(0.2 * 0.36, 6);
    expect(byName("head").angle).toBeCloseTo(0.2 * 1.0, 6);
  });

  it("follow is monotonically increasing above the hips in the reference chain", () => {
    const bones = makeSpine();
    const above = bones.filter((b) => ["hips", "torso", "chest", "neck", "head"].includes(b.name));
    for (let i = 1; i < above.length; i++) {
      expect(above[i]!.follow).toBeGreaterThan(above[i - 1]!.follow);
    }
  });

  it("joint continuity: 1px either side of a joint stays ~1px apart at full deflection", () => {
    // Two spine bones meeting at y=500.
    const lower = makeBone("chest", 500, 0.36, null);
    const upper = makeBone("neck", 400, 0.64, lower.id);
    const bones = [lower, upper];
    const world = solveSkeleton(bones, 0.5); // hard deflection

    // Points 1px either side of the joint, weighted by the smoothstep rule.
    const jointY = 500;
    const mesh: OarMesh = {
      id: "m",
      vertices: [
        [100, jointY - 1],
        [100, jointY + 1],
      ],
      uvs: [
        [0, 0],
        [0, 1],
      ],
      triangles: [[0, 1, 0]],
      weights: [
        spineWeights(jointY - 1, [
          { id: upper.id, pivotY: 400 },
          { id: lower.id, pivotY: 500 },
        ]),
        spineWeights(jointY + 1, [
          { id: upper.id, pivotY: 400 },
          { id: lower.id, pivotY: 500 },
        ]),
      ],
    };
    const out = skinVertices(mesh, world);
    const dist = Math.hypot(out[0]![0] - out[1]![0], out[0]![1] - out[1]![1]);
    // A hinge would tear this far beyond the 2px sample distance.
    expect(dist).toBeLessThan(2.6);
    expect(dist).toBeGreaterThan(1.4);
  });

  it("taper: displacement decreases monotonically down the chain, legs ≈ 0", () => {
    const bones = makeSpine();
    const world = solveSkeleton(bones, 0.3);
    const byName = new Map([...world.values()].map((w) => [w.bone.name, w]));
    // The same test point (top of the figure, above every pivot) rigidly
    // bound to each bone in turn: displacement tracks cumulative follow.
    const testPoint: [number, number] = [0, 0];
    const displacement = (name: string) => {
      const w = byName.get(name)!;
      const p = apply(w.mat, testPoint[0], testPoint[1]);
      return Math.hypot(p[0] - testPoint[0], p[1] - testPoint[1]);
    };
    const face = displacement("head");
    const chest = displacement("chest");
    const torso = displacement("torso");
    const legs = displacement("root");
    expect(face).toBeGreaterThan(chest);
    expect(chest).toBeGreaterThan(torso);
    expect(legs).toBeCloseTo(0, 6);
  });

  it("locked bones take identity but still transform their own children", () => {
    const parent = makeBone("spine", 500, 0.5, null);
    const arm = { ...makeBone("arm", 400, 0.5, parent.id), locked: true };
    const hand = makeBone("hand", 300, 0.8, arm.id);
    const world = solveSkeleton([parent, arm, hand], 0.4);
    const armW = [...world.values()].find((w) => w.bone.name === "arm")!;
    const handW = [...world.values()].find((w) => w.bone.name === "hand")!;
    // Locked: the arm itself does not rotate with the spine.
    expect(armW.angle).toBeCloseTo(0, 6);
    // ...but its child still rotates about its own local difference.
    expect(handW.angle).toBeCloseTo(0.4 * (0.8 - 0.5), 6);
  });

  it("user pose rotation composes with the driver", () => {
    const bone = { ...makeBone("neck", 400, 1, null), rotation: 0.1 };
    const world = solveSkeleton([bone], 0.3);
    expect(world.get(bone.id)!.angle).toBeCloseTo(0.1 + 0.3, 6);
  });
});
