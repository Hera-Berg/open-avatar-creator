import { describe, it, expect } from "vitest";
import { headTurnX, isMonotonic } from "../src/headturn/warp";
import { degToRad } from "../src/geometry/util";

describe("head-turn warp", () => {
  it("is monotonic across the full angle range (no silhouette foldback)", () => {
    for (const deg of [0, 15, 26, 30, 45, 60, -15, -45]) {
      expect(isMonotonic(degToRad(deg)), `yaw ${deg}°`).toBe(true);
    }
  });

  it("a true circular profile would fold back past ~26° (parabolic does not)", () => {
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
    expect(folded).toBe(true); // confirms the parabola is load-bearing
    expect(isMonotonic(angle)).toBe(true);
  });

  it("identity at zero angle", () => {
    expect(headTurnX(0.5, 0, 100, 200)).toBeCloseTo(100 + 0.5 * 200, 6);
  });
});
