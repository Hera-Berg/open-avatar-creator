import { describe, it, expect } from "vitest";
import { generateMesh, subdivideQuad, invertedTriangles, triangleSignedArea } from "../src/geometry/triangulate";
import { traceContour, douglasPeucker } from "../src/geometry/contour";
import { applyCorrectives, correctiveWeight, correctiveUnreachable } from "../src/correctives";
import { blobImage, rectImage } from "./helpers";
import type { OarCorrective } from "../src/model/types";
import { withDriverDefaults } from "../src/model/params";

describe("mesh generation", () => {
  it("generates a valid mesh from a blob", () => {
    const img = blobImage(100, 100, 40);
    const mesh = generateMesh("m1", img, 50, 60, "coarse");
    expect(mesh.vertices.length).toBeGreaterThan(10);
    expect(mesh.triangles.length).toBeGreaterThan(5);
    for (const [a, b, c] of mesh.triangles) {
      expect(a).not.toBe(b);
      expect(mesh.vertices[a]).toBeDefined();
      expect(mesh.vertices[b]).toBeDefined();
      expect(mesh.vertices[c]).toBeDefined();
    }
    // Offset applied: vertices are in canvas space.
    const xs = mesh.vertices.map((v) => v[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...xs)).toBeLessThanOrEqual(155);
    // UVs within 0..1.
    for (const [u, v] of mesh.uvs) {
      expect(u).toBeGreaterThanOrEqual(-0.01);
      expect(u).toBeLessThanOrEqual(1.01);
      expect(v).toBeGreaterThanOrEqual(-0.01);
      expect(v).toBeLessThanOrEqual(1.01);
    }
    expect(invertedTriangles(mesh.vertices, mesh.vertices, mesh.triangles)).toEqual([]);
  });

  it("falls back to a quad when no contour exists", () => {
    const img = rectImage(10, 10, { x: 0, y: 0, width: 0, height: 0 });
    const mesh = generateMesh("m2", img, 0, 0, "coarse");
    expect(mesh.triangles.length).toBeGreaterThan(0);
  });

  it("density presets scale vertex counts", () => {
    const img = blobImage(200, 200, 90);
    const coarse = generateMesh("a", img, 0, 0, "coarse");
    const fine = generateMesh("b", img, 0, 0, "fine");
    expect(fine.vertices.length).toBeGreaterThan(coarse.vertices.length);
  });

  it("subdivideQuad builds a regular grid", () => {
    const q = subdivideQuad("q", 10, 20, 100, 50, 4, 2);
    expect(q.vertices.length).toBe(5 * 3);
    expect(q.triangles.length).toBe(4 * 2 * 2);
    expect(q.vertices[0]).toEqual([10, 20]);
  });

  it("contour tracing finds the blob outline", () => {
    const img = blobImage(60, 60, 20);
    const contour = traceContour(img, 8, 2);
    expect(contour.length).toBeGreaterThan(4);
    const simplified = douglasPeucker(contour, 2);
    expect(simplified.length).toBeLessThanOrEqual(contour.length);
  });

  it("inverted triangles are detected after a vertex is dragged past its neighbour", () => {
    const q = subdivideQuad("q", 0, 0, 10, 10, 1, 1);
    const rest = q.vertices.map((v) => [...v] as [number, number]);
    // Drag vertex 1 (top-right) down past the bottom edge: flips winding.
    const current = rest.map((v) => [...v] as [number, number]);
    current[1] = [10, 20];
    const bad = invertedTriangles(rest, current, q.triangles);
    expect(bad.length).toBeGreaterThan(0);
    expect(triangleSignedArea([0, 0], [10, 0], [0, 10])).toBeGreaterThan(0);
  });
});

describe("correctives", () => {
  const corr: OarCorrective = {
    id: "c1",
    name: "test",
    meshId: "m1",
    driver: { param: "head_roll", value: 1, falloff: 0.6, param2: null, value2: 0, falloff2: 0.5 },
    offsets: { "3": [10, -5] },
  };

  it("weight is 1 at the keyed value, 0 beyond the falloff", () => {
    expect(correctiveWeight(corr.driver, withDriverDefaults({ head_roll: 1 }))).toBeCloseTo(1, 5);
    expect(correctiveWeight(corr.driver, withDriverDefaults({ head_roll: 0.2 }))).toBe(0);
    const mid = correctiveWeight(corr.driver, withDriverDefaults({ head_roll: 0.7 }));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("applies offsets scaled by weight after skinning", () => {
    const positions: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    applyCorrectives([corr], "m1", positions, withDriverDefaults({ head_roll: 1 }));
    expect(positions[3]).toEqual([13, -2]);
    expect(positions[0]).toEqual([0, 0]);
  });

  it("two-parameter correctives multiply weights", () => {
    const c2: OarCorrective = {
      ...corr,
      driver: { param: "head_roll", value: 1, falloff: 0.6, param2: "head_pitch", value2: 1, falloff2: 0.6 },
    };
    const both = correctiveWeight(c2.driver, withDriverDefaults({ head_roll: 1, head_pitch: 1 }));
    const one = correctiveWeight(c2.driver, withDriverDefaults({ head_roll: 1, head_pitch: 0 }));
    expect(both).toBeCloseTo(1, 5);
    expect(one).toBe(0);
  });

  it("warns when the driver can never reach its keyed value", () => {
    expect(correctiveUnreachable(corr.driver, { head_roll: { min: -0.6, max: 0.6 } })).toBe(true);
    expect(correctiveUnreachable(corr.driver, { head_roll: { min: -1, max: 1 } })).toBe(false);
  });
});
