// Demo playback: sweeps every parameter at different frequencies, all out of
// phase, so the whole rig exercises within one cycle — the fastest way to
// spot a wrong binding.

import { clamp } from "../geometry/util";
import type { DriverParam } from "../model/params";

export function demoFrame(tSeconds: number): Partial<Record<DriverParam, number>> {
  const t = tSeconds;
  const s = (f: number, phase = 0) => Math.sin(t * f * Math.PI * 2 + phase);
  // Blink: mostly open with periodic closes.
  const blinkCycle = (t % 3.7) / 3.7;
  const blink = blinkCycle > 0.92 ? Math.sin(((blinkCycle - 0.92) / 0.08) * Math.PI) : 0;
  const open = clamp(1 - blink * 1.2);
  // Mouth: speech-like bursts.
  const talk = Math.max(0, s(0.9, 0.4)) * Math.max(0, s(3.1));
  return {
    head_yaw: s(0.11) * 0.75,
    head_pitch: s(0.13, 1.1) * 0.6,
    head_roll: s(0.07, 2.2) * 0.7,
    head_x: s(0.05, 0.6) * 0.5,
    head_y: s(0.09, 1.9) * 0.4,
    eye_l_open: open,
    eye_r_open: open,
    gaze_x: s(0.17, 0.3) * 0.8,
    gaze_y: s(0.23, 1.4) * 0.6,
    mouth_open: clamp(talk * 1.2),
    mouth_form: s(0.19, 2.8) * 0.7,
    mouth_smile: Math.max(0, s(0.15, 0.9)) * 0.8,
    mouth_pucker: Math.max(0, s(0.15, 0.9 + Math.PI)) * 0.7,
    mouth_x: s(0.29, 0.2) * 0.5,
    brow_l: s(0.21, 1.7) * 0.7,
    brow_r: s(0.21, 3.4) * 0.7,
  };
}
