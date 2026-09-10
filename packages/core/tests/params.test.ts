import { describe, it, expect } from "vitest";
import {
  DRIVER_DEFAULTS,
  DRIVER_SLIDERS,
  RIG_PARAM_DEFAULTS,
  withDriverDefaults,
  rigParam,
  type DriverParam,
} from "../src/model/params";

describe("sliders vs defaults", () => {
  it("every slider key exists in DRIVER_DEFAULTS", () => {
    for (const slider of DRIVER_SLIDERS) {
      expect(
        Object.prototype.hasOwnProperty.call(DRIVER_DEFAULTS, slider.key),
        `slider "${slider.key}" has no default — a missing default becomes NaN and the layer vanishes silently`,
      ).toBe(true);
    }
  });

  it("every default is reachable from a slider", () => {
    const sliderKeys = new Set(DRIVER_SLIDERS.map((s) => s.key));
    for (const key of Object.keys(DRIVER_DEFAULTS)) {
      expect(sliderKeys.has(key as DriverParam), `param "${key}" has no slider`).toBe(true);
    }
  });

  it("withDriverDefaults never returns NaN for missing/garbage input", () => {
    const out = withDriverDefaults({ head_yaw: undefined, mouth_open: Number.NaN } as never);
    for (const v of Object.values(out)) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(out.head_yaw).toBe(DRIVER_DEFAULTS.head_yaw);
  });

  it("rigParam falls back to defaults for absent keys", () => {
    expect(rigParam({}, "blinkFloor")).toBe(RIG_PARAM_DEFAULTS.blinkFloor);
    expect(rigParam({ blinkFloor: 0.5 }, "blinkFloor")).toBe(0.5);
    expect(rigParam({ blinkFloor: Number.NaN }, "blinkFloor")).toBe(RIG_PARAM_DEFAULTS.blinkFloor);
  });
});
