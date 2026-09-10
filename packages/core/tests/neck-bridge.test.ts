import { describe, it, expect } from "vitest";
import { solveModel, createSolveContext } from "../src/solve";
import { subdivideQuad } from "../src/geometry/triangulate";
import { emptyRig, type OarManifest } from "../src/model/types";
import { makeModel, makeLayer, makeBone } from "./helpers";

/** §7: the neck is a joint, not a body part. At full yaw the head-turn warp
 *  slides the head sideways; the neck must fade that same warp from full at
 *  its top to zero at its base, or a gap opens at the jaw. */
describe("neck bridging under head turn", () => {
  function build() {
    const headBone = makeBone("head", 500, 1.0, null, 450);
    const neckMesh = subdivideQuad("m_neck", 400, 500, 100, 200, 2, 6);
    const headLayer = makeLayer({
      id: "l_head",
      name: "head",
      slot: "head",
      x: 300,
      y: 100,
      width: 300,
      height: 400,
      boneId: headBone.id,
      order: 5,
    });
    const neckLayer = makeLayer({
      id: "l_neck",
      name: "Neck",
      slot: "neck",
      x: 400,
      y: 500,
      width: 100,
      height: 200,
      mesh: neckMesh.id,
      order: 2,
    });
    const rig = emptyRig();
    rig.head = { centre: [450, 300], radius: [150, 200] };
    const model: OarManifest = makeModel({
      layers: [headLayer, neckLayer],
      bones: [headBone],
      meshes: [neckMesh],
      rig,
    });
    return model;
  }

  it("neck top follows the head's warp, neck base stays planted", () => {
    const model = build();
    const ctx = createSolveContext();
    ctx.meshes = new Map(model.meshes.map((m) => [m.id, m]));
    const solved = solveModel(model, { head_yaw: 1 }, ctx);

    const neck = solved.layers.find((l) => l.id === "l_neck")!;
    const head = solved.layers.find((l) => l.id === "l_head")!;

    // Head centre displacement.
    const headCx = head.positions.reduce((s, p) => s + p[0], 0) / head.positions.length;
    const headShift = headCx - 450;

    // Neck verts: top rows (v=0) vs bottom rows (v=1).
    const mesh = model.meshes.find((m) => m.id === "m_neck")!;
    const top = neck.positions.filter((_, i) => mesh.uvs[i]![1] === 0);
    const bottom = neck.positions.filter((_, i) => mesh.uvs[i]![1] === 1);
    const topCx = top.reduce((s, p) => s + p[0], 0) / top.length;
    const bottomCx = bottom.reduce((s, p) => s + p[0], 0) / bottom.length;

    expect(Math.abs(headShift)).toBeGreaterThan(5); // head actually moved
    // The neck top rides along with the head…
    expect(Math.abs(topCx - 450)).toBeGreaterThan(Math.abs(headShift) * 0.6);
    // …while the base stays essentially planted.
    expect(Math.abs(bottomCx - 450)).toBeLessThan(Math.abs(headShift) * 0.1);
    // Continuity at the jaw: the neck top's displacement matches the head
    // layer's displacement at the same x (the warp is x-position-driven, so
    // this is the real "no gap at the jaw" condition).
    const neckTopShift = topCx - 450;
    const headMesh = ctx.meshCache.get("l_head")!;
    let jawShift = 0;
    let bestDist = Infinity;
    headMesh.vertices.forEach((v, i) => {
      const d = Math.abs(v[0] - 450) + Math.abs(v[1] - 480);
      if (d < bestDist) {
        bestDist = d;
        jawShift = head.positions[i]![0] - v[0];
      }
    });
    // The un-bridged failure mode is 100% of the shift (~57px); a few px of
    // fade interpolation between sampled rows is expected.
    expect(Math.abs(neckTopShift - jawShift)).toBeLessThan(6);
  });

  it("rest pose is the identity", () => {
    const model = build();
    const ctx = createSolveContext();
    ctx.meshes = new Map(model.meshes.map((m) => [m.id, m]));
    const solved = solveModel(model, {}, ctx);
    const neck = solved.layers.find((l) => l.id === "l_neck")!;
    const mesh = model.meshes.find((m) => m.id === "m_neck")!;
    neck.positions.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(mesh.vertices[i]![0], 4);
      expect(p[1]).toBeCloseTo(mesh.vertices[i]![1], 4);
    });
  });
});
