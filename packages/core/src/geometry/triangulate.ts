// Mesh generation: alpha contour -> simplify -> interior Steiner points ->
// constrained Delaunay triangulation (poly2tri; never Shewchuk's Triangle —
// licence incompatible). Falls back to a centroid fan if CDT fails.

import { SweepContext, type XY } from "poly2tri";
import type { Vec2, OarMesh } from "../model/types";
import type { PixelImage } from "./pixels";
import { traceContour } from "./contour";

export type MeshDensity = "coarse" | "medium" | "fine";

const DENSITY_TARGET: Record<MeshDensity, number> = {
  coarse: 40,
  medium: 120,
  fine: 400,
};

function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

interface IndexedPoint extends XY {
  _idx: number;
}

export function triangulate(contour: Vec2[], steiner: Vec2[]): [number, number, number][] {
  const all = contour.concat(steiner);
  try {
    // poly2tri preserves custom fields on input points in its output, so the
    // vertex index rides through the triangulation.
    const pts: IndexedPoint[] = all.map(([x, y], i) => ({ x, y, _idx: i }));
    const ctx = new SweepContext(pts.slice(0, contour.length));
    if (steiner.length > 0) ctx.addPoints(pts.slice(contour.length));
    ctx.triangulate();
    const tris = ctx.getTriangles();
    const out: [number, number, number][] = [];
    for (const t of tris) {
      const a = (t.getPoint(0) as IndexedPoint)._idx;
      const b = (t.getPoint(1) as IndexedPoint)._idx;
      const c = (t.getPoint(2) as IndexedPoint)._idx;
      if (a !== b && b !== c && a !== c) out.push([a, b, c]);
    }
    if (out.length > 0) return out;
  } catch {
    // fall through to fan
  }
  // Fallback: centroid fan over the contour (no Steiner support).
  const cx = contour.reduce((s, p) => s + p[0], 0) / contour.length;
  const cy = contour.reduce((s, p) => s + p[1], 0) / contour.length;
  all.push([cx, cy]);
  const ci = all.length - 1;
  const out: [number, number, number][] = [];
  for (let i = 0; i < contour.length; i++) {
    out.push([ci, i, (i + 1) % contour.length]);
  }
  return out;
}

/**
 * Generate a mesh for a layer image. Contour and vertices are in image
 * space; `offsetX/Y` (layer position on canvas) shifts them to canvas space.
 * UVs are normalised across the image rect.
 */
export function generateMesh(
  id: string,
  img: PixelImage,
  offsetX: number,
  offsetY: number,
  density: MeshDensity = "coarse",
): OarMesh {
  const contourLocal = traceContour(img, 8, 2);
  if (contourLocal.length < 3) {
    return subdivideQuad(id, offsetX, offsetY, img.width, img.height, 2, 2);
  }

  // Interior Steiner points on a grid sized to hit the density target.
  const xs = contourLocal.map((p) => p[0]);
  const ys = contourLocal.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const target = DENSITY_TARGET[density];
  const contourCount = contourLocal.length;
  const interiorTarget = Math.max(4, target - contourCount);
  const aspect = Math.max(0.2, (maxX - minX) / Math.max(1, maxY - minY));
  let rows = Math.max(2, Math.round(Math.sqrt(interiorTarget / aspect)));
  let cols = Math.max(2, Math.round(rows * aspect));
  const steiner: Vec2[] = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const x = minX + ((maxX - minX) * c) / (cols + 1);
      const y = minY + ((maxY - minY) * r) / (rows + 1);
      if (pointInPolygon(x, y, contourLocal)) steiner.push([x, y]);
    }
  }
  // If the polygon is thin and swallowed no grid points, drop a centreline.
  if (steiner.length === 0) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    steiner.push([cx, cy]);
  }

  const local = contourLocal.concat(steiner);
  const tris = triangulate(contourLocal, steiner);

  // Drop triangles whose centroid sits outside the alpha shape.
  const kept = tris.filter(([a, b, c]) => {
    const cx = (local[a]![0] + local[b]![0] + local[c]![0]) / 3;
    const cy = (local[a]![1] + local[b]![1] + local[c]![1]) / 3;
    return pointInPolygon(cx, cy, contourLocal);
  });

  const vertices: Vec2[] = local.map(([x, y]) => [x + offsetX, y + offsetY]);
  const uvs: Vec2[] = local.map(([x, y]) => [
    img.width > 0 ? x / img.width : 0,
    img.height > 0 ? y / img.height : 0,
  ]);
  return {
    id,
    vertices,
    uvs,
    triangles: kept.length > 0 ? kept : tris,
    weights: vertices.map(() => ({})),
  };
}

/** Grid-subdivided quad. Plain layers get this at render time so warps and
 *  physics have vertices to work with. */
export function subdivideQuad(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  cols: number,
  rows: number,
): OarMesh {
  const vertices: Vec2[] = [];
  const uvs: Vec2[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const v = r / rows;
      vertices.push([x + u * width, y + v * height]);
      uvs.push([u, v]);
    }
  }
  const triangles: [number, number, number][] = [];
  const idx = (c: number, r: number) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = idx(c, r);
      const b = idx(c + 1, r);
      const d = idx(c, r + 1);
      const e = idx(c + 1, r + 1);
      triangles.push([a, b, d], [b, e, d]);
    }
  }
  return { id, vertices, uvs, triangles, weights: vertices.map(() => ({})) };
}

/** Signed area of a triangle; negative means inverted (texture renders
 *  inside-out). Used by the editor's inverted-triangle guard. */
export function triangleSignedArea(
  a: Vec2,
  b: Vec2,
  c: Vec2,
): number {
  return (
    ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
  );
}

/**
 * Indices of triangles whose winding flipped relative to the rest mesh — a
 * vertex dragged past its neighbours inverts them and the texture renders
 * inside-out. The editor flags these in red.
 */
export function invertedTriangles(
  restVertices: Vec2[],
  currentPositions: Vec2[],
  triangles: [number, number, number][],
): number[] {
  const bad: number[] = [];
  triangles.forEach((tri, i) => {
    const rest = triangleSignedArea(restVertices[tri[0]]!, restVertices[tri[1]]!, restVertices[tri[2]]!);
    const cur = triangleSignedArea(currentPositions[tri[0]]!, currentPositions[tri[1]]!, currentPositions[tri[2]]!);
    if (rest !== 0 && cur !== 0 && Math.sign(rest) !== Math.sign(cur)) bad.push(i);
  });
  return bad;
}
