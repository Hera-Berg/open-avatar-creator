// Websocket frame → driver parameters. This module owns the protocol
// mapping in one place, plus the two signal fixes that must apply to every
// consumer identically: the blink floor and the mouth gain.
//
// Real tracker (open-avatar-tracker, port 3000):
//   /ws/v1/tracking → {"type":"tracking.frame", face:{head, eyes, mouth, brows}}
//   /ws/v1/debug    → {"type":"tracking.debug", blendshapes:{...52...}, ...}
// The brief's draft format ({"type":"frame", params, blendshapes, head}) is
// also accepted — both map into the same internal frame.

import { clamp } from "../geometry/util";
import type { DriverParam } from "../model/params";

export interface TrackingInput {
  /** driver parameter deltas — merged over the defaults by the caller */
  params: Partial<Record<DriverParam, number>>;
  /** raw 52 ARKit blendshapes when available (debug channel) */
  blendshapes: Record<string, number> | null;
  present: boolean;
  sequence: number;
}

export interface AdapterOptions {
  blinkFloor: number; // default 0.32
  mouthGain: number; // default 1.6
}

/** Blink floor: MediaPipe bottoms out around 0.1–0.2 of openness on a full
 *  blink and never reports zero. Everything downstream reads the effective
 *  value, never the raw one. */
export function applyBlinkFloor(open: number, floor: number): number {
  return clamp((open - floor) / (1 - floor), 0, 1);
}

/** Parse one websocket text frame. Returns null for frames we do not
 *  understand (or pure absence pings with nothing new). */
export function parseFrame(text: string, opts: AdapterOptions): TrackingInput | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const msg = json as Record<string, unknown>;

  if (msg.type === "tracking.debug") {
    return {
      params: {},
      blendshapes: (msg.blendshapes as Record<string, number>) ?? null,
      present: true,
      sequence: Number(msg.sequence ?? 0),
    };
  }

  if (msg.type === "tracking.frame") {
    const face = msg.face as Record<string, unknown> | undefined;
    const sequence = Number(msg.sequence ?? 0);
    if (!face || face.present !== true) {
      return { params: {}, blendshapes: null, present: false, sequence };
    }
    const head = (face.head ?? {}) as Record<string, number>;
    const eyes = (face.eyes ?? {}) as Record<string, unknown>;
    const left = ((eyes.left ?? {}) as Record<string, number>) ?? {};
    const right = ((eyes.right ?? {}) as Record<string, number>) ?? {};
    const mouth = (face.mouth ?? {}) as Record<string, number>;
    const brows = (face.brows ?? {}) as Record<string, number>;
    const params: Partial<Record<DriverParam, number>> = {
      head_yaw: clamp(head.yaw ?? 0, -1, 1),
      head_pitch: clamp(head.pitch ?? 0, -1, 1),
      head_roll: clamp(head.roll ?? 0, -1, 1),
      head_x: clamp(head.x ?? 0, -1, 1),
      head_y: clamp(head.y ?? 0, -1, 1),
      eye_l_open: applyBlinkFloor(clamp(left.open ?? 1), opts.blinkFloor),
      eye_r_open: applyBlinkFloor(clamp(right.open ?? 1), opts.blinkFloor),
      gaze_x: clamp((eyes.gazeX as number) ?? 0, -1, 1),
      gaze_y: clamp((eyes.gazeY as number) ?? 0, -1, 1),
      // Mouth gain applied here, once, so every consumer stays in sync.
      mouth_open: clamp((mouth.open ?? 0) * opts.mouthGain),
      mouth_form: clamp(mouth.form ?? 0, -1, 1),
      mouth_smile: clamp(mouth.smile ?? 0),
      mouth_pucker: clamp(mouth.pucker ?? 0),
      mouth_x: clamp(mouth.x ?? 0, -1, 1),
      brow_l: clamp(brows.leftY ?? 0, -1, 1),
      brow_r: clamp(brows.rightY ?? 0, -1, 1),
    };
    return { params, blendshapes: null, present: true, sequence };
  }

  // The brief's draft format — accepted for forward compatibility.
  if (msg.type === "frame") {
    const raw = (msg.params ?? {}) as Record<string, number>;
    const params: Partial<Record<DriverParam, number>> = {};
    const map: [string, DriverParam][] = [
      ["head_yaw", "head_yaw"],
      ["head_pitch", "head_pitch"],
      ["head_roll", "head_roll"],
      ["eye_l_open", "eye_l_open"],
      ["eye_r_open", "eye_r_open"],
      ["mouth_open", "mouth_open"],
      ["mouth_form", "mouth_form"],
      ["mouth_smile", "mouth_smile"],
      ["mouth_pucker", "mouth_pucker"],
      ["mouth_x", "mouth_x"],
      ["brow_l", "brow_l"],
      ["brow_r", "brow_r"],
      ["gaze_x", "gaze_x"],
      ["gaze_y", "gaze_y"],
    ];
    for (const [from, to] of map) {
      if (typeof raw[from] === "number") params[to] = raw[from]!;
    }
    if (params.eye_l_open !== undefined) {
      params.eye_l_open = applyBlinkFloor(params.eye_l_open, opts.blinkFloor);
    }
    if (params.eye_r_open !== undefined) {
      params.eye_r_open = applyBlinkFloor(params.eye_r_open, opts.blinkFloor);
    }
    if (params.mouth_open !== undefined) {
      params.mouth_open = clamp(params.mouth_open * opts.mouthGain);
    }
    const head = (msg.head ?? {}) as Record<string, number>;
    if (typeof head.tx === "number") params.head_x = clamp(head.tx / 40, -1, 1);
    if (typeof head.ty === "number") params.head_y = clamp(-head.ty / 40, -1, 1);
    return {
      params,
      blendshapes: (msg.blendshapes as Record<string, number>) ?? null,
      present: msg.found !== false,
      sequence: Number(msg.frame_id ?? 0),
    };
  }

  return null;
}

/**
 * Per-frame param smoothing. Eye parameters get about a quarter of the
 * configured smoothing — a blink lasts ~120ms and heavy smoothing turns it
 * into a half-lidded stare.
 */
export class ParamSmoother {
  private current = new Map<string, number>();

  update(
    target: Partial<Record<DriverParam, number>>,
    smoothing: number,
  ): Partial<Record<DriverParam, number>> {
    const out: Partial<Record<DriverParam, number>> = {};
    for (const [key, value] of Object.entries(target)) {
      const isEye = key.startsWith("eye_") || key.startsWith("gaze_");
      const s = isEye ? smoothing * 0.25 : smoothing;
      const prev = this.current.get(key);
      const next = prev === undefined ? value : prev + (value - prev) * (1 - s);
      this.current.set(key, next);
      out[key as DriverParam] = next;
    }
    return out;
  }

  reset(): void {
    this.current.clear();
  }
}
