// Mesh editing helpers: local re-triangulation for add/delete vertex.

import { SweepContext, type XY } from "poly2tri";
import type { OarMesh, Vec2 } from "@oar/core";

function triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = triangleArea(p, a, b);
  const d2 = triangleArea(p, b, c);
  const d3 = triangleArea(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Add a vertex by splitting the containing triangle into three. Returns the
 *  new mesh geometry, or null when the point is outside the mesh. */
export function addVertexAt(
  mesh: OarMesh,
  x: number,
  y: number,
  layer: { x: number; y: number; width: number; height: number },
): { vertices: Vec2[]; uvs: Vec2[]; triangles: [number, number, number][]; weights: Record<string, number>[]; newIndex: number } | null {
  for (const [a, b, c] of mesh.triangles) {
    const va = mesh.vertices[a]!;
    const vb = mesh.vertices[b]!;
    const vc = mesh.vertices[c]!;
    if (!pointInTriangle([x, y], va, vb, vc)) continue;
    const newIndex = mesh.vertices.length;
    const vertices = [...mesh.vertices.map((v) => [...v] as Vec2), [x, y] as Vec2];
    // Barycentric UV + weights.
    const area = triangleArea(va, vb, vc) || 1;
    const wa = triangleArea([x, y], vb, vc) / area;
    const wb = triangleArea(va, [x, y], vc) / area;
    const wc = triangleArea(va, vb, [x, y]) / area;
    const uvs = [
      ...mesh.uvs.map((v) => [...v] as Vec2),
      [
        mesh.uvs[a]![0] * wa + mesh.uvs[b]![0] * wb + mesh.uvs[c]![0] * wc,
        mesh.uvs[a]![1] * wa + mesh.uvs[b]![1] * wb + mesh.uvs[c]![1] * wc,
      ] as Vec2,
    ];
    const weights: Record<string, number>[] = mesh.weights.map((w) => ({ ...w }));
    const merged: Record<string, number> = {};
    for (const src of [mesh.weights[a], mesh.weights[b], mesh.weights[c]]) {
      for (const [k, v] of Object.entries(src ?? {})) {
        merged[k] = (merged[k] ?? 0) + v / 3;
      }
    }
    weights.push(merged);
    // Remove the split triangle, add the three splits.
    const rest = mesh.triangles.filter(
      (t) => !(t[0] === a && t[1] === b && t[2] === c),
    );
    rest.push([a, b, newIndex], [b, c, newIndex], [c, a, newIndex]);
    void layer;
    return { vertices, uvs, triangles: rest, weights, newIndex };
  }
  return null;
}

/** Delete a vertex and re-triangulate the hole (its star polygon). Returns
 *  null when the vertex does not exist. */
export function deleteVertexAt(
  mesh: OarMesh,
  index: number,
): { vertices: Vec2[]; uvs: Vec2[]; triangles: [number, number, number][]; weights: Record<string, number>[] } | null {
  if (index < 0 || index >= mesh.vertices.length) return null;
  const touching = mesh.triangles.filter((t) => t.includes(index));
  if (touching.length === 0) {
    // Orphaned vertex: just drop it and remap indices.
    return dropAndRemap(mesh, index, []);
  }
  // Boundary of the star polygon: edges used by exactly one touching triangle.
  const edgeCount = new Map<string, [number, number]>();
  for (const [a, b, c] of touching) {
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      if (p === index || q === index) continue;
      const key = p < q ? `${p}_${q}` : `${q}_${p}`;
      if (edgeCount.has(key)) edgeCount.delete(key);
      else edgeCount.set(key, [p, q]);
    }
  }
  const boundaryEdges = [...edgeCount.values()];
  // Walk the boundary loop.
  const adjacency = new Map<number, number[]>();
  for (const [p, q] of boundaryEdges) {
    (adjacency.get(p) ?? adjacency.set(p, []).get(p)!).push(q);
    (adjacency.get(q) ?? adjacency.set(q, []).get(q)!).push(p);
  }
  const loop: number[] = [];
  if (adjacency.size > 0) {
    const start = [...adjacency.keys()][0]!;
    let current = start;
    let prev = -1;
    do {
      loop.push(current);
      const next = adjacency.get(current)!.find((n) => n !== prev);
      if (next === undefined) break;
      prev = current;
      current = next;
    } while (current !== start && loop.length <= adjacency.size + 2);
  }
  if (loop.length < 3) return null;

  // Triangulate the hole polygon with poly2tri (constrained).
  interface IndexedPoint extends XY {
    _idx: number;
  }
  const holePts: IndexedPoint[] = loop.map((vi) => ({
    x: mesh.vertices[vi]![0],
    y: mesh.vertices[vi]![1],
    _idx: vi,
  }));
  let holeTriangles: [number, number, number][] = [];
  try {
    const ctx = new SweepContext(holePts);
    ctx.triangulate();
    holeTriangles = ctx.getTriangles().map((t) => [
      (t.getPoint(0) as IndexedPoint)._idx,
      (t.getPoint(1) as IndexedPoint)._idx,
      (t.getPoint(2) as IndexedPoint)._idx,
    ]);
  } catch {
    // Fan fallback around the first boundary vertex.
    holeTriangles = [];
    for (let i = 1; i < loop.length - 1; i++) {
      holeTriangles.push([loop[0]!, loop[i]!, loop[i + 1]!]);
    }
  }
  const remaining = mesh.triangles.filter((t) => !t.includes(index));
  return dropAndRemap(mesh, index, [...remaining, ...holeTriangles]);
}

function dropAndRemap(
  mesh: OarMesh,
  index: number,
  triangles: [number, number, number][],
): { vertices: Vec2[]; uvs: Vec2[]; triangles: [number, number, number][]; weights: Record<string, number>[] } {
  const map = new Map<number, number>();
  const vertices: Vec2[] = [];
  const uvs: Vec2[] = [];
  const weights: Record<string, number>[] = [];
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (i === index) continue;
    map.set(i, vertices.length);
    vertices.push([...mesh.vertices[i]!] as Vec2);
    uvs.push([...mesh.uvs[i]!] as Vec2);
    weights.push({ ...(mesh.weights[i] ?? {}) });
  }
  const remapped = triangles
    .map(([a, b, c]) => [map.get(a), map.get(b), map.get(c)] as [number, number, number])
    .filter(([a, b, c]) => a !== undefined && b !== undefined && c !== undefined)
    .map(([a, b, c]) => [a!, b!, c!] as [number, number, number]);
  return { vertices, uvs, triangles: remapped, weights };
}
