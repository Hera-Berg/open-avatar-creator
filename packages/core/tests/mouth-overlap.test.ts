import { describe, it, expect } from "vitest";
import {
  buildApertureMesh,
  apertureArea,
  APERTURE_ROWS,
  computeMouthDeform,
  deformAperture,
  type MouthShapes,
} from "../src/face/mouth";
import { rectImage } from "./helpers";

/** Real rigs draw the upper lip OVER the lower at rest: the traced inner
 *  edges cross. The aperture must clamp to per-column coincidence or it
 *  self-intersects and sheds fragments (the stray triangle artefact). */
describe("aperture with overlapping lip artwork", () => {
  const UPPER_RECT = { x: 200, y: 100, width: 60, height: 30 };
  const LOWER_RECT = { x: 200, y: 100, width: 60, height: 30 };

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

  function buildOverlapping() {
    // Upper lip: opaque rows 0..24 (inner edge at 24 → canvas 124).
    const upperImg = rectImage(60, 30, { x: 0, y: 0, width: 60, height: 25 });
    // Lower lip: opaque rows 5..29 (inner edge at 5 → canvas 105) — the two
    // edges CROSS: upper edge (124) is BELOW lower edge (105) at rest.
    const lowerImg = rectImage(60, 30, { x: 0, y: 5, width: 60, height: 25 });
    const mesh = buildApertureMesh("m_ap", upperImg, UPPER_RECT, lowerImg, LOWER_RECT);
    if (!mesh) throw new Error("aperture build failed");
    return mesh;
  }

  it("clamps crossed boundaries to zero area at rest", () => {
    const mesh = buildOverlapping();
    const positions = mesh.vertices.map((v) => [...v] as [number, number]);
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    deformAperture(
      positions,
      mesh.vertices,
      APERTURE_ROWS,
      UPPER_RECT,
      LOWER_RECT,
      computeMouthDeform(neutral, 40, 60, cx, 0),
    );
    expect(apertureArea(positions, APERTURE_ROWS)).toBeLessThan(1e-6);
    // And per column: top boundary never crosses below the bottom boundary.
    const columns = Math.round(positions.length / APERTURE_ROWS);
    for (let c = 0; c < columns; c++) {
      const top = positions[c]!;
      const bottom = positions[(APERTURE_ROWS - 1) * columns + c]!;
      expect(bottom[1]).toBeGreaterThanOrEqual(top[1]);
    }
  });

  it("still opens correctly from the clamped rest", () => {
    const mesh = buildOverlapping();
    const positions = mesh.vertices.map((v) => [...v] as [number, number]);
    const cx = UPPER_RECT.x + UPPER_RECT.width / 2;
    deformAperture(
      positions,
      mesh.vertices,
      APERTURE_ROWS,
      UPPER_RECT,
      LOWER_RECT,
      computeMouthDeform({ ...neutral, jawOpen: 1 }, 40, 60, cx, 0),
    );
    expect(apertureArea(positions, APERTURE_ROWS)).toBeGreaterThan(200);
  });
});
