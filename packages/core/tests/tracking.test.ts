import { describe, it, expect } from "vitest";
import { parseFrame, ParamSmoother } from "../src/tracking/adapter";

const OPTS = { blinkFloor: 0.32, mouthGain: 1.6 };

// The example frame from open-avatar-tracker/examples/tracking-frame.json.
const TRACKING_FRAME = JSON.stringify({
  type: "tracking.frame",
  version: "1.0.0",
  sequence: 4812,
  timestamp: 1785490105123,
  source: { tracker: "mediapipe-face-landmarker" },
  performance: { trackingFps: 52.7 },
  face: {
    present: true,
    presence: 0.99,
    head: { yaw: -0.14, pitch: 0.08, roll: -0.03, x: 0.02, y: -0.01, z: -0.05 },
    eyes: {
      left: { open: 0.91, blink: 0.09, closed: false, confidence: 0.99 },
      right: { open: 0.89, blink: 0.11, closed: false, confidence: 0.99 },
      gazeX: -0.1,
      gazeY: 0.05,
    },
    mouth: { open: 0.18, form: 0.07, smile: 0.11, pucker: 0.04, x: -0.02, confidence: 0.99 },
    brows: { leftY: 0.02, rightY: 0.01 },
  },
});

describe("tracking adapter", () => {
  it("maps tracking.frame to driver params", () => {
    const out = parseFrame(TRACKING_FRAME, OPTS)!;
    expect(out.present).toBe(true);
    expect(out.sequence).toBe(4812);
    expect(out.params.head_yaw).toBeCloseTo(-0.14, 6);
    expect(out.params.head_pitch).toBeCloseTo(0.08, 6);
    expect(out.params.gaze_x).toBeCloseTo(-0.1, 6);
    expect(out.params.brow_l).toBeCloseTo(0.02, 6);
  });

  it("applies the blink floor exactly once", () => {
    const out = parseFrame(TRACKING_FRAME, OPTS)!;
    expect(out.params.eye_l_open).toBeCloseTo((0.91 - 0.32) / 0.68, 5);
    expect(out.params.eye_r_open).toBeCloseTo((0.89 - 0.32) / 0.68, 5);
  });

  it("applies mouth gain exactly once", () => {
    const out = parseFrame(TRACKING_FRAME, OPTS)!;
    expect(out.params.mouth_open).toBeCloseTo(0.18 * 1.6, 5);
  });

  it("absent frames report present=false", () => {
    const absent = JSON.stringify({
      type: "tracking.frame",
      version: "1.0.0",
      sequence: 9,
      timestamp: 1,
      status: "searching",
      face: { present: false, presence: 0 },
    });
    const out = parseFrame(absent, OPTS)!;
    expect(out.present).toBe(false);
  });

  it("debug frames carry blendshapes", () => {
    const debug = JSON.stringify({
      type: "tracking.debug",
      version: "1.0.0",
      sequence: 10,
      timestamp: 1,
      blendshapes: { jawOpen: 0.4, mouthSmileLeft: 0.7 },
      landmarks: [],
      facialTransformationMatrix: null,
    });
    const out = parseFrame(debug, OPTS)!;
    expect(out.blendshapes?.jawOpen).toBeCloseTo(0.4, 6);
    expect(out.blendshapes?.mouthSmileLeft).toBeCloseTo(0.7, 6);
  });

  it("accepts the brief's draft frame format", () => {
    const draft = JSON.stringify({
      type: "frame",
      frame_id: 1834,
      found: true,
      blendshapes: { jawOpen: 0.31 },
      head: { pitch: -2.14, yaw: 11.87, roll: 0.92, tx: 0.4, ty: -1.2, tz: -31.8 },
      params: { head_yaw: 0.26, eye_l_open: 0.95, mouth_open: 0.2 },
    });
    const out = parseFrame(draft, OPTS)!;
    expect(out.present).toBe(true);
    expect(out.params.head_yaw).toBeCloseTo(0.26, 6);
    expect(out.params.eye_l_open).toBeCloseTo((0.95 - 0.32) / 0.68, 5);
    expect(out.params.mouth_open).toBeCloseTo(0.2 * 1.6, 5);
    expect(out.blendshapes?.jawOpen).toBeCloseTo(0.31, 6);
  });

  it("garbage returns null", () => {
    expect(parseFrame("not json", OPTS)).toBeNull();
    expect(parseFrame('{"type":"mystery"}', OPTS)).toBeNull();
  });

  it("eye params get a quarter of the configured smoothing", () => {
    const sm = new ParamSmoother();
    sm.update({ head_yaw: 0, eye_l_open: 1 }, 0.8); // seed
    const next = sm.update({ head_yaw: 1, eye_l_open: 0 }, 0.8);
    // head: 0 + (1-0) × (1−0.8) = 0.2
    expect(next.head_yaw).toBeCloseTo(0.2, 5);
    // eye: quarter smoothing 0.2 → 1 + (0−1) × (1−0.2) = 0.2
    expect(next.eye_l_open).toBeCloseTo(0.2, 5);
  });
});
