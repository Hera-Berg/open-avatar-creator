import { describe, it, expect } from "vitest";
import {
  APERTURE_ROWS,
  buildApertureMesh,
  computeMouthDeform,
  deformMouthPoint,
  deformAperture,
  apertureArea,
  shapesFromBlendshapes,
  type MouthShapes,
} from "../src/face/mouth";
import { rectImage } from "./helpers";

// Upper lip: 60x20 image, opaque top 15 rows (inner edge at row 14), at (200,100).
// Lower lip: 60x20 image, opaque bottom 15 rows (inner edge at row 5), at (200,109)
// so both inner edges coincide at canvas y = 114 at rest.
const UPPER_RECT = { x: 200, y: 100, width: 60, height: 20 };
const LOWER_RECT = { x: 200, y: 109, width: 60, height: 20 };

function makeAperture() {
  const upperImg = rectImage(60, 20, { x: 0, y: 0, width: 60, height: 15 });
  const lowerImg = rectImage(60, 20, { x: 0, y: 5, width: 60, height: 15 });
  const mesh = buildApertureMesh("m_ap", upperImg, UPPER_RECT, lowerImg, LOWER_RECT);
  if (!mesh) throw new Error("aperture build failed");
  return mesh;
}

const neutral: MouthShapes = {
  jawOpen: 0,
  upperUp: 0,
  lowerDown: 0,
  pucker: 0,
  stretch: 0,
  smileL: 0,
  smileR: 0,
  frown: 0,
};

describe("mouth aperture", () => {
  it("at openness = 0 the aperture mesh has zero area", () => {
    const mesh = makeAperture();
    const positions = mesh.vertices.map((v) => [...v] as [number, number]);
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    const state = computeMouthDeform(neutral, 40, 60, cx, 0);
    deformAperture(positions, mesh.vertices, APERTURE_ROWS, UPPER_RECT, LOWER_RECT, state);
    expect(apertureArea(positions, APERTURE_ROWS)).toBeLessThan(1e-6);
  });

  it("opens with the lips: area grows with jawOpen", () => {
    const mesh = makeAperture();
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    const open: MouthShapes = { ...neutral, jawOpen: 1 };
    const positions = mesh.vertices.map((v) => [...v] as [number, number]);
    const state = computeMouthDeform(open, 40, 60, cx, 0);
    deformAperture(positions, mesh.vertices, APERTURE_ROWS, UPPER_RECT, LOWER_RECT, state);
    expect(apertureArea(positions, APERTURE_ROWS)).toBeGreaterThan(500);
  });

  it("lip outer edges do not drift when sweeping openness 0→1", () => {
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    for (const open of [0, 0.25, 0.5, 0.75, 1]) {
      const shapes: MouthShapes = { ...neutral, jawOpen: open };
      const state = computeMouthDeform(shapes, 40, 60, cx, 0);
      // Upper lip outer edge = rect top (t=0).
      const [x1, y1] = deformMouthPoint(230, UPPER_RECT.y, UPPER_RECT, "upper", state);
      expect(Math.abs(y1 - UPPER_RECT.y)).toBeLessThan(1);
      expect(Math.abs(x1 - 230)).toBeLessThan(1);
      // Lower lip outer edge = rect bottom.
      const [, y2] = deformMouthPoint(
        230,
        LOWER_RECT.y + LOWER_RECT.height,
        LOWER_RECT,
        "lower",
        state,
      );
      expect(Math.abs(y2 - (LOWER_RECT.y + LOWER_RECT.height))).toBeLessThan(1);
    }
  });

  it("pucker narrows to ~66%, stretch widens to ~122%", () => {
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    const pucker = computeMouthDeform({ ...neutral, pucker: 1 }, 40, 60, cx, 0);
    expect(pucker.xScale).toBeCloseTo(0.66, 2);
    const stretch = computeMouthDeform({ ...neutral, stretch: 1 }, 40, 60, cx, 0);
    expect(stretch.xScale).toBeCloseTo(1.22, 2);
    // Pucker rounds the opening: edge opening multiplied down at the corners.
    const state = computeMouthDeform({ ...neutral, jawOpen: 1, pucker: 1 }, 40, 60, cx, 0);
    const mid = deformMouthPoint(cx, UPPER_RECT.y + 20, UPPER_RECT, "upper", state);
    const corner = deformMouthPoint(cx + 28, UPPER_RECT.y + 20, UPPER_RECT, "upper", state);
    const midTravel = UPPER_RECT.y + 20 - mid[1];
    const cornerTravel = UPPER_RECT.y + 20 - corner[1];
    expect(cornerTravel).toBeLessThan(midTravel * 0.5);
  });

  it("one-sided smile lifts only that corner (a smirk survives)", () => {
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    const shapes: MouthShapes = { ...neutral, smileL: 1, smileR: 0 };
    const state = computeMouthDeform(shapes, 40, 60, cx, 0);
    // Character's left = canvas right (u > 0).
    const [, yCharLeft] = deformMouthPoint(cx + 25, UPPER_RECT.y, UPPER_RECT, "upper", state);
    const [, yCharRight] = deformMouthPoint(cx - 25, UPPER_RECT.y, UPPER_RECT, "upper", state);
    expect(yCharLeft).toBeLessThan(UPPER_RECT.y - 2); // lifted
    expect(yCharRight).toBeCloseTo(UPPER_RECT.y, 1); // untouched
  });

  it("real per-lip blendshapes beat the jaw estimate", () => {
    const shapes = shapesFromBlendshapes(
      0.3,
      { mouthUpperUpLeft: 0.9, mouthUpperUpRight: 0.9, mouthLowerDownLeft: 0.1, mouthLowerDownRight: 0.1 },
      0,
      0,
    );
    const state = computeMouthDeform(shapes, 40, 60, 230, 0);
    expect(state.openUpper).toBeCloseTo(0.9 * 40, 1); // not 0.3*0.32
    expect(state.openLower).toBeCloseTo(0.3 * 0.68 * 60, 1); // jaw wins here
  });
});
