// Contour tracing: marching squares for mesh outlines, per-column edge traces
// for eyelid contours and lip inner edges, Douglas–Peucker simplification.

import type { Vec2 } from "../model/types";
import type { PixelImage } from "./pixels";

export function douglasPeucker(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length <= 2) return points.slice();
  const [x1, y1] = points[0]!;
  const [x2, y2] = points[points.length - 1]!;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  let maxDist = -1;
  let maxIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]!;
    const dist = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }
  if (maxDist <= epsilon) return [points[0]!, points[points.length - 1]!];
  const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
  const right = douglasPeucker(points.slice(maxIdx), epsilon);
  return left.slice(0, -1).concat(right);
}

function alphaAt(img: PixelImage, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3]!;
}

/**
 * Marching squares over the alpha channel at `threshold`, returning the
 * longest closed loop, simplified by Douglas–Peucker. Coordinates are in
 * image space; callers add the layer offset.
 */
export function traceContour(
  img: PixelImage,
  threshold = 8,
  simplifyEpsilon = 2,
): Vec2[] {
  const { width, height } = img;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && alphaAt(img, x, y) > threshold;

  // Find a starting boundary cell.
  let startX = -1;
  let startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inside(x, y)) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return [];

  // Moore-neighbour boundary tracing.
  const dirs: Vec2[] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const loop: Vec2[] = [];
  let cx = startX;
  let cy = startY;
  let dir = 6; // came from the top
  const maxSteps = width * height * 4 + 16;
  let steps = 0;
  do {
    loop.push([cx, cy]);
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8; // start looking backwards-left of travel
      const nx = cx + dirs[d]![0];
      const ny = cy + dirs[d]![1];
      if (inside(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    steps++;
  } while ((cx !== startX || cy !== startY) && steps < maxSteps);

  return douglasPeucker(loop, simplifyEpsilon);
}

/** For each column, the y of the lowest opaque pixel — the natural lower
 *  boundary of the shape. Used for eyelid contours and the upper lip's
 *  inner edge. Returns image-space points, one per column that has any
 *  opaque pixel. */
export function traceLowerEdge(img: PixelImage, threshold = 8): Vec2[] {
  const pts: Vec2[] = [];
  for (let x = 0; x < img.width; x++) {
    for (let y = img.height - 1; y >= 0; y--) {
      if (alphaAt(img, x, y) > threshold) {
        pts.push([x, y]);
        break;
      }
    }
  }
  return pts;
}

/** For each column, the y of the highest opaque pixel — used for the lower
 *  lip's inner edge. */
export function traceUpperEdge(img: PixelImage, threshold = 8): Vec2[] {
  const pts: Vec2[] = [];
  for (let x = 0; x < img.width; x++) {
    for (let y = 0; y < img.height; y++) {
      if (alphaAt(img, x, y) > threshold) {
        pts.push([x, y]);
        break;
      }
    }
  }
  return pts;
}

/** Sample a polyline contour at x with linear interpolation between points.
 *  The polyline is a per-column trace (x monotonically increasing). */
export function sampleContour(contour: Vec2[], x: number): number | null {
  if (contour.length === 0) return null;
  if (x <= contour[0]![0]) return contour[0]![1];
  const last = contour[contour.length - 1]!;
  if (x >= last[0]) return last[1];
  for (let i = 1; i < contour.length; i++) {
    const [x1, y1] = contour[i - 1]!;
    const [x2, y2] = contour[i]!;
    if (x >= x1 && x <= x2) {
      const t = x2 === x1 ? 0 : (x - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return last[1];
}
