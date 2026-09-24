import { describe, it, expect } from "vitest";
import { headTurnX, isMonotonic } from "../src/headturn/warp";
import { degToRad } from "../src/geometry/util";

describe("head-turn warp", () => {
  it("is monotonic across the full angle range (no silhouette foldback)", () => {
    for (const deg of [0, 15, 26, 30, 45, 60, -15, -45]) {
      expect(isMonotonic(degToRad(deg)), `yaw ${deg}°`).toBe(true);
    }
  });

  it("a true circular profile would fold back past ~26° (the bump warp does not)", () => {
    // Sanity: circular z = sqrt(1-u²) reverses slope beyond the silhouette.
    const angle = degToRad(45);
    const circular = (u: number) => {
      const z = Math.sqrt(Math.max(0, 1 - u * u));
      return u * Math.cos(angle) + z * Math.sin(angle);
    };
    let prev = -Infinity;
    let folded = false;
    for (let u = -1.5; u <= 1.5; u += 0.01) {
      const x = circular(u);
      if (x < prev) folded = true;
      prev = x;
    }
    expect(folded).toBe(true); // confirms a projected profile is unsafe
    expect(isMonotonic(angle)).toBe(true);
  });

  it("identity at zero angle", () => {
    expect(headTurnX(0.5, 0, 100, 200)).toBeCloseTo(100 + 0.5 * 200, 6);
  });

  it("keeps the head's size: the warp's outer edges do not move", () => {
    const angle = degToRad(30);
    for (const u of [-4, -3, 3, 4]) {
      expect(headTurnX(u, angle, 0, 100)).toBeCloseTo(u * 100, 6);
    }
  });

  it("slides the features toward the turn with a gentle near/far scale change", () => {
    const angle = degToRad(30); // full yaw at the default headTurnDeg
    const scale = (u: number) => (headTurnX(u + 1e-4, angle, 0, 1) - headTurnX(u - 1e-4, angle, 0, 1)) / 2e-4;
    expect(headTurnX(0, angle, 0, 100)).toBeGreaterThan(20); // centre moves
    // The eyes sit near u = ±0.5: neither is crushed nor ballooned.
    expect(scale(-0.5)).toBeGreaterThan(0.75);
    expect(scale(0.5)).toBeGreaterThan(0.75);
    expect(scale(-0.5)).toBeLessThan(1.25);
    expect(scale(0.5)).toBeLessThan(1.25);
    // Across the whole face the far side keeps well over half its width.
    for (let u = -1; u <= 1; u += 0.05) expect(scale(u)).toBeGreaterThan(0.6);
  });

  it("an extreme depth is capped so the mapping still never folds", () => {
    for (const deg of [10, 30, 60, 89]) {
      expect(isMonotonic(degToRad(deg), 100, 50), `${deg}° depth 50`).toBe(true);
    }
  });
});
