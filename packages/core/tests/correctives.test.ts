import { describe, it, expect } from "vitest";
import { correctiveWeight, dominantParam } from "../src/correctives/index";
import { withDriverDefaults, DRIVER_DEFAULTS } from "../src/model/params";

describe("dominantParam (paused-edit corrective keying)", () => {
  it("a closed eye beats the still-open one (eyes rest at 1, not 0)", () => {
    // The exact reported pose: right eye closed, left eye open, head X -0.01.
    const p = withDriverDefaults({ eye_r_open: 0, head_x: -0.01 });
    expect(dominantParam(p)).toBe("eye_r_open");
  });

  it("a shoulder roll pose still keys head_roll", () => {
    const p = withDriverDefaults({ head_roll: -1 });
    expect(dominantParam(p)).toBe("head_roll");
  });

  it("an all-rest pose returns a stable default", () => {
    const p = withDriverDefaults({});
    expect(dominantParam(p)).toBe("head_yaw"); // first key, all distances 0
  });

  it("half-open eye at 0.5 beats a small head lean", () => {
    const p = withDriverDefaults({ eye_l_open: 0.5, head_x: 0.2 });
    expect(dominantParam(p)).toBe("eye_l_open");
  });
});

describe("correctiveWeight", () => {
  it("is 1 at the keyed value and 0 beyond the falloff", () => {
    const driver = { param: "eye_r_open", value: 0, falloff: 1, param2: null, value2: 0, falloff2: 0.5 };
    const closed = withDriverDefaults({ eye_r_open: 0 });
    const open = withDriverDefaults({ eye_r_open: 1 });
    expect(correctiveWeight(driver, closed)).toBe(1);
    expect(correctiveWeight(driver, open)).toBe(0);
  });

  it("springs smoothly across the range", () => {
    const driver = { param: "eye_r_open", value: 0, falloff: 1, param2: null, value2: 0, falloff2: 0.5 };
    const half = withDriverDefaults({ eye_r_open: 0.5 });
    const w = correctiveWeight(driver, half);
    expect(w).toBeGreaterThan(0.4);
    expect(w).toBeLessThan(0.6);
  });

  it("defaults: every driver param has a rest default (keying never NaNs)", () => {
    for (const v of Object.values(DRIVER_DEFAULTS)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
